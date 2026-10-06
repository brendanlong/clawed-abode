import type { Query, SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Pushable } from '@/lib/pushable';
import { INITIAL_LIVE_STATUS, type LiveStatus } from '@/lib/session-status';
import type { SanitizationInfo } from '@/lib/sanitization';
import type { UserInputRequest } from './sdk-options';
import type { MergedSessionSettings } from './settings-merger';

/**
 * A pending interactive tool request: the `canUseTool` callback parks a promise
 * here and the answer mutation resolves it.
 */
export interface PendingUserInput extends UserInputRequest {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
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
export interface InFlightCommand {
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
  /** The CLI reported the agent has read it (`command_lifecycle` left `queued`). */
  started: boolean;
  /** Top-level `result`s seen since the push — see retireInFlightCommands. */
  resultsSeen: number;
}

/**
 * Everything bound to one established query: created together when it is
 * established, dropped together by `releaseQuery`. Anything holding a `LiveQuery`
 * (the output loop, an async callback) checks it is still current with
 * `state.live === live`.
 */
export interface LiveQuery {
  query: Query;
  /** Input channel feeding the query; push user messages, close to end the query. */
  input: Pushable<SDKUserMessage>;
  /**
   * Transient systemd user scope the CLI runs in (null when cgroup reaping is
   * unavailable). Mirrored onto the DB row by the runner so a crash can reap it by
   * exact name; stopped on teardown to kill the whole process tree.
   */
  sessionScope: string | null;
  workingDir: string;
  /** Settings the query was built with (model/MCP can be applied live later). */
  boundSettings: MergedSessionSettings;
  /** Settings key (repoFullName or '__no_repo__') for reloading merged settings. */
  settingsKey: string;
  /**
   * Claude Code conversation last persisted to `Session.claudeSessionId` by this
   * query (null until its first init), so only changes are written.
   */
  claudeSessionId: string | null;
  pendingInput: PendingUserInput | null;
  /**
   * Sanitizer findings from the PostToolUse hook, keyed by tool_use_id, awaiting
   * the matching tool_result message so they can be attached on persist (the
   * message comes from the SDK stream, not from us). Consumed once; a finding
   * whose result never streams back (query killed mid-tool) dies with the query.
   */
  toolSanitizations: Map<string, SanitizationInfo>;
}

/** In-memory state for one active session. */
export interface SessionState {
  /** The established query, or null when there is none (e.g. after restart). */
  live: LiveQuery | null;
  /** In-flight establishment promise, for coalescing concurrent ensureSessionQuery. */
  establishing: Promise<SessionState> | null;
  /** Two-axis live status + ephemeral retry (derived from the message stream). */
  status: LiveStatus;
  /**
   * Messages pushed into the SDK whose work hasn't visibly begun yet, keyed by the
   * `uuid` stamped on the pushed message. See {@link InFlightCommand}.
   */
  inFlightCommands: Map<string, InFlightCommand>;
  /**
   * Last `running` value emitted. The composer's "working"
   * state is `turnActive || inFlightCommands.size > 0`, derived from two
   * independently-changing inputs, so the last emitted value is kept rather than
   * inferred from a status diff.
   */
  emittedRunning: boolean;
  /**
   * Whether this session's CLI has ever emitted a `command_lifecycle` message.
   * That message is undocumented (absent from the SDK's types), so this guards
   * against a CLI that stops sending it: a supporting CLI reports `queued` within
   * milliseconds of a push, and without it an in-flight entry would pin the
   * composer "working" (see retireInFlightCommands).
   */
  commandLifecycleSeen: boolean;
  /**
   * Set when a turn is being interrupted so the turn-end it triggers is not
   * reported as Claude *finishing*. Consumed by the turn-end in applyStatus.
   */
  interruptRequested: boolean;
  /**
   * `turnActive` was set optimistically by a push and no real turn has been seen
   * since. Normally the turn that push feeds arrives and clears it — but if the
   * push is recalled before the CLI ever reads it (a rate-limit pause), nothing
   * will ever arrive to flip `turnActive` back, and the composer would read
   * "working" for the whole pause. See `clearOptimisticTurn`.
   */
  optimisticTurnActive: boolean;
}

export function createSessionState(): SessionState {
  return {
    live: null,
    establishing: null,
    status: INITIAL_LIVE_STATUS,
    inFlightCommands: new Map(),
    emittedRunning: false,
    commandLifecycleSeen: false,
    interruptRequested: false,
    optimisticTurnActive: false,
  };
}
