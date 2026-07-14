import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { formatRetryReason, type RetryState } from '@/lib/claude-messages';
import { taskHasEndState, type BackgroundTask } from '@/lib/session-status';

interface ClaudeStatusIndicatorProps {
  /** A main-agent turn is active (gates the composer). */
  isRunning: boolean;
  containerStatus: string;
  /** Ephemeral API-retry status (rate limit / overload), or null if not retrying. */
  retry?: RetryState | null;
  /** Running background tasks (indicator only; never gates input). */
  backgroundTasks?: BackgroundTask[];
  /** Stop a single background task. */
  onStopBackgroundTask?: (taskId: string) => void;
}

/** The turn-status line: retrying / working / background / waiting. */
function TurnStatus({
  isRunning,
  backgroundActive,
  retry,
}: {
  isRunning: boolean;
  backgroundActive: boolean;
  retry?: RetryState | null;
}) {
  // A retry only happens mid-request, so it implies Claude is still working.
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

  // The main agent is idle, but a background task/subagent is still running — don't
  // claim Claude is "waiting for your message" when work is still in flight.
  if (backgroundActive) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 px-4 bg-muted/50 border-t text-sm text-muted-foreground">
        <div className="w-2 h-2 rounded-full bg-blue-500" />
        <span>Main agent idle — a background task is still running</span>
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

export function ClaudeStatusIndicator({
  isRunning,
  containerStatus,
  retry,
  backgroundTasks,
  onStopBackgroundTask,
}: ClaudeStatusIndicatorProps) {
  // Don't show anything if the container isn't running.
  if (containerStatus !== 'running') {
    return null;
  }

  const tasks = backgroundTasks ?? [];
  // The list below shows ALL running tasks (so a daemon stays ✕-stoppable), but the
  // "background vs waiting" line only counts tasks with a knowable end state — a
  // permanently-backgrounded Bash daemon shouldn't keep the agent looking busy.
  const backgroundActive = tasks.some(taskHasEndState);

  return (
    <>
      {tasks.length > 0 && (
        <div className="flex flex-col gap-1 py-2 px-4 bg-blue-500/10 border-t text-sm text-blue-700 dark:text-blue-400">
          <div className="flex items-center gap-2">
            <Spinner size="sm" />
            <span>
              {tasks.length} background task{tasks.length === 1 ? '' : 's'} running — you can keep
              chatting
            </span>
          </div>
          {tasks.map((task) => (
            <div key={task.taskId} className="flex items-center gap-2 pl-6 text-xs">
              <span className="truncate">
                {task.description || task.subagentType || task.taskId}
              </span>
              {onStopBackgroundTask && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 px-1"
                  onClick={() => onStopBackgroundTask(task.taskId)}
                  aria-label="Stop background task"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <TurnStatus isRunning={isRunning} backgroundActive={backgroundActive} retry={retry} />
    </>
  );
}
