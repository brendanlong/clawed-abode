import type {
  Query,
  SDKUserMessage,
  SlashCommand,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { Pushable } from '@/lib/pushable';
import { INITIAL_LIVE_STATUS, type LiveStatus } from '@/lib/session-status';
import type { SanitizationInfo } from '@/lib/sanitization';
import type { MergedSessionSettings } from './settings-merger';

/**
 * A pending interactive tool request (AskUserQuestion / ExitPlanMode): the
 * `canUseTool` callback parks a promise here and the answer mutation resolves it.
 */
export interface PendingUserInput {
  toolName: string;
  /** The tool_use block id, used to match an incoming answer to this request. */
  toolUseId: string;
  input: Record<string, unknown>;
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
  /** The CLI reported the agent has read it (`command_lifecycle` left `queued`). */
  started: boolean;
  /** Top-level `result`s seen since the push — see retireInFlightCommands. */
  resultsSeen: number;
}

/** In-memory state for one active session. */
export interface SessionState {
  /** The live streaming query, or null when not established (e.g. after restart). */
  query: Query | null;
  /** Input channel feeding the query; push user messages, close to end the query. */
  input: Pushable<SDKUserMessage> | null;
  /** In-flight establishment promise, for coalescing concurrent ensureSessionQuery. */
  establishing: Promise<SessionState> | null;
  /** Two-axis live status + ephemeral retry (derived from the message stream). */
  status: LiveStatus;
  pendingInput: PendingUserInput | null;
  workingDir: string;
  /** Discovered slash commands (mirrored into session-commands for reads between queries). */
  commands: SlashCommand[];
  /** Settings the live query was built with (model/MCP can be applied live later). */
  boundSettings: MergedSessionSettings | null;
  /** Settings key (repoFullName or '__no_repo__') for reloading merged settings. */
  settingsKey: string;
  /**
   * Sanitizer findings from the PostToolUse hook, keyed by tool_use_id, awaiting
   * the matching tool_result message so they can be attached on persist (the
   * message comes from the SDK stream, not from us). Consumed once.
   */
  toolSanitizations: Map<string, SanitizationInfo>;
  /**
   * Messages pushed into the SDK whose work hasn't visibly begun yet, keyed by the
   * `uuid` stamped on the pushed message. See {@link InFlightCommand}.
   */
  inFlightCommands: Map<string, InFlightCommand>;
  /**
   * Last value emitted on the `claude_running` channel. The composer's "working"
   * state is `turnActive || inFlightCommands.size > 0`, derived from two
   * independently-changing inputs, so the last emitted value is kept rather than
   * inferred from a status diff.
   */
  emittedRunning: boolean;
  /**
   * Whether this session's CLI has ever emitted a `command_lifecycle` message.
   * A supporting CLI reports `queued` within milliseconds of a push, so this
   * doubles as a feature check deciding how many turns an in-flight entry may
   * survive without a report (see retireInFlightCommands).
   */
  commandLifecycleSeen: boolean;
  /**
   * Set by interruptClaude so the turn-end it triggers is not reported as Claude
   * *finishing*. Consumed by the turn-end in applyStatus.
   */
  interruptRequested: boolean;
  /**
   * Transient systemd user scope this session's query runs in (null when cgroup
   * reaping is unavailable). Mirrored onto the DB row by the runner so a crash can
   * reap it by exact name; stopped on teardown to kill the whole process tree.
   */
  sessionScope: string | null;
}

export function createSessionState(workingDir: string, commands: SlashCommand[]): SessionState {
  return {
    query: null,
    input: null,
    establishing: null,
    status: INITIAL_LIVE_STATUS,
    pendingInput: null,
    workingDir,
    commands,
    boundSettings: null,
    settingsKey: '',
    toolSanitizations: new Map(),
    inFlightCommands: new Map(),
    emittedRunning: false,
    commandLifecycleSeen: false,
    interruptRequested: false,
    sessionScope: null,
  };
}
