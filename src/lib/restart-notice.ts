import { isRunning, type LiveTurnState } from './live-turn';
import { BACKGROUND_BASH_TASK_TYPE, type BackgroundTask } from './session-status';

function describeTask(task: BackgroundTask): string {
  if (task.subagentType) return `${task.description} (${task.subagentType} subagent)`;
  if (task.taskType === BACKGROUND_BASH_TASK_TYPE)
    return `${task.description} (background command or Monitor)`;
  return task.description;
}

function lostWork(turn: LiveTurnState, gptAgentsRunning: boolean): string[] {
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
  return lost;
}

const SURVIVES_RESTART = 'PR watches and usage alerts survive restarts, so they need no re-arming.';

/**
 * What to tell an agent whose CLI a server shutdown is about to kill, or null if it
 * loses nothing it would notice: no turn in progress, no background work.
 */
export function restartNotice(turn: LiveTurnState, gptAgentsRunning: boolean): string | null {
  const lost = lostWork(turn, gptAgentsRunning);
  if (lost.length === 0) return null;
  return [
    'The Clawed Abode server restarted, which ended your Claude Code process; your conversation was restored.',
    ...lost,
    SURVIVES_RESTART,
  ].join('\n');
}

/**
 * What to tell an agent whose session systemd-oomd killed. Always said, since the
 * kill also took every process the agent started, and the agent likely caused it.
 */
export function oomKillNotice(turn: LiveTurnState, gptAgentsRunning: boolean): string {
  return [
    'systemd-oomd killed your Claude Code process and everything it started (subagents, builds, test runs, dev servers, databases) because the machine was running out of memory and your session was competing hardest for it. Your conversation was restored.',
    ...lostWork(turn, gptAgentsRunning),
    "- Before rerunning memory-heavy work, run less of it at once: one build or test suite at a time rather than one per subagent, and stop build daemons (such as Gradle's) you no longer need.",
    SURVIVES_RESTART,
  ].join('\n');
}
