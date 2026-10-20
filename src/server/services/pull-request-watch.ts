/**
 * PR watches (doc/claude-sessions.md "Pull Request Watches"): a session that
 * called watch_pull_requests gets a message when a PR in a watched repo becomes
 * ready, or is merged or closed. Repos are polled into the same PullRequest rows
 * the session badges read. The runner is reached only through the
 * {@link PullRequestWatchPort} handed to {@link initPullRequestWatch}.
 */

import { randomUUID } from 'crypto';
import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { coalesce } from '@/lib/coalesce';
import { processSingleton } from '@/lib/process-singleton';
import { createLogger, toError } from '@/lib/logger';
import { parsePullRequestJson, pullRequestRepoKey, type PullRequestInfo } from '@/lib/pull-request';
import {
  formatWatchMessage,
  SEEN_KEY,
  watchEventKey,
  type WatchedPullRequest,
} from '@/lib/pull-request-watch';
import { fetchOpenPullRequests, fetchPullRequest } from './github';
import { savePullRequest } from './pull-request-store';

const log = createLogger('pull-request-watch');

export interface PullRequestWatchPort {
  hasLiveQuery(sessionId: string): boolean;
  /** Send a message on the app's behalf, only to a session whose query is live. */
  deliverMessage(sessionId: string, text: string): Promise<boolean>;
}

/** Unchanged lookups are free conditional requests, so this only bounds latency. */
const POLL_INTERVAL_MS = 60_000;
/** Keeps one repo's sync from opening a burst GitHub would answer with a secondary rate limit. */
const MAX_CONCURRENT_LOOKUPS = 4;

const state = processSingleton<{ port: PullRequestWatchPort | null; timer: NodeJS.Timeout | null }>(
  'pull-request-watch',
  () => ({ port: null, timer: null })
);

export function initPullRequestWatch(port: PullRequestWatchPort): void {
  state.port = port;
  if (state.timer) return;
  state.timer = setInterval(() => void pollWatches(), POLL_INTERVAL_MS);
  state.timer.unref();
}

interface StoredPullRequest {
  id: string;
  repoFullName: string;
  info: PullRequestInfo;
}

const isOpen = Prisma.sql`json_extract("info", '$.state') = 'open'`;

/** Rows are filtered in SQL so a poll's work doesn't grow with the repo's history. */
async function loadPullRequests(where: Prisma.Sql): Promise<StoredPullRequest[]> {
  const rows = await prisma.$queryRaw<{ id: string; repoFullName: string; info: string }[]>`
    SELECT "id", "repoFullName", "info" FROM "PullRequest"
    WHERE ${where}
    ORDER BY "repoFullName", "number" DESC`;
  return rows.flatMap((row) => {
    const info = parsePullRequestJson(row.info);
    return info ? [{ ...row, info }] : [];
  });
}

async function forEachConcurrently(jobs: (() => Promise<void>)[]): Promise<void> {
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await job();
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_LOOKUPS, queue.length) }, worker));
}

/**
 * Refresh every open PR in the repo, plus the ones last stored as open that no
 * longer are (to learn whether they merged or closed). Throws if the open list
 * can't be read; a single PR that fails is skipped until the next poll. Every
 * row refreshed has a `fetchedAt` at or after the returned time.
 */
async function syncRepo(repoKey: string): Promise<Date> {
  const startedAt = new Date();
  const open = await fetchOpenPullRequests(repoKey);
  const openNumbers = new Set(open.map((pr) => pr.number));
  const left = (
    await loadPullRequests(Prisma.sql`"repoFullName" = ${repoKey} AND ${isOpen}`)
  ).filter((pr) => !openNumbers.has(pr.info.number));

  const save = (number: number, lookup: () => Promise<void>) => async () => {
    try {
      await lookup();
    } catch (err) {
      log.warn('Failed to refresh a watched PR', {
        repoFullName: repoKey,
        number,
        error: toError(err).message,
      });
    }
  };
  await forEachConcurrently([
    ...open.map((pr) =>
      save(pr.number, async () => void (await savePullRequest(repoKey, pr, startedAt)))
    ),
    ...left.map((pr) =>
      save(pr.info.number, async () => {
        const fetched = await fetchPullRequest(repoKey, pr.info.number);
        await savePullRequest(repoKey, fetched, startedAt);
      })
    ),
  ]);
  return startedAt;
}

interface WatchKey {
  pullRequestId: string;
  key: string;
}

/** Record states as seen by the watch; returns the ones that weren't recorded before. */
async function recordKeys(watchId: string, keys: WatchKey[]): Promise<WatchKey[]> {
  if (keys.length === 0) return [];
  const values = keys.map((k) => Prisma.sql`(${watchId}, ${k.pullRequestId}, ${k.key})`);
  return prisma.$queryRaw<WatchKey[]>`
    INSERT INTO "PullRequestWatchEvent" ("watchId", "pullRequestId", "key")
    VALUES ${Prisma.join(values)}
    ON CONFLICT DO NOTHING
    RETURNING "pullRequestId", "key"`;
}

async function forgetKeys(watchId: string, keys: WatchKey[]): Promise<void> {
  await prisma.pullRequestWatchEvent.deleteMany({
    where: { watchId, OR: keys.map((k) => ({ pullRequestId: k.pullRequestId, key: k.key })) },
  });
}

function eventKeys(prs: StoredPullRequest[]): WatchKey[] {
  return prs.flatMap((pr) => {
    const key = watchEventKey(pr.info);
    return key ? [{ pullRequestId: pr.id, key }] : [];
  });
}

async function withAuthorSessions(prs: StoredPullRequest[]): Promise<WatchedPullRequest[]> {
  const sessions = await prisma.session.findMany({
    where: { pullRequestId: { in: prs.map((pr) => pr.id) } },
    select: { id: true, name: true, status: true, agentName: true, pullRequestId: true },
    orderBy: { lastActivityAt: 'desc' },
  });
  return prs.map((pr) => ({
    repoFullName: pr.repoFullName,
    info: pr.info,
    sessions: sessions
      .filter((s) => s.pullRequestId === pr.id)
      .map(({ pullRequestId: _pullRequestId, ...s }) => s),
  }));
}

/**
 * Deliver the states of the repo's PRs this watch hasn't reported yet. A PR's
 * merge or close is only reported once the watch has seen it open, so old PRs
 * a badge lookup happens to store don't show up as news. A new watch's first
 * pass only records what is already there: the tool's reply listed it. Only PRs
 * refreshed since `syncedAt` are considered; nothing else can have changed.
 */
async function processWatch(
  watch: { id: string; sessionId: string; repoFullName: string; baselinedAt: Date | null },
  syncedAt: Date,
  port: PullRequestWatchPort
): Promise<void> {
  const prs = await loadPullRequests(
    Prisma.sql`"repoFullName" = ${watch.repoFullName} AND "fetchedAt" >= ${syncedAt}`
  );
  const open = prs.filter((pr) => pr.info.state === 'open');
  const seenOpen = open.map((pr) => ({ pullRequestId: pr.id, key: SEEN_KEY }));

  if (!watch.baselinedAt) {
    await recordKeys(watch.id, [...seenOpen, ...eventKeys(open)]);
    await prisma.pullRequestWatch.update({
      where: { id: watch.id },
      data: { baselinedAt: new Date() },
    });
    return;
  }

  await recordKeys(watch.id, seenOpen);
  const seen = await prisma.pullRequestWatchEvent.findMany({
    where: { watchId: watch.id, key: SEEN_KEY, pullRequestId: { in: prs.map((pr) => pr.id) } },
    select: { pullRequestId: true },
  });
  const seenIds = new Set(seen.map((row) => row.pullRequestId));
  // Recorded before delivery so overlapping work can't send them twice, and
  // forgotten again if they couldn't be sent, so they go out once the session is back.
  const fresh = await recordKeys(watch.id, eventKeys(prs.filter((pr) => seenIds.has(pr.id))));
  if (fresh.length === 0) return;

  const freshIds = new Set(fresh.map((k) => k.pullRequestId));
  const message = formatWatchMessage(
    await withAuthorSessions(prs.filter((pr) => freshIds.has(pr.id)))
  );
  log.info('Delivering PR watch update', {
    sessionId: watch.sessionId,
    repoFullName: watch.repoFullName,
    count: fresh.length,
  });
  let delivered = false;
  try {
    delivered = await port.deliverMessage(watch.sessionId, message);
  } finally {
    if (!delivered) await forgetKeys(watch.id, fresh);
  }
}

async function poll(): Promise<void> {
  const { port } = state;
  if (!port) return;
  // Only sessions that can hear about it: anything else waits in the repo until they can.
  const watches = (
    await prisma.pullRequestWatch.findMany({
      where: { session: { status: 'running' } },
      select: { id: true, sessionId: true, repoFullName: true, baselinedAt: true },
    })
  ).filter((watch) => port.hasLiveQuery(watch.sessionId));

  const syncedAt = new Map<string, Date>();
  for (const repoKey of new Set(watches.map((watch) => watch.repoFullName))) {
    try {
      syncedAt.set(repoKey, await syncRepo(repoKey));
    } catch (err) {
      log.warn('Failed to sync a watched repo', {
        repoFullName: repoKey,
        error: toError(err).message,
      });
    }
  }

  for (const watch of watches) {
    const repoSyncedAt = syncedAt.get(watch.repoFullName);
    if (!repoSyncedAt) continue;
    try {
      await processWatch(watch, repoSyncedAt, port);
    } catch (err) {
      log.warn('Failed to process a PR watch', {
        sessionId: watch.sessionId,
        repoFullName: watch.repoFullName,
        error: toError(err).message,
      });
    }
  }
}

/** Serialized: a poll and a watch_pull_requests call must not baseline or deliver twice. */
const pollWatches = processSingleton('pull-request-watch.poll', () =>
  coalesce(async () => {
    try {
      await poll();
    } catch (err) {
      log.warn('PR watch poll failed', { error: toError(err).message });
    }
  })
);

/**
 * Replace the session's watched repos and return their open PRs. A newly added
 * repo is read first, so one the token can't see fails the call instead of
 * being watched silently.
 */
export async function setPullRequestWatches(
  sessionId: string,
  repoFullNames: string[]
): Promise<WatchedPullRequest[]> {
  const repoKeys = [...new Set(repoFullNames.map(pullRequestRepoKey))];
  const existing = await prisma.pullRequestWatch.findMany({
    where: { sessionId },
    select: { repoFullName: true },
  });
  const added = repoKeys.filter((key) => !existing.some((w) => w.repoFullName === key));
  for (const repoKey of added) await syncRepo(repoKey);

  await prisma.pullRequestWatch.deleteMany({
    where: { sessionId, repoFullName: { notIn: repoKeys } },
  });
  if (added.length > 0) {
    const values = added.map(
      (repoKey) => Prisma.sql`(${randomUUID()}, ${sessionId}, ${repoKey}, ${new Date()})`
    );
    await prisma.$executeRaw`
      INSERT INTO "PullRequestWatch" ("id", "sessionId", "repoFullName", "createdAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT("sessionId", "repoFullName") DO NOTHING`;
    await pollWatches();
  }

  if (repoKeys.length === 0) return [];
  const open = await loadPullRequests(
    Prisma.sql`"repoFullName" IN (${Prisma.join(repoKeys)}) AND ${isOpen}`
  );
  return withAuthorSessions(open);
}

/** Test seam. */
export const _pollPullRequestWatches = pollWatches;

export function _resetPullRequestWatchState(): void {
  if (state.timer) clearInterval(state.timer);
  state.port = null;
  state.timer = null;
}
