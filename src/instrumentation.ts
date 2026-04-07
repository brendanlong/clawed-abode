/**
 * Next.js instrumentation file - runs once when the server starts.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reconcileSessions } = await import('@/server/services/session-reconciler');

    console.log('Starting server - reconciling sessions...');

    try {
      const result = await reconcileSessions();
      if (result.sessionsMarkedStopped > 0) {
        console.log(
          `Reconciled sessions: ${result.sessionsMarkedStopped} marked stopped (server restart)`
        );
      } else {
        console.log('Session reconciliation complete: no running sessions to stop');
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
