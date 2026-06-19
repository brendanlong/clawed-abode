import { Spinner } from '@/components/ui/spinner';
import type { ApiRetryStatus } from '@/lib/claude-messages';

interface ClaudeStatusIndicatorProps {
  isRunning: boolean;
  containerStatus: string;
  /** Ephemeral rate-limit retry status, shown while the API call is being retried */
  retryStatus?: ApiRetryStatus | null;
}

export function ClaudeStatusIndicator({
  isRunning,
  containerStatus,
  retryStatus,
}: ClaudeStatusIndicatorProps) {
  // Don't show anything if the container isn't running
  if (containerStatus !== 'running') {
    return null;
  }

  if (isRunning) {
    if (retryStatus) {
      return (
        <div className="flex items-center justify-center gap-2 py-3 px-4 bg-amber-500/10 border-t text-sm text-amber-700 dark:text-amber-400">
          <Spinner size="sm" />
          <span>
            Rate limited — retrying ({retryStatus.attempt}/{retryStatus.maxRetries})
          </span>
        </div>
      );
    }
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
