import { isRunning, type LiveTurnState } from './live-turn';
import { BACKGROUND_BASH_TASK_TYPE, type BackgroundTask } from './session-status';

function describeTask(task: BackgroundTask): string {
  if (task.subagentType) return `${task.description} (${task.subagentType} subagent)`;
  if (task.taskType === BACKGROUND_BASH_TASK_TYPE)
    return `${task.description} (background command or Monitor)`;
  return task.description;
}

/**
 * What to tell an agent whose CLI a server shutdown is about to kill, or null if it
 * loses nothing it would notice: no turn in progress, no background work.
 */
export function restartNotice(turn: LiveTurnState, gptAgentsRunning: boolean): string | null {
  const tasks = [...turn.status.backgroundTasks.values()].filter((task) => !task.ambient);
  const lost: string[] = [];
  if (isRunning(turn)) lost.push('- Your turn was cut off. Continue it if the work is unfinished.');
  if (tasks.length > 0) {
    lost.push(
      '- These background tasks were killed and will not report back; restart any you still need:',
      ...tasks.map((task) => `  - ${describeTask(task)}`)
    );
  }
  if (gptAgentsRunning) lost.push('- Your running GPT agents were cancelled.');
  if (lost.length === 0) return null;
  return [
    'The Clawed Abode server restarted, which ended your Claude Code process; your conversation was restored.',
    ...lost,
    'PR watches and usage alerts survive restarts, so they need no re-arming.',
  ].join('\n');
}
