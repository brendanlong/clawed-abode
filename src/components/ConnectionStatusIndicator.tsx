import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/**
 * Status reported by tRPC's `useSubscription`. While the stream is live the value
 * is `pending`; `connecting` means it is reconnecting on its own, `error` that it
 * gave up.
 */
type StreamStatus = 'idle' | 'connecting' | 'pending' | 'error';

interface ConnectionStatusIndicatorProps {
  status: StreamStatus;
  /** Start a fresh connection; offered once the stream has given up. */
  onReconnect: () => void;
}

/**
 * Shows a small banner when the live SSE stream is not connected, so the user knows
 * updates are paused. A reconnect opens with a fresh snapshot, so nothing needs
 * refetching once it's back.
 */
export function ConnectionStatusIndicator({ status, onReconnect }: ConnectionStatusIndicatorProps) {
  if (status !== 'connecting' && status !== 'error') {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-2 py-2 px-4 bg-amber-500/10 border-t text-sm text-amber-700 dark:text-amber-400">
      {status === 'connecting' ? (
        <>
          <Spinner size="sm" />
          <span>Reconnecting to live updates…</span>
        </>
      ) : (
        <>
          <span>Live updates stopped.</span>
          <Button variant="outline" size="sm" onClick={onReconnect}>
            Reconnect
          </Button>
        </>
      )}
    </div>
  );
}
