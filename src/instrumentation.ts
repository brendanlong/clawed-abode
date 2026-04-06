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
  }
}
