import { Spinner } from '@/components/ui/spinner';

interface ClaudeStatusIndicatorProps {
  isRunning: boolean;
  containerStatus: string;
}

export function ClaudeStatusIndicator({ isRunning, containerStatus }: ClaudeStatusIndicatorProps) {
  // Don't show anything if the container isn't running
  if (containerStatus !== 'running') {
    return null;
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
