import type {
  McpSdkServerConfigWithInstance,
  Query,
  SDKUserMessage,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { Pushable } from '@/lib/pushable';
import { INITIAL_LIVE_TURN, type LiveTurnState } from '@/lib/live-turn';
import type { SanitizationInfo } from '@/lib/sanitization';
import type { UserInputRequest } from './sdk-options';
import type { MergedSessionSettings } from './settings-merger';
import type { ParsedMessage } from './message-store';

/**
 * A pending interactive tool request: the `canUseTool` callback parks a promise
 * here and the answer mutation resolves it.
 */
export interface PendingUserInput extends UserInputRequest {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
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
  /**
   * MCP servers as last loaded from settings, ahead of `boundSettings` when a live
   * apply failed. Tool filtering enforces both lists, so a tightened filter holds
   * even then.
   */
  loadedMcpServers: MergedSessionSettings['mcpServers'];
  /** The MCP tool deny rules the CLI holds; null when unknown because applying them failed. */
  appliedDenyRules: string[] | null;
  /** The built-in MCP server bound at establishment (see `SdkOptionsResult`). */
  builtinMcpServer: McpSdkServerConfigWithInstance | null;
  /** Settings key (repoFullName or '__no_repo__') for reloading merged settings. */
  settingsKey: string;
  /**
   * Claude Code conversation last persisted to `Session.claudeSessionId` by this
   * query (null until its first init), so only changes are written.
   */
  claudeSessionId: string | null;
  pendingInput: PendingUserInput | null;
  /**
   * A `notify_user` summary held until the main turn ends, so the user is
   * notified once the agent's final message is written, not before it.
   */
  pendingAttention: string | null;
  /**
   * Sanitizer findings from the PostToolUse hook, keyed by tool_use_id, awaiting
   * the matching tool_result message so they can be attached on persist (the
   * message comes from the SDK stream, not from us). Consumed once; a finding
   * whose result never streams back (query killed mid-tool) dies with the query.
   */
  toolSanitizations: Map<string, SanitizationInfo>;
  /** uuids of the prompts pushed into this query, to drop the CLI's replays of them. */
  pushedUuids: Set<string>;
  /**
   * The last partial emitted for each in-progress assistant message, keyed by
   * partial id, so a stream snapshot can carry the output the user is watching.
   * Dropped as its complete message (or the turn's result) arrives.
   */
  partials: Map<string, ParsedMessage>;
}

/** In-memory state for one active session. */
export interface SessionState {
  /** The established query, or null when there is none (e.g. after restart). */
  live: LiveQuery | null;
  /** In-flight establishment promise, for coalescing concurrent ensureSessionQuery. */
  establishing: Promise<SessionState> | null;
  /**
   * Live turn and delivery state. Changed only through the runner's `dispatch`,
   * so what clients were last sent is always `liveView(turn)`.
   */
  turn: LiveTurnState;
  /** Tail of the live-settings applies, which run one at a time so a stale load can't land last. */
  settingsApply: Promise<void>;
}

export function createSessionState(): SessionState {
  return {
    live: null,
    establishing: null,
    turn: INITIAL_LIVE_TURN,
    settingsApply: Promise.resolve(),
  };
}
