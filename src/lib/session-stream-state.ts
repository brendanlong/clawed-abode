import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Session } from '@/generated/prisma/client';
import { assertNeverFallback, type RetryState } from './claude-messages';
import type { RateLimitHold } from './rate-limit';
import type { BackgroundTask } from './session-status';
import type { SessionView } from './session-view';
import type { TokenUsageStats } from './token-estimation';
import type { SessionStreamOutput } from '@/server/routers/sse';

/** Every latest-value field of a session, each kept current by its own stream event. */
export interface SessionLiveState {
  /** A main-agent turn is active (gates the composer). */
  running: boolean;
  commands: SlashCommand[];
  /** Ephemeral API-retry status (rate limit / overload). */
  retry: RetryState | null;
  /** run_in_background subagents / Monitor / backgrounded Bash. */
  backgroundTasks: BackgroundTask[];
  /** Transcript ids the SDK has accepted but not yet handed to the agent. */
  pendingMessageIds: string[];
  /** Transcript ids held back by a rate-limit pause, in queue order. */
  queuedMessageIds: string[];
  /** This session's subscription rate-limit pause, or null when it may work. */
  rateLimitHold: RateLimitHold | null;
  /** Token totals, cost, and context fill. */
  tokenUsage: TokenUsageStats;
}

/** The non-transcript state the per-session stream maintains on the client. */
export interface SessionStreamState {
  session: SessionView<Session>;
  live: SessionLiveState;
}

/** Stream events that set {@link SessionStreamState} rather than the transcript. */
export type SessionStateEvent = Exclude<
  SessionStreamOutput,
  { kind: 'message' } | { kind: 'message_removed' }
>;

/**
 * Apply one stream event to the client's session state. A snapshot replaces it
 * wholesale; every other event sets one field. Before the first snapshot there
 * is nothing to patch (the snapshot is always the first event, so this only
 * guards a cache that was cleared underneath the stream).
 */
export function applySessionStateEvent(
  state: SessionStreamState | undefined,
  event: SessionStateEvent
): SessionStreamState | undefined {
  if (event.kind === 'snapshot') return { session: event.session, live: event.live };
  if (!state) return state;
  const live = (patch: Partial<SessionLiveState>) => ({
    ...state,
    live: { ...state.live, ...patch },
  });
  switch (event.kind) {
    case 'session':
      return { ...state, session: event.session };
    case 'running':
      return live({ running: event.running });
    case 'commands':
      return live({ commands: event.commands });
    case 'retry':
      return live({ retry: event.retry });
    case 'background':
      return live({ backgroundTasks: event.tasks });
    case 'pending':
      return live({ pendingMessageIds: event.messageIds });
    case 'queued':
      return live({ queuedMessageIds: event.messageIds });
    case 'rate_limit':
      return live({ rateLimitHold: event.hold });
    case 'token_usage':
      return live({ tokenUsage: event.usage });
    default:
      // Compile-time guard: a new stream event kind must be handled here.
      return assertNeverFallback(event, state);
  }
}
