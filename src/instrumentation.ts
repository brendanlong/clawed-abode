/**
 * Next.js instrumentation file - runs once when the server starts.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reconcileSessions } = await import('@/server/services/session-reconciler');

    console.log('Starting server - reconciling sessions...');

    // Reap session cgroup scopes orphaned by a previous crash (which never ran
    // teardown) before sessions revive into fresh scopes. Best-effort. Gated to
    // production only: the sweep glob has no per-instance discriminator, so a dev
    // instance (`pnpm dev`) must not run it or it would cgroup-kill the running
    // sessions of a concurrent production instance owned by the same user. (The
    // deployment host runs a single production instance.)
    if (process.env.NODE_ENV === 'production') {
      try {
        const { sweepSessionScopes } = await import('@/server/services/session-cgroup');
        await sweepSessionScopes();
      } catch (err) {
        console.error('Error sweeping orphaned session scopes:', err);
      }
    }

    try {
      const result = await reconcileSessions();
      if (result.runningSessionsToRevive > 0) {
        console.log(
          `Session reconciliation complete: ${result.runningSessionsToRevive} running session(s) will be revived on next interaction`
        );
      } else {
        console.log('Session reconciliation complete: no running sessions');
      }
    } catch (err) {
      console.error('Error reconciling sessions:', err);
    }

    // Register graceful shutdown handler
    registerShutdownHandler();
  }
}

/**
 * Register signal handlers for graceful shutdown.
 * Stops active Claude queries and disconnects Prisma so the process can exit cleanly.
 */
function registerShutdownHandler() {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`Received ${signal} again, forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    // Force exit after 10s if graceful shutdown hangs
    // (important for SIGTERM from systemd where there's no second signal)
    setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();

    try {
      // Stop all active Claude queries
      const { stopAllSessions } = await import('@/server/services/claude-runner');
      await stopAllSessions();
    } catch (err) {
      console.error('Error stopping sessions during shutdown:', err);
    }

    try {
      // Disconnect Prisma
      const { prisma } = await import('@/lib/prisma');
      await prisma.$disconnect();
    } catch (err) {
      console.error('Error disconnecting Prisma during shutdown:', err);
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
