import { Spinner } from '@/components/ui/spinner';
import { formatRetryReason, type RetryState } from '@/lib/claude-messages';

interface ClaudeStatusIndicatorProps {
  isRunning: boolean;
  containerStatus: string;
  /** Ephemeral API-retry status (rate limit / overload), or null if not retrying. */
  retry?: RetryState | null;
}

export function ClaudeStatusIndicator({
  isRunning,
  containerStatus,
  retry,
}: ClaudeStatusIndicatorProps) {
  // Don't show anything if the container isn't running
  if (containerStatus !== 'running') {
    return null;
  }

  // A retry only happens mid-request, so it implies Claude is still working.
  // Surface the live attempt count instead of the generic "working" message.
  if (isRunning && retry) {
    const reason = formatRetryReason(retry);
    return (
      <div className="flex items-center justify-center gap-2 py-3 px-4 bg-amber-500/10 border-t text-sm text-amber-700 dark:text-amber-400">
        <Spinner size="sm" />
        <span>
          Retrying{reason ? ` (${reason})` : ''} — attempt {retry.attempt}/{retry.maxRetries}…
        </span>
      </div>
    );
  }

  if (isRunning) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 px-4 bg-muted/50 border-t text-sm text-muted-foreground">
        <Spinner size="sm" />
        <span>Claude is working...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-2 py-3 px-4 bg-muted/30 border-t text-sm text-muted-foreground">
      <div className="w-2 h-2 rounded-full bg-green-500" />
      <span>Claude is waiting for your message</span>
    </div>
  );
}
