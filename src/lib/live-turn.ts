/**
 * Pure reducer for a session's live turn state: the stream-derived status
 * ({@link reduceSessionMessage}) plus delivery tracking for pushed prompts and the
 * interrupt bookkeeping, folded from one {@link LiveEvent} union. The runner keeps
 * no other turn state: it dispatches events, and emits exactly the SSE channels
 * whose {@link liveView} projection changed. Rationale: doc/claude-sessions.md.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CommandLifecycle, RetryState } from './claude-messages';
import {
  INITIAL_LIVE_STATUS,
  backgroundActive,
  isTopLevelMessageStart,
  reduceSessionMessage,
  retryEquals,
  type BackgroundTask,
  type LiveStatus,
} from './session-status';

/** What it takes to push a prompt and, if recalled, to re-queue or restore it. */
export interface PushedPrompt {
  /** Id of the persisted transcript bubble for this message. */
  messageId: string;
  /** The user's typed text (original, un-sanitized), for restore-on-cancel. */
  text: string;
  /** Stored names of files attached to it (see /api/upload), likewise. */
  attachments: string[];
  /**
   * The prepared text actually pushed into the SDK (attachment paths prefixed,
   * sanitized). Kept so a recall can re-push the message verbatim instead of
   * re-preparing it — a rate-limit pause re-queues rather than discards.
   */
  content: string;
}

/**
 * A user message handed to the SDK whose work hasn't visibly begun yet. It passes
 * through two stages, tracked separately because they answer different questions:
 *
 * - **Not `started`** — the CLI has it queued but the agent hasn't read it. This is
 *   what the transcript marks "Sending…", and the only stage Stop can cancel.
 * - **`started`, no turn open yet** — the agent is reading it, but the turn it
 *   feeds hasn't produced a `message_start`. Nothing to show the user, yet the
 *   entry must survive: `turnActive` is false across that gap (full model latency
 *   when the previous turn ended before the CLI folded this message in), and
 *   dropping it here would blink the composer idle mid-work.
 */
export interface InFlightCommand extends PushedPrompt {
  /** The CLI reported the agent has read it (`command_lifecycle` left `queued`). */
  started: boolean;
  /** Top-level `result`s seen since the push — see {@link retire}. */
  resultsSeen: number;
}

export interface LiveTurnState {
  /** Two-axis live status + ephemeral retry, derived from the message stream. */
  status: LiveStatus;
  /** Pushed messages whose work hasn't visibly begun, by the `uuid` stamped on the push. */
  inFlight: ReadonlyMap<string, InFlightCommand>;
  /**
   * Whether this session's CLI has ever emitted a `command_lifecycle` message.
   * That message is undocumented (absent from the SDK's types), so this guards
   * against a CLI that stops sending it: a supporting CLI reports `queued` within
   * milliseconds of a push, and without it an in-flight entry would pin the
   * composer "working" (see {@link retire}).
   */
  commandLifecycleSeen: boolean;
  /** The coming turn-end is an interrupt, not Claude *finishing*; the turn-end consumes it. */
  interruptRequested: boolean;
  /**
   * `turnActive` was set optimistically by a push and no real turn has been seen
   * since. Normally the turn that push feeds arrives and clears it — but if the
   * push is recalled before the CLI ever reads it (a rate-limit pause), nothing
   * will ever arrive to flip `turnActive` back, so the recall must.
   */
  optimisticTurnActive: boolean;
}

export const INITIAL_LIVE_TURN: LiveTurnState = {
  status: INITIAL_LIVE_STATUS,
  inFlight: new Map(),
  commandLifecycleSeen: false,
  interruptRequested: false,
  optimisticTurnActive: false,
};

export type LiveEvent =
  /** Any SDK message other than `command_lifecycle`. */
  | { type: 'sdk_message'; message: SDKMessage }
  | { type: 'command_lifecycle'; lifecycle: CommandLifecycle }
  | { type: 'pushed'; commandUuid: string; prompt: PushedPrompt }
  /** The CLI confirmed it dropped these never-read pushes. */
  | { type: 'recalled'; commandUuids: string[] }
  /** Claim the coming turn-end (if a turn is active) as an interrupt. */
  | { type: 'interrupt_requested' }
  /** No interrupt-driven turn-end is coming after all. */
  | { type: 'interrupt_failed' }
  /** The query is gone: everything live dies with it. */
  | { type: 'torn_down' };

export interface LiveOutcome {
  state: LiveTurnState;
  /** A main turn ended (stream-driven) — the moment to refresh branch/PR. */
  turnEnded: boolean;
  /**
   * A natural turn end that leaves the session fully idle: not interrupted, no
   * end-state background task, nothing pending delivery. Why turn-end rather than
   * background-drain, and why not the bare running:false edge: doc/claude-sessions.md.
   */
  finished: boolean;
}

export function reduceLiveTurn(state: LiveTurnState, event: LiveEvent): LiveOutcome {
  const settled = (next: LiveTurnState): LiveOutcome => ({
    state: next,
    turnEnded: false,
    finished: false,
  });

  switch (event.type) {
    case 'sdk_message':
      return reduceMessage(state, event.message);

    case 'command_lifecycle': {
      // `queued` is the CLI acknowledging receipt. `started` clears the "Sending…"
      // marker but the entry lives on until the turn it feeds opens; a terminal
      // `completed`/`cancelled` retires it outright, covering a `started` that
      // never arrived.
      const seen = { ...state, commandLifecycleSeen: true };
      const { command_uuid: commandUuid, state: stage } = event.lifecycle;
      const command = state.inFlight.get(commandUuid);
      if (stage === 'queued' || !command) return settled(seen);
      const inFlight = new Map(state.inFlight);
      if (stage === 'started') {
        if (command.started) return settled(seen);
        inFlight.set(commandUuid, { ...command, started: true });
      } else {
        inFlight.delete(commandUuid);
      }
      return settled({ ...seen, inFlight });
    }

    case 'pushed': {
      const inFlight = new Map(state.inFlight).set(event.commandUuid, {
        ...event.prompt,
        started: false,
        resultsSeen: 0,
      });
      // Optimistically mark the turn active so the true→false edge — and the
      // finished signal — stays intact for a turn that reaches its terminal
      // `result` without a `message_start`.
      if (state.status.turnActive) return settled({ ...state, inFlight });
      return settled({
        ...state,
        inFlight,
        status: { ...state.status, turnActive: true },
        optimisticTurnActive: true,
      });
    }

    case 'recalled': {
      const dropped = new Set(event.commandUuids.filter((id) => state.inFlight.has(id)));
      const inFlight =
        dropped.size > 0
          ? new Map([...state.inFlight].filter(([id]) => !dropped.has(id)))
          : state.inFlight;
      // A purely optimistic turnActive must go once nothing in flight justifies
      // it; a turn that genuinely started is left to the stream to end. Checked
      // even when the entry is already gone: the CLI's `cancelled` lifecycle can
      // retire it while the cancel is still being confirmed.
      if (!state.optimisticTurnActive || inFlight.size > 0) return settled({ ...state, inFlight });
      return settled({
        ...state,
        inFlight,
        optimisticTurnActive: false,
        status: { ...state.status, turnActive: false },
      });
    }

    case 'interrupt_requested':
      return settled({ ...state, interruptRequested: state.status.turnActive });

    case 'interrupt_failed':
      return settled({ ...state, interruptRequested: false });

    case 'torn_down': {
      // Deliveries in flight die with the query; their bubbles stay (they may
      // well have been read), but the "not delivered yet" marker must clear. The
      // SDK's background-task level is per CLI process and sends nothing at
      // startup, so the set must start empty for the next process.
      const { status } = state;
      return settled({
        ...state,
        interruptRequested: false,
        optimisticTurnActive: false,
        inFlight: state.inFlight.size > 0 ? new Map() : state.inFlight,
        status: {
          turnActive: false,
          retry: null,
          backgroundTasks: status.backgroundTasks.size > 0 ? new Map() : status.backgroundTasks,
          subagentTypes: status.subagentTypes.size > 0 ? new Map() : status.subagentTypes,
        },
      });
    }
  }
}

function reduceMessage(state: LiveTurnState, message: SDKMessage): LiveOutcome {
  const { status, changed } = reduceSessionMessage(state.status, message);
  const turnEnded = changed.turnActive && !status.turnActive;
  // An interrupt's turn-end is not Claude finishing — the user stopped it.
  const interrupted = turnEnded && state.interruptRequested;

  // Any real turn boundary supersedes the optimistic flag: from here on the
  // stream owns turnActive. `message_start` needs its own clause — it lands while
  // the flag already reads true, so it moves no axis for `changed` to report.
  const boundary =
    changed.turnActive || isTopLevelMessageStart(message) || message.type === 'result';

  const next: LiveTurnState = {
    ...state,
    status,
    inFlight: retire(state.inFlight, state.commandLifecycleSeen, message),
    interruptRequested: turnEnded ? false : state.interruptRequested,
    optimisticTurnActive: boundary ? false : state.optimisticTurnActive,
  };
  return {
    state: next,
    turnEnded,
    finished: turnEnded && !interrupted && !backgroundActive(status) && next.inFlight.size === 0,
  };
}

/**
 * Retire in-flight commands that have visibly become ordinary turn work, and
 * guarantee none can linger forever (a lingering entry pins the composer
 * "working"). Never time-based.
 *
 * - A top-level `message_start` retires every entry the agent has already read.
 * - A top-level `result` is the safety valve: an entry may survive one turn
 *   boundary (the fold-after-turn-end case) and no more; on a CLI that reports no
 *   lifecycle at all the first boundary retires it.
 */
function retire(
  inFlight: ReadonlyMap<string, InFlightCommand>,
  lifecycleSeen: boolean,
  message: SDKMessage
): ReadonlyMap<string, InFlightCommand> {
  if (inFlight.size === 0) return inFlight;
  const isResult = message.type === 'result';
  if (!isResult && !isTopLevelMessageStart(message)) return inFlight;

  const maxTurnsWithoutReport = lifecycleSeen ? 2 : 1;
  const next = new Map<string, InFlightCommand>();
  for (const [commandUuid, command] of inFlight) {
    if (isResult) {
      const resultsSeen = command.resultsSeen + 1;
      if (resultsSeen < maxTurnsWithoutReport) next.set(commandUuid, { ...command, resultsSeen });
    } else if (!command.started && lifecycleSeen) {
      next.set(commandUuid, command);
    }
  }
  return next;
}

/** What the composer shows as "Claude is working": a live turn, or an undelivered push. */
export function isRunning(state: LiveTurnState): boolean {
  return state.status.turnActive || state.inFlight.size > 0;
}

/** Whether a main turn the stream actually opened is running (not just an optimistic one). */
export function hasRealTurn(state: LiveTurnState): boolean {
  return state.status.turnActive && !state.optimisticTurnActive;
}

/** What clients see of the live turn state; each field is one SSE channel. */
export interface LiveView {
  running: boolean;
  /** Transcript ids the agent hasn't read yet, in push order ("Sending…"). */
  pendingMessageIds: string[];
  backgroundTasks: ReadonlyMap<string, BackgroundTask>;
  retry: RetryState | null;
}

export function liveView(state: LiveTurnState): LiveView {
  return {
    running: isRunning(state),
    pendingMessageIds: [...state.inFlight.values()]
      .filter((c) => !c.started)
      .map((c) => c.messageId),
    backgroundTasks: state.status.backgroundTasks,
    retry: state.status.retry,
  };
}

/** The channels whose value changed between two views; absent = unchanged. */
export interface LiveViewChanges {
  pendingMessageIds?: string[];
  running?: boolean;
  backgroundTasks?: BackgroundTask[];
  retry?: RetryState | null;
}

export function diffLiveView(prev: LiveView, next: LiveView): LiveViewChanges {
  const changes: LiveViewChanges = {};
  const pendingSame =
    prev.pendingMessageIds.length === next.pendingMessageIds.length &&
    prev.pendingMessageIds.every((id, i) => id === next.pendingMessageIds[i]);
  if (!pendingSame) changes.pendingMessageIds = next.pendingMessageIds;
  if (prev.running !== next.running) changes.running = next.running;
  // The reducer replaces the set on every level signal and only then.
  if (prev.backgroundTasks !== next.backgroundTasks) {
    changes.backgroundTasks = [...next.backgroundTasks.values()];
  }
  if (!retryEquals(prev.retry, next.retry)) changes.retry = next.retry;
  return changes;
}
