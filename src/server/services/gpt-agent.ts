import {
  query as sdkQuery,
  type Options,
  type Query,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { env } from '@/lib/env';
import {
  gptAgentEnv,
  gptAgentOutcome,
  type GptAgentOutcome,
  type GptAgentTier,
} from '@/lib/gpt-agent';
import { GPT_AGENT_MODELS } from '@/lib/llm-proxy';
import { createLogger, toError } from '@/lib/logger';
import { processSingleton } from '@/lib/process-singleton';
import {
  CLAUDE_BIN_ENV,
  childScopeUnitName,
  SESSION_SCOPE_ENV,
  SESSIONS_SLICE,
  SESSIONS_SLICE_ENV,
} from '@/lib/session-scope';
import { sessionScopeNonce, stopScope } from './session-cgroup';

const log = createLogger('gpt-agent');

/** What a session's gpt_agent tool needs to run agents like the session's own CLI. */
export interface GptAgentContext {
  sessionId: string;
  workingDir: string;
  settingSources: SettingSource[];
  /** The session CLI's env before scope wiring. */
  env: Record<string, string | undefined>;
  /** How the session's CLI is scoped, so a run gets a child scope; null when unscoped. */
  scope: { launcherPath: string; claudeBin: string; sessionScope: string } | null;
}

type QueryFactory = (params: { prompt: string; options: Options }) => Query;
let queryFactory: QueryFactory = sdkQuery;

/** Override the query factory (for tests). Pass null to restore the SDK default. */
export function _setGptQueryFactory(factory: QueryFactory | null): void {
  queryFactory = factory ?? sdkQuery;
}

/**
 * Runs in flight per session: a restart waits for them, and teardown aborts them
 * (the child scope would kill them, but a session can run unscoped).
 */
const activeRuns = processSingleton(
  'gpt-agent.activeRuns',
  () => new Map<string, Set<AbortController>>()
);

export function hasActiveGptRuns(sessionId: string): boolean {
  return (activeRuns.get(sessionId)?.size ?? 0) > 0;
}

/** Abort a session's runs, e.g. because its query is going away. */
export function abortGptRuns(sessionId: string): void {
  for (const controller of activeRuns.get(sessionId) ?? []) controller.abort();
}

/**
 * Run a one-shot Claude Code agent on a GPT model behind the LLM proxy and
 * return its final answer. The run gets a child of the session's scope, so
 * stopping the session kills it; `signal` (the tool call's) kills it on interrupt.
 */
export async function runGptAgent(
  ctx: GptAgentContext,
  tier: GptAgentTier,
  prompt: string,
  signal?: AbortSignal
): Promise<GptAgentOutcome> {
  if (!env.LLM_PROXY_URL) throw new Error('No LLM proxy is configured');
  const model = GPT_AGENT_MODELS[tier];
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  signal?.addEventListener('abort', abort, { once: true });

  const runEnv = gptAgentEnv(ctx.env, model, { url: env.LLM_PROXY_URL, key: env.LLM_PROXY_KEY });
  const scope = ctx.scope && {
    ...ctx.scope,
    unit: childScopeUnitName(ctx.scope.sessionScope, sessionScopeNonce()),
  };
  if (scope) {
    runEnv[SESSION_SCOPE_ENV] = scope.unit;
    runEnv[CLAUDE_BIN_ENV] = scope.claudeBin;
    runEnv[SESSIONS_SLICE_ENV] = SESSIONS_SLICE;
  }

  const runs = activeRuns.get(ctx.sessionId) ?? new Set();
  activeRuns.set(ctx.sessionId, runs.add(abortController));
  log.info('Starting GPT agent', { sessionId: ctx.sessionId, model });
  try {
    const run = queryFactory({
      prompt,
      options: {
        cwd: ctx.workingDir,
        model,
        env: runEnv,
        pathToClaudeCodeExecutable: scope?.launcherPath,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ctx.settingSources,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        // Nobody can answer it.
        disallowedTools: ['AskUserQuestion', 'ExitPlanMode'],
        persistSession: false,
        abortController,
      },
    });
    for await (const message of run) {
      const outcome = gptAgentOutcome(message);
      if (outcome) return outcome;
    }
    return { text: 'GPT agent ended without a result', isError: true };
  } catch (err) {
    if (abortController.signal.aborted) {
      return { text: 'GPT agent was interrupted', isError: true, cancelled: true };
    }
    log.warn('GPT agent failed', { sessionId: ctx.sessionId, error: toError(err).message });
    return { text: `GPT agent failed: ${toError(err).message}`, isError: true };
  } finally {
    signal?.removeEventListener('abort', abort);
    runs.delete(abortController);
    if (runs.size === 0 && activeRuns.get(ctx.sessionId) === runs) activeRuns.delete(ctx.sessionId);
    // Anything the run backgrounded dies with it.
    if (scope) void stopScope(scope.unit);
  }
}
