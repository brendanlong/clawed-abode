import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  EMPTY_SESSION_USAGE_TOTALS,
  extractModelFromInit,
  extractResultUsage,
  type SessionUsageTotals,
} from '@/lib/token-estimation';

/**
 * Fold one inserted message into the session's running usage totals. Each fold
 * is a single upsert whose `SET` reads the row's previous values, so concurrent
 * inserts can't lose an update. The cost segmentation (see token-estimation.ts)
 * happens here: a cumulative cost below the current one closes the current
 * segment. The migration that created `SessionUsage` backfills the same fold in SQL.
 */
export async function recordMessageUsage(
  sessionId: string,
  type: string,
  content: unknown
): Promise<void> {
  if (type === 'system') {
    const model = extractModelFromInit(content);
    if (model === undefined) return;
    await prisma.$executeRaw`
      INSERT INTO "SessionUsage" ("sessionId", "model") VALUES (${sessionId}, ${model})
      ON CONFLICT ("sessionId") DO UPDATE SET "model" = COALESCE("model", excluded."model")
    `;
    return;
  }
  if (type !== 'result') return;

  const result = extractResultUsage(content);
  if (!result) return;
  const usage = result.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const cost = result.totalCostUsd;
  await prisma.$executeRaw`
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
  `;
}

const ContextWindowsSchema = z.record(z.string(), z.number());

export async function getSessionUsageTotals(sessionId: string): Promise<SessionUsageTotals> {
  const row = await prisma.sessionUsage.findUnique({ where: { sessionId } });
  if (!row) return EMPTY_SESSION_USAGE_TOTALS;
  return {
    resultCount: row.resultCount,
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheCreationTokens: Number(row.cacheCreationTokens),
    closedSegmentsCostUsd: row.closedSegmentsCostUsd,
    currentSegmentCostUsd: row.currentSegmentCostUsd,
    contextWindowByModel: ContextWindowsSchema.parse(JSON.parse(row.contextWindows)),
    model: row.model ?? undefined,
  };
}
