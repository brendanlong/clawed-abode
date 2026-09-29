/**
 * Node-runtime half of instrumentation: startup reaping and graceful shutdown.
 * Kept out of instrumentation.ts because Next compiles that file for the Edge
 * runtime too, and Turbopack warns about every Node-only module it can trace
 * from there — even inside the NEXT_RUNTIME guard.
 */

import { env, getEnv } from '@/lib/env';
import { createLogger, toError } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { purgeInactiveAuthSessions } from '@/server/services/auth-sessions';
import { startPublicFilesServer } from '@/server/services/public-files-server';
import {
  initRateLimitPause,
  reapOrphanedSessionScopes,
  stopAllSessions,
} from '@/server/services/claude-runner';

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

  // Before anything can revive: reap scopes a crash left behind (see
  // reapOrphanedSessionScopes), and restore the rate-limit pause so a restart
  // mid-pause doesn't release queued prompts into a still-exhausted window.
  // Both are best-effort and log their own failures.
  await reapOrphanedSessionScopes();
  await initRateLimitPause();

  // Fatal like a bad env: the system prompt would otherwise hand out dead links.
  if (env.PUBLIC_FILES_PORT !== undefined) {
    try {
      await startPublicFilesServer(env.PUBLIC_FILES_PORT);
    } catch (err) {
      log.error('Refusing to start: the public files server could not listen', toError(err));
      process.exit(1);
    }
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
