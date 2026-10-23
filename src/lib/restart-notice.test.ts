import { describe, expect, it } from 'vitest';
import { INITIAL_LIVE_TURN, type InFlightCommand, type LiveTurnState } from './live-turn';
import { restartNotice } from './restart-notice';
import type { BackgroundTask } from './session-status';

function turnWith(
  opts: { turnActive?: boolean; tasks?: BackgroundTask[]; inFlight?: boolean } = {}
): LiveTurnState {
  const inFlight = new Map<string, InFlightCommand>();
  if (opts.inFlight) {
    inFlight.set('cmd', {
      messageId: 'm',
      text: 'hi',
      attachments: [],
      content: 'hi',
      started: false,
      resultsSeen: 0,
    });
  }
  return {
    ...INITIAL_LIVE_TURN,
    inFlight,
    status: {
      ...INITIAL_LIVE_TURN.status,
      turnActive: opts.turnActive ?? false,
      backgroundTasks: new Map((opts.tasks ?? []).map((t) => [t.taskId, t])),
    },
  };
}

const task = (fields: Partial<BackgroundTask>): BackgroundTask => ({
  taskId: 't',
  taskType: 'local_agent',
  description: 'work',
  ambient: false,
  ...fields,
});

describe('restartNotice', () => {
  it('says nothing to an idle agent with no background work', () => {
    expect(restartNotice(turnWith(), false)).toBeNull();
  });

  it('says nothing about ambient housekeeping tasks alone', () => {
    expect(restartNotice(turnWith({ tasks: [task({ ambient: true })] }), false)).toBeNull();
  });

  it('tells an agent cut off mid-turn to continue', () => {
    expect(restartNotice(turnWith({ turnActive: true }), false)).toMatch(/turn was cut off/);
  });

  it('counts a prompt the agent had not started on as a cut-off turn', () => {
    expect(restartNotice(turnWith({ inFlight: true }), false)).toMatch(/turn was cut off/);
  });

  it('lists each killed background task, Monitors and subagents included', () => {
    const notice = restartNotice(
      turnWith({
        tasks: [
          task({ taskId: 'a', description: 'watch CI', taskType: 'local_bash' }),
          task({ taskId: 'b', description: 'review PR', subagentType: 'Explore' }),
        ],
      }),
      false
    );
    expect(notice).toContain('watch CI');
    expect(notice).toContain('review PR');
    expect(notice).not.toMatch(/turn was cut off/);
  });

  it('mentions cancelled GPT agents', () => {
    expect(restartNotice(turnWith(), true)).toMatch(/GPT agents/);
  });
});
