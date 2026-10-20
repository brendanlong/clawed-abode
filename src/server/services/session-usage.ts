import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import {
  EMPTY_SESSION_USAGE_TOTALS,
  extractModelFromInit,
  extractResultUsage,
  extractTopLevelAssistantUsage,
  type SessionUsageTotals,
} from '@/lib/token-estimation';

/**
 * The statement that folds one message into the session's running usage totals
 * and returns the updated row (parse it with {@link parseSessionUsageRow}), or
 * null if the message doesn't affect them; run it in the same batch as the
 * message insert so the totals never drift from the transcript. Each fold is a
 * single upsert whose `SET` reads the row's previous values, so concurrent
 * inserts can't lose an update. The cost segmentation (see token-estimation.ts)
 * happens here: a cumulative cost below the current one closes the current
 * segment. A top-level assistant message replaces `lastCall*`; the runner
 * persists its query's messages one at a time, so the last write is the latest
 * message. One without usage isn't folded, so the previous call's values stand. The migrations that added these columns backfill the same fold in SQL.
 */
export function messageUsageStatement(
  sessionId: string,
  type: string,
  content: unknown
): Prisma.PrismaPromise<unknown[]> | null {
  if (type === 'system') {
    const model = extractModelFromInit(content);
    if (model === undefined) return null;
    return prisma.$queryRaw<unknown[]>`
      INSERT INTO "SessionUsage" ("sessionId", "model") VALUES (${sessionId}, ${model})
      ON CONFLICT ("sessionId") DO UPDATE SET "model" = COALESCE("model", excluded."model")
      RETURNING *
    `;
  }

  if (type === 'assistant') {
    const call = extractTopLevelAssistantUsage(content);
    if (!call) return null;
    return prisma.$queryRaw<unknown[]>`
      INSERT INTO "SessionUsage" (
        "sessionId", "lastCallInputTokens", "lastCallOutputTokens", "lastCallCacheReadTokens",
        "lastCallCacheCreationTokens", "lastCallModel"
      ) VALUES (
        ${sessionId}, ${call.inputTokens}, ${call.outputTokens}, ${call.cacheReadTokens},
        ${call.cacheCreationTokens}, ${call.model ?? null}
      )
      ON CONFLICT ("sessionId") DO UPDATE SET
        "lastCallInputTokens" = excluded."lastCallInputTokens",
        "lastCallOutputTokens" = excluded."lastCallOutputTokens",
        "lastCallCacheReadTokens" = excluded."lastCallCacheReadTokens",
        "lastCallCacheCreationTokens" = excluded."lastCallCacheCreationTokens",
        "lastCallModel" = excluded."lastCallModel"
      RETURNING *
    `;
  }

  if (type !== 'result') return null;
  const result = extractResultUsage(content);
  if (!result) return null;
  const usage = result.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const cost = result.totalCostUsd;
  return prisma.$queryRaw<unknown[]>`
    INSERT INTO "SessionUsage" (
      "sessionId", "resultCount", "inputTokens", "outputTokens", "cacheReadTokens",
      "cacheCreationTokens", "currentSegmentCostUsd", "contextWindows"
    ) VALUES (
      ${sessionId}, 1, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadTokens},
      ${usage.cacheCreationTokens}, ${cost ?? 0}, ${JSON.stringify(result.contextWindowByModel)}
    )
    ON CONFLICT ("sessionId") DO UPDATE SET
      "resultCount" = "resultCount" + 1,
      "inputTokens" = "inputTokens" + excluded."inputTokens",
      "outputTokens" = "outputTokens" + excluded."outputTokens",
      "cacheReadTokens" = "cacheReadTokens" + excluded."cacheReadTokens",
      "cacheCreationTokens" = "cacheCreationTokens" + excluded."cacheCreationTokens",
      "closedSegmentsCostUsd" = CASE WHEN ${cost} < "currentSegmentCostUsd"
        THEN "closedSegmentsCostUsd" + "currentSegmentCostUsd"
        ELSE "closedSegmentsCostUsd" END,
      "currentSegmentCostUsd" = COALESCE(${cost}, "currentSegmentCostUsd"),
      "contextWindows" = json_patch("contextWindows", excluded."contextWindows")
    RETURNING *
  `;
}

// Token counts are BIGINT: a bigint from Prisma's typed reads, a number or a
// bigint from a raw `RETURNING`.
const tokenCount = z.union([z.number(), z.bigint()]).transform(Number);

const SessionUsageRowSchema = z.object({
  resultCount: tokenCount,
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  closedSegmentsCostUsd: z.number(),
  currentSegmentCostUsd: z.number(),
  contextWindows: z
    .string()
    .transform((json) => z.record(z.string(), z.number()).parse(JSON.parse(json))),
  model: z.string().nullable(),
  lastCallInputTokens: tokenCount,
  lastCallOutputTokens: tokenCount,
  lastCallCacheReadTokens: tokenCount,
  lastCallCacheCreationTokens: tokenCount,
  lastCallModel: z.string().nullable(),
});

/** A `SessionUsage` row, from a typed read or a fold's `RETURNING`, as totals. */
export function parseSessionUsageRow(row: unknown): SessionUsageTotals {
  const r = SessionUsageRowSchema.parse(row);
  return {
    resultCount: r.resultCount,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    closedSegmentsCostUsd: r.closedSegmentsCostUsd,
    currentSegmentCostUsd: r.currentSegmentCostUsd,
    contextWindowByModel: r.contextWindows,
    model: r.model ?? undefined,
    lastCall: {
      inputTokens: r.lastCallInputTokens,
      outputTokens: r.lastCallOutputTokens,
      cacheReadTokens: r.lastCallCacheReadTokens,
      cacheCreationTokens: r.lastCallCacheCreationTokens,
      model: r.lastCallModel ?? undefined,
    },
  };
}

export async function getSessionUsageTotals(sessionId: string): Promise<SessionUsageTotals> {
  const row = await prisma.sessionUsage.findUnique({ where: { sessionId } });
  return row ? parseSessionUsageRow(row) : EMPTY_SESSION_USAGE_TOTALS;
}
