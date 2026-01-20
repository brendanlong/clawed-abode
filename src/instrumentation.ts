/**
 * Next.js instrumentation file - runs once when the server starts.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reconcileOrphanedProcesses } = await import('@/server/services/claude-runner');

    console.log('Starting server - reconciling orphaned Claude processes...');

    try {
      const result = await reconcileOrphanedProcesses();
      if (result.total > 0) {
        console.log(
          `Reconciled ${result.total} orphaned processes: ` +
            `${result.reconnected} reconnected, ${result.cleaned} cleaned up`
        );
      } else {
        console.log('No orphaned processes to reconcile');
      }
    } catch (err) {
      console.error('Error reconciling orphaned processes:', err);
    }
  }
}
