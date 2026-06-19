import { Spinner } from '@/components/ui/spinner';

/**
 * Status reported by tRPC's `useSubscription`. While the stream is live the value
 * is `pending`; `connecting`/`error` indicate the live feed is (temporarily) down.
 */
export type StreamStatus = 'idle' | 'connecting' | 'pending' | 'error';

interface ConnectionStatusIndicatorProps {
  status: StreamStatus;
}

/**
 * Shows a small banner when the live SSE stream is not connected, so the user knows
 * updates are paused. The stream auto-reconnects and catches up via lastEventId; the
 * queries also refetch on reconnect, so this is informational only.
 */
export function ConnectionStatusIndicator({ status }: ConnectionStatusIndicatorProps) {
  if (status !== 'connecting' && status !== 'error') {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-2 py-2 px-4 bg-amber-500/10 border-t text-sm text-amber-700 dark:text-amber-400">
      <Spinner size="sm" />
      <span>Reconnecting to live updates…</span>
    </div>
  );
}
