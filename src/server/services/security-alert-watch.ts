/**
 * Security alert watches (doc/claude-sessions.md "Security Alert Watches"): a
 * session that called watch_security_alerts gets one message per poll listing
 * the Dependabot, code scanning and secret scanning alerts in its repos that
 * opened, reopened or closed since it was last told. The runner is reached only
 * through the {@link SecurityAlertWatchPort} handed to {@link initSecurityAlertWatch}.
 */

import { prisma } from '@/lib/prisma';
import { coalesce } from '@/lib/coalesce';
import { processSingleton } from '@/lib/process-singleton';
import { createLogger, toError } from '@/lib/logger';
import { pullRequestRepoKey } from '@/lib/pull-request';
import {
  currentAlerts,
  diffAlerts,
  formatAlertChanges,
  hasAlertChanges,
  parseStoredAlerts,
  SECURITY_ALERT_KINDS,
  type RepoAlertChanges,
  type SecurityAlert,
  type SecurityAlertKind,
} from '@/lib/security-alerts';
import { fetchOpenSecurityAlerts, fetchSecurityAlert } from './github';

const log = createLogger('security-alert-watch');

export interface SecurityAlertWatchPort {
  hasLiveQuery(sessionId: string): boolean;
  /** Send a message on the app's behalf, only to a session whose query is live. */
  deliverMessage(sessionId: string, text: string): Promise<boolean>;
}

/** Unchanged lists are free conditional requests; alerts are rarely urgent to the minute. */
const POLL_INTERVAL_MS = 5 * 60_000;

const state = processSingleton<{
  port: SecurityAlertWatchPort | null;
  timer: NodeJS.Timeout | null;
}>('security-alert-watch', () => ({ port: null, timer: null }));

export function initSecurityAlertWatch(port: SecurityAlertWatchPort): void {
  state.port = port;
  if (state.timer) return;
  state.timer = setInterval(() => void pollWatches(), POLL_INTERVAL_MS);
  state.timer.unref();
}

export interface RepoAlerts {
  repoFullName: string;
  checkedAt: Date;
  /** Only the kinds that could be read. */
  alerts: Partial<Record<SecurityAlertKind, SecurityAlert[]>>;
  failures: { kind: SecurityAlertKind; message: string }[];
}

/** A kind can fail because the feature is off for the repo or the token can't read it. */
async function readRepo(repoKey: string): Promise<RepoAlerts> {
  const checkedAt = new Date();
  const results = await Promise.all(
    SECURITY_ALERT_KINDS.map(async (kind) => {
      try {
        return { kind, alerts: await fetchOpenSecurityAlerts(repoKey, kind) };
      } catch (err) {
        return { kind, message: toError(err).message };
      }
    })
  );
  const read: RepoAlerts = { repoFullName: repoKey, checkedAt, alerts: {}, failures: [] };
  for (const result of results) {
    if ('alerts' in result) read.alerts[result.kind] = result.alerts;
    else read.failures.push({ kind: result.kind, message: result.message });
  }
  return read;
}

interface Watch {
  sessionId: string;
  repoFullName: string;
  openAlerts: string;
  checkedAt: Date;
}

/** The watch's changes, and the open alerts it will have been told about once they're delivered. */
async function changesFor(
  watch: Watch,
  read: RepoAlerts
): Promise<{ changes: RepoAlertChanges; openAlerts: SecurityAlert[] }> {
  const previous = parseStoredAlerts(watch.openAlerts);
  const current = currentAlerts(previous, read.alerts);
  const { opened, reopened, left } = diffAlerts(previous, current, watch.checkedAt);
  const closed: RepoAlertChanges['closed'] = [];
  const stillOpen: SecurityAlert[] = [];
  for (const alert of left) {
    try {
      const now = await fetchSecurityAlert(watch.repoFullName, alert.kind, alert.number);
      if (!now) {
        closed.push({
          alert,
          closure: { state: 'deleted', by: null, reason: null, comment: null },
        });
      } else if (now.closure) {
        closed.push({ alert: now.alert, closure: now.closure });
      } else {
        stillOpen.push(now.alert);
      }
    } catch (err) {
      // Reported once it can be read.
      log.warn('Failed to read a closed security alert', {
        repoFullName: watch.repoFullName,
        kind: alert.kind,
        number: alert.number,
        error: toError(err).message,
      });
      stillOpen.push(alert);
    }
  }
  return {
    changes: { repoFullName: watch.repoFullName, opened, reopened, closed },
    openAlerts: [...current, ...stillOpen],
  };
}

async function saveOpenAlerts(
  sessionId: string,
  repoFullName: string,
  openAlerts: SecurityAlert[],
  checkedAt: Date
): Promise<void> {
  // updateMany: the watch may have been removed meanwhile.
  await prisma.securityAlertWatch.updateMany({
    where: { sessionId, repoFullName },
    data: { openAlerts: JSON.stringify(openAlerts), checkedAt },
  });
}

/**
 * Deliver one session's changes across its repos. The stored open alerts move
 * forward only once the message is delivered, so a session whose query went
 * away hears about them when it's back.
 */
async function processSession(
  sessionId: string,
  watches: Watch[],
  reads: Map<string, RepoAlerts>,
  port: SecurityAlertWatchPort
): Promise<void> {
  const results = [];
  for (const watch of watches) {
    const read = reads.get(watch.repoFullName);
    if (!read || Object.keys(read.alerts).length === 0) continue;
    results.push({ watch, read, ...(await changesFor(watch, read)) });
  }
  const changed = results.filter((r) => hasAlertChanges(r.changes));
  if (changed.length > 0) {
    log.info('Delivering security alert changes', {
      sessionId,
      repos: changed.map((r) => r.watch.repoFullName),
    });
    const delivered = await port.deliverMessage(
      sessionId,
      formatAlertChanges(changed.map((r) => r.changes))
    );
    if (!delivered) return;
  }
  for (const { watch, read, openAlerts } of results) {
    await saveOpenAlerts(sessionId, watch.repoFullName, openAlerts, read.checkedAt);
  }
}

async function poll(): Promise<void> {
  const { port } = state;
  if (!port) return;
  const watches = (
    await prisma.securityAlertWatch.findMany({ where: { session: { status: 'running' } } })
  ).filter((watch) => port.hasLiveQuery(watch.sessionId));

  const reads = new Map<string, RepoAlerts>();
  for (const repoKey of new Set(watches.map((w) => w.repoFullName))) {
    const read = await readRepo(repoKey);
    // Debug: a kind that's off for the repo fails every poll, and the tool's reply already said so.
    for (const failure of read.failures) {
      log.debug('Failed to read watched security alerts', { repoFullName: repoKey, ...failure });
    }
    reads.set(repoKey, read);
  }

  const bySession = new Map<string, Watch[]>();
  for (const watch of watches) {
    bySession.set(watch.sessionId, [...(bySession.get(watch.sessionId) ?? []), watch]);
  }
  for (const [sessionId, sessionWatches] of bySession) {
    try {
      await processSession(sessionId, sessionWatches, reads, port);
    } catch (err) {
      log.warn('Failed to process security alert watches', {
        sessionId,
        error: toError(err).message,
      });
    }
  }
}

/** Serialized, so overlapping polls can't deliver the same change twice. */
const pollWatches = processSingleton('security-alert-watch.poll', () =>
  coalesce(async () => {
    try {
      await poll();
    } catch (err) {
      log.warn('Security alert watch poll failed', { error: toError(err).message });
    }
  })
);

/**
 * Replace the session's watched repos and return each one's open alerts. What
 * the reply shows becomes what the session has been told, so changes are
 * reported from there. A repo none of whose alerts can be read fails the call
 * instead of being watched silently.
 */
export async function setSecurityAlertWatches(
  sessionId: string,
  repoFullNames: string[]
): Promise<RepoAlerts[]> {
  const repoKeys = [...new Set(repoFullNames.map(pullRequestRepoKey))];
  const reads = await Promise.all(repoKeys.map(readRepo));
  for (const read of reads) {
    if (Object.keys(read.alerts).length === 0) {
      const reasons = read.failures.map((f) => `${f.kind}: ${f.message}`).join('; ');
      throw new Error(`Couldn't read any security alerts for ${read.repoFullName} (${reasons})`);
    }
  }

  await prisma.securityAlertWatch.deleteMany({
    where: { sessionId, repoFullName: { notIn: repoKeys } },
  });
  for (const read of reads) {
    const openAlerts = JSON.stringify(Object.values(read.alerts).flat());
    await prisma.$executeRaw`
      INSERT INTO "SecurityAlertWatch" ("sessionId", "repoFullName", "openAlerts", "checkedAt")
      VALUES (${sessionId}, ${read.repoFullName}, ${openAlerts}, ${read.checkedAt})
      ON CONFLICT("sessionId", "repoFullName")
      DO UPDATE SET "openAlerts" = excluded."openAlerts", "checkedAt" = excluded."checkedAt"`;
  }
  return reads;
}

export async function stopSecurityAlertWatches(sessionId: string): Promise<void> {
  await prisma.securityAlertWatch.deleteMany({ where: { sessionId } });
}

/** Test seam. */
export const _pollSecurityAlertWatches = pollWatches;

export function _resetSecurityAlertWatchState(): void {
  if (state.timer) clearInterval(state.timer);
  state.port = null;
  state.timer = null;
}
