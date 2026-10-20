/**
 * The one writer of PR state. `PullRequest` rows hold what GitHub last said about
 * each PR; `Session.pullRequest` is a verbatim copy of the linked row's `info`,
 * made in SQL from the row itself, so a session badge and a PR watch can never
 * disagree about the same PR.
 */

import { randomUUID } from 'crypto';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import {
  parsePullRequestJson,
  pullRequestRepoKey,
  reusableChecks,
  settleChecks,
  type GitHubPullRequest,
  type PullRequestInfo,
} from '@/lib/pull-request';
import { sseEvents } from './events';
import { fetchChecks } from './github';

/**
 * Store a PR (and its head commit's checks) from a lookup that started at
 * `startedAt`, and copy it to the sessions linked to it. Throws if the checks
 * can't be fetched for a transient reason, leaving the stored row as it was. A lookup that started
 * before the one already stored loses: lookups overlap, and a slow pre-merge
 * answer must not overwrite a post-merge one. Returns the row's id either way.
 */
export async function savePullRequest(
  repoFullName: string,
  fetched: GitHubPullRequest,
  startedAt: Date
): Promise<string> {
  const repoKey = pullRequestRepoKey(repoFullName);
  const key = { repoFullName_number: { repoFullName: repoKey, number: fetched.number } };
  const stored = await prisma.pullRequest.findUnique({ where: key, select: { info: true } });
  const reused = reusableChecks(fetched, parsePullRequestJson(stored?.info ?? null));
  const checks =
    reused !== undefined
      ? reused
      : settleChecks(await fetchChecks(repoKey, fetched.headSha), fetched.updatedAt, Date.now());
  const info: PullRequestInfo = { ...fetched, checks };
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "PullRequest" ("id", "repoFullName", "number", "info", "fetchedAt")
    VALUES (${randomUUID()}, ${repoKey}, ${fetched.number}, ${JSON.stringify(info)}, ${startedAt})
    ON CONFLICT("repoFullName", "number") DO UPDATE SET
      "info" = excluded."info",
      "fetchedAt" = excluded."fetchedAt"
    WHERE excluded."fetchedAt" > "PullRequest"."fetchedAt"
    RETURNING "id"`;
  if (row) {
    await copyToSessions(Prisma.sql`"pullRequestId" = ${row.id}`);
    return row.id;
  }
  const newer = await prisma.pullRequest.findUniqueOrThrow({ where: key, select: { id: true } });
  return newer.id;
}

/**
 * Bring the sessions matching `where` up to date with their linked row (or null
 * when unlinked) and announce each one that changed. Archived sessions are
 * read-only history. Returns the ids announced.
 */
async function copyToSessions(where: Prisma.Sql): Promise<string[]> {
  const linkedInfo = Prisma.sql`(SELECT "info" FROM "PullRequest" WHERE "id" = "Session"."pullRequestId")`;
  const changed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Session" SET "pullRequest" = ${linkedInfo}
    WHERE ${where} AND "status" != 'archived' AND "pullRequest" IS NOT ${linkedInfo}
    RETURNING "id"`;
  if (changed.length === 0) return [];
  const rows = await prisma.session.findMany({ where: { id: { in: changed.map((r) => r.id) } } });
  for (const row of rows) sseEvents.emitSessionUpdate(row.id, row);
  return rows.map((row) => row.id);
}

/** Copy a session's newly linked (or unlinked) PR onto it; true when that announced the session. */
export async function copyLinkedPullRequest(sessionId: string): Promise<boolean> {
  return (await copyToSessions(Prisma.sql`"id" = ${sessionId}`)).length > 0;
}
