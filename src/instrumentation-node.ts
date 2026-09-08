/**
 * Node-runtime half of instrumentation: startup reaping and graceful shutdown.
 * Kept out of instrumentation.ts because Next compiles that file for the Edge
 * runtime too, and Turbopack warns about every Node-only module it can trace
 * from there — even inside the NEXT_RUNTIME guard.
 */

import { getEnv } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { purgeInactiveAuthSessions } from '@/server/services/auth-sessions';
import { reapOrphanedSessionScopes, stopAllSessions } from '@/server/services/claude-runner';

const log = createLogger('startup');

let registered = false;

export async function registerNode() {
  // Idempotent: a second call would attach a second pair of signal handlers.
  if (registered) return;
  registered = true;

  // Fail at boot on a bad env rather than on the first request that reads it.
  try {
    getEnv();
  } catch (err) {
    log.error('Refusing to start', toError(err));
    process.exit(1);
  }
  log.info('Starting server');

  try {
    await purgeInactiveAuthSessions();
  } catch (err) {
    log.error('Error purging inactive auth sessions', toError(err));
  }

  // Reap session cgroup scopes orphaned by a previous crash (which never ran
  // teardown) before sessions revive into fresh scopes. Best-effort. Reaps
  // EXACTLY the scope names recorded on this instance's own session rows (no
  // glob), so — unlike the old broad sweep — it can only touch scopes named in
  // this instance's DB. That's why it no longer needs the production gate: a
  // `pnpm dev` instance with its OWN DATABASE_URL has its own session ids and
  // scope names, so it can never reach a co-tenant production instance's
  // sessions (the old glob could, regardless of DB — the mass-kill bug).
  // Caveat: this safety rests on instances not SHARING a DATABASE_URL. Two live
  // instances on one DB would have this reap stop the other's live scopes by
  // exact name — but a shared DB already breaks the app's single-instance model
  // (in-memory-vs-DB session state, message-sequence counters), so "don't share
  // a DB across concurrent instances" is a pre-existing invariant, not a new one.
  try {
    await reapOrphanedSessionScopes();
  } catch (err) {
    log.error('Error reaping orphaned session scopes', toError(err));
  }

  // Sessions left `running` by a previous process are revived lazily with
  // `resume` on their next interaction, so startup only reports how many there are.
  try {
    const runningSessionsToRevive = await prisma.session.count({ where: { status: 'running' } });
    log.info('Startup complete', { runningSessionsToRevive });
  } catch (err) {
    log.error('Error counting running sessions', toError(err));
  }

  registerShutdownHandler();
}

/**
 * Register signal handlers for graceful shutdown.
 * Stops active Claude queries and disconnects Prisma so the process can exit cleanly.
 */
function registerShutdownHandler() {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.warn('Received signal again, forcing exit', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    log.info('Shutting down gracefully', { signal });

    // Force exit after 10s if graceful shutdown hangs
    // (important for SIGTERM from systemd where there's no second signal)
    setTimeout(() => {
      log.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();

    try {
      await stopAllSessions();
    } catch (err) {
      log.error('Error stopping sessions during shutdown', toError(err));
    }

    try {
      await prisma.$disconnect();
    } catch (err) {
      log.error('Error disconnecting Prisma during shutdown', toError(err));
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
