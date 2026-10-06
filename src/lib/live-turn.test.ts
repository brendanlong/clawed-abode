import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  INITIAL_LIVE_TURN,
  diffLiveView,
  hasRealTurn,
  isRunning,
  liveView,
  reduceLiveTurn,
  type LiveEvent,
  type LiveOutcome,
  type LiveTurnState,
} from './live-turn';

// --- event builders ----------------------------------------------------------
const sdk = (message: Record<string, unknown>): LiveEvent => ({
  type: 'sdk_message',
  message: { session_id: 's', uuid: 'u', ...message } as unknown as SDKMessage,
});
const messageStart = (parent: string | null = null) =>
  sdk({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start' } });
const endTurn = sdk({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
});
const result = sdk({ type: 'result', subtype: 'success' });
const background = (...tasks: { task_id: string; task_type?: string }[]) =>
  sdk({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((t) => ({ task_type: 'local_agent', description: t.task_id, ...t })),
  });
const apiRetry = sdk({
  type: 'system',
  subtype: 'api_retry',
  attempt: 1,
  max_retries: 10,
  error: 'overloaded',
});
const pushed = (commandUuid: string): LiveEvent => ({
  type: 'pushed',
  commandUuid,
  prompt: {
    messageId: `m-${commandUuid}`,
    text: commandUuid,
    content: commandUuid,
    attachments: [],
  },
});
const lifecycle = (commandUuid: string, state: string): LiveEvent => ({
  type: 'command_lifecycle',
  lifecycle: { type: 'command_lifecycle', command_uuid: commandUuid, state },
});
const recalled = (...commandUuids: string[]): LiveEvent => ({ type: 'recalled', commandUuids });
const interruptRequested: LiveEvent = { type: 'interrupt_requested' };
const interruptFailed: LiveEvent = { type: 'interrupt_failed' };
const tornDown: LiveEvent = { type: 'torn_down' };

/** Fold events from `start`, collecting every step's outcome. */
function fold(events: LiveEvent[], start: LiveTurnState = INITIAL_LIVE_TURN) {
  const outcomes: LiveOutcome[] = [];
  let state = start;
  for (const event of events) {
    const outcome = reduceLiveTurn(state, event);
    outcomes.push(outcome);
    state = outcome.state;
  }
  return {
    state,
    view: liveView(state),
    finishedAt: outcomes.flatMap((o, i) => (o.finished ? [i] : [])),
    turnEndedAt: outcomes.flatMap((o, i) => (o.turnEnded ? [i] : [])),
  };
}

interface Case {
  name: string;
  events: LiveEvent[];
  running: boolean;
  pending?: string[];
  /** Indexes of the events that report "Claude finished". */
  finishedAt?: number[];
  turnActive?: boolean;
}

const cases: Case[] = [
  {
    name: 'a send to an idle session reads working before the CLI reports anything',
    events: [pushed('a')],
    running: true,
    pending: ['m-a'],
    turnActive: true,
  },
  {
    name: 'optimistic turn: the push feeds a turn that starts and ends naturally',
    events: [pushed('a'), lifecycle('a', 'started'), messageStart(), endTurn, result],
    running: false,
    finishedAt: [3],
  },
  {
    name: 'optimistic turn reaching its result with no message_start still finishes',
    events: [pushed('a'), result],
    running: false,
    finishedAt: [1],
  },
  {
    name: 'a recalled push on an idle session undoes the optimistic turn, without finishing',
    events: [pushed('a'), recalled('a')],
    running: false,
    turnActive: false,
  },
  {
    name: 'a recalled push leaves a turn the stream opened running',
    events: [messageStart(), pushed('a'), recalled('a')],
    running: true,
    turnActive: true,
  },
  {
    name: 'recalling one of two optimistic pushes keeps the turn',
    events: [pushed('a'), pushed('b'), recalled('a')],
    running: true,
    pending: ['m-b'],
  },
  {
    name: 'a recall confirmed after the CLI already reported the push cancelled still ends the optimistic turn',
    events: [pushed('a'), lifecycle('a', 'cancelled'), recalled('a')],
    running: false,
    turnActive: false,
    finishedAt: [],
  },
  {
    name: 'recalling an unknown command changes nothing',
    events: [pushed('a'), recalled('x')],
    running: true,
    pending: ['m-a'],
  },
  {
    name: '"started" clears the Sending marker but keeps the composer working',
    events: [
      messageStart(),
      endTurn,
      result,
      pushed('a'),
      lifecycle('a', 'queued'),
      lifecycle('a', 'started'),
    ],
    running: true,
    pending: [],
  },
  {
    name: 'a terminal lifecycle state retires the command outright',
    events: [pushed('a'), lifecycle('a', 'completed')],
    running: true, // the optimistic turn stays until the stream ends it
    pending: [],
  },
  {
    name: 'with lifecycle reports, an unread command survives one result boundary',
    events: [lifecycle('x', 'queued'), messageStart(), pushed('a'), endTurn, result],
    running: true,
    pending: ['m-a'],
    finishedAt: [],
  },
  {
    name: 'with lifecycle reports, a second result boundary retires it',
    events: [lifecycle('x', 'queued'), messageStart(), pushed('a'), endTurn, result, result],
    running: false,
  },
  {
    name: 'with lifecycle reports, a command read after a result outlives it until its turn opens',
    events: [
      lifecycle('x', 'queued'),
      messageStart(),
      pushed('a'),
      endTurn,
      result,
      lifecycle('a', 'started'),
      messageStart(),
      endTurn,
    ],
    running: false,
    finishedAt: [7],
  },
  {
    name: 'a CLI without lifecycle messages: the first boundary retires everything',
    events: [messageStart(), pushed('a'), endTurn, result],
    running: false,
    finishedAt: [],
  },
  {
    name: 'a CLI without lifecycle messages: message_start retires the push as read',
    events: [pushed('a'), messageStart()],
    running: true,
    pending: [],
  },
  {
    name: 'a subagent message_start retires nothing',
    events: [
      lifecycle('x', 'queued'),
      pushed('a'),
      lifecycle('a', 'started'),
      messageStart('tool'),
    ],
    running: true,
    pending: [],
  },
  {
    name: 'interrupt racing a natural end: the end is claimed, so no finished',
    events: [messageStart(), interruptRequested, endTurn, result],
    running: false,
    finishedAt: [],
  },
  {
    name: 'the claim is consumed by that end: the next turn finishes normally',
    events: [messageStart(), interruptRequested, endTurn, result, messageStart(), endTurn],
    running: false,
    finishedAt: [5],
  },
  {
    name: 'a failed interrupt withdraws the claim',
    events: [messageStart(), interruptRequested, interruptFailed, endTurn],
    running: false,
    finishedAt: [3],
  },
  {
    name: 'an interrupt request with no turn open claims nothing',
    events: [interruptRequested, pushed('a'), lifecycle('a', 'started'), messageStart(), endTurn],
    running: false,
    finishedAt: [4],
  },
  {
    name: 'an end-state background task suppresses finished',
    events: [background({ task_id: 't' }), messageStart(), endTurn],
    running: false,
    finishedAt: [],
  },
  {
    name: 'a backgrounded Bash does not suppress finished',
    events: [background({ task_id: 't', task_type: 'local_bash' }), messageStart(), endTurn],
    running: false,
    finishedAt: [2],
  },
  {
    name: 'a turn ending with a push still undelivered is not finished',
    events: [lifecycle('x', 'queued'), messageStart(), pushed('a'), endTurn],
    running: true,
    finishedAt: [],
  },
  {
    name: 'teardown mid-turn clears every live axis without finishing',
    events: [messageStart(), pushed('a'), background({ task_id: 't' }), apiRetry, tornDown],
    running: false,
    pending: [],
    turnActive: false,
    finishedAt: [],
  },
];

describe('reduceLiveTurn', () => {
  it.each(cases)('$name', (c) => {
    const { state, view, finishedAt } = fold(c.events);
    expect(view.running).toBe(c.running);
    if (c.pending) expect(view.pendingMessageIds).toEqual(c.pending);
    if (c.finishedAt) expect(finishedAt).toEqual(c.finishedAt);
    if (c.turnActive !== undefined) expect(state.status.turnActive).toBe(c.turnActive);
  });

  it('a lifecycle-reporting turn that ends with no message_start still finishes', () => {
    const events = [pushed('a'), lifecycle('a', 'started'), result, lifecycle('a', 'completed')];
    const { view, finishedAt } = fold(events);
    expect(view.running).toBe(false);
    expect(finishedAt).toEqual([2]);
  });

  it('a push read after the previous turn ended finishes its own turn with no message_start', () => {
    const events = [
      lifecycle('x', 'queued'),
      messageStart(),
      pushed('a'),
      endTurn,
      result,
      lifecycle('a', 'started'),
      result,
      lifecycle('a', 'completed'),
    ];
    const { view, finishedAt } = fold(events);
    expect(view.running).toBe(false);
    expect(finishedAt).toEqual([6]);
  });

  it('reports turnEnded only for a stream-driven end, not a recall or teardown', () => {
    expect(fold([messageStart(), endTurn]).turnEndedAt).toEqual([1]);
    expect(fold([pushed('a'), recalled('a')]).turnEndedAt).toEqual([]);
    expect(fold([messageStart(), tornDown]).turnEndedAt).toEqual([]);
  });

  it('teardown keeps lifecycle support and leaves no claim or optimistic flag behind', () => {
    const { state } = fold([lifecycle('x', 'queued'), pushed('a'), interruptRequested, tornDown]);
    expect(state.commandLifecycleSeen).toBe(true);
    expect(state.interruptRequested).toBe(false);
    expect(state.optimisticTurnActive).toBe(false);
    expect(state.status.backgroundTasks.size).toBe(0);
    expect(state.status.retry).toBeNull();
  });

  it('an optimistic turn is not a real one until the stream opens it', () => {
    expect(hasRealTurn(fold([pushed('a')]).state)).toBe(false);
    expect(hasRealTurn(fold([pushed('a'), messageStart()]).state)).toBe(true);
    expect(isRunning(fold([pushed('a')]).state)).toBe(true);
  });

  it('a lifecycle event does not touch the stream status (a retry indicator stays)', () => {
    const { view } = fold([pushed('a'), apiRetry, lifecycle('a', 'started')]);
    expect(view.retry).not.toBeNull();
  });
});

describe('diffLiveView', () => {
  const step = (events: LiveEvent[], next: LiveEvent) => {
    const before = fold(events).state;
    return diffLiveView(liveView(before), liveView(reduceLiveTurn(before, next).state));
  };

  it('reports only the channels that moved', () => {
    expect(step([], pushed('a'))).toEqual({ pendingMessageIds: ['m-a'], running: true });
    expect(step([pushed('a')], lifecycle('a', 'started'))).toEqual({ pendingMessageIds: [] });
    expect(step([pushed('a'), lifecycle('a', 'started')], messageStart())).toEqual({});
    expect(step([], apiRetry)).toMatchObject({ retry: { attempt: 1 } });
    expect(step([apiRetry], messageStart())).toEqual({ running: true, retry: null });
  });

  it('emits the background set on every level signal, and nothing for a teardown that had none', () => {
    expect(step([], background({ task_id: 't' }))).toMatchObject({
      backgroundTasks: [{ taskId: 't' }],
    });
    expect(step([background({ task_id: 't' })], tornDown)).toEqual({ backgroundTasks: [] });
    expect(step([], tornDown)).toEqual({});
  });
});
