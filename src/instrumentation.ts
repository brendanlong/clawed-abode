/**
 * Next.js instrumentation file - runs once when the server starts.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not during build or in edge runtime)
  // Use process.env directly here to avoid importing env module at top level
  // which would cause Next.js to analyze server-side dependencies for Edge Runtime
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { reconcileOrphanedProcesses } = await import('@/server/services/claude-runner');
    const { reconcileSessionsWithPodman, startBackgroundReconciliation, migrateToSockets } =
      await import('@/server/services/session-reconciler');

    // One-time migration: stop all running sessions for socket migration
    console.log('Running socket migration...');
    try {
      await migrateToSockets();
    } catch (err) {
      console.error('Error running socket migration:', err);
    }

    console.log('Starting server - reconciling sessions with Podman...');

    // Reconcile session states with actual Podman containers
    try {
      const sessionResult = await reconcileSessionsWithPodman();
      if (sessionResult.sessionsUpdated > 0 || sessionResult.orphanedContainersCleaned > 0) {
        console.log(
          `Reconciled sessions: ${sessionResult.sessionsChecked} checked, ` +
            `${sessionResult.sessionsUpdated} updated, ` +
            `${sessionResult.sessionsMarkedStopped} marked stopped, ` +
            `${sessionResult.sessionsMarkedRunning} marked running, ` +
            `${sessionResult.orphanedContainersCleaned} orphaned containers cleaned`
        );
      } else {
        console.log(
          `Session reconciliation complete: ${sessionResult.sessionsChecked} sessions checked, all in sync`
        );
      }
    } catch (err) {
      console.error('Error reconciling sessions:', err);
    }

    // Reconcile orphaned Claude processes
    console.log('Reconciling orphaned Claude processes...');
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

    // Start background polling for container state changes
    startBackgroundReconciliation();
  }
}
