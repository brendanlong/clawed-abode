import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPushable } from '@/lib/pushable';
import {
  _setGptQueryFactory,
  hasActiveGptRuns,
  runGptAgent,
  type GptAgentContext,
} from './gpt-agent';

const mockEnv = vi.hoisted(() => ({
  LLM_PROXY_URL: 'http://proxy' as string | undefined,
  LLM_PROXY_KEY: 'sk-proxy' as string | undefined,
}));
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  env: mockEnv,
}));
const mockStopScope = vi.hoisted(() => vi.fn(async (_unit: string) => {}));
vi.mock('./session-cgroup', () => ({ sessionScopeNonce: () => 'n1', stopScope: mockStopScope }));

const ctx: GptAgentContext = {
  sessionId: 'sid',
  workingDir: '/w',
  settingSources: ['user', 'project'],
  env: { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat' },
  scope: {
    launcherPath: '/l.sh',
    claudeBin: '/claude',
    sessionScope: 'clawed-session-sid-abc.scope',
  },
};

/** A fake run whose messages the test pushes; records the options it was started with. */
function fakeRun() {
  const out = createPushable<SDKMessage>();
  const started: { prompt: string; options: Options }[] = [];
  _setGptQueryFactory((params) => {
    started.push(params);
    params.options.abortController?.signal.addEventListener('abort', () =>
      out.push({ type: 'never' } as unknown as SDKMessage)
    );
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of out.iterable) {
          if (params.options.abortController?.signal.aborted) throw new Error('aborted');
          yield message;
        }
      },
    } as unknown as Query;
  });
  return { out, started };
}

const result = (text: string) =>
  ({ type: 'result', subtype: 'success', is_error: false, result: text }) as unknown as SDKMessage;

beforeEach(() => vi.clearAllMocks());
afterEach(() => _setGptQueryFactory(null));

describe('runGptAgent', () => {
  it('runs the tier behind the proxy in a child of the session scope, and reaps it', async () => {
    const { out, started } = fakeRun();
    const run = runGptAgent(ctx, 'sol', 'Review the diff');
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(hasActiveGptRuns('sid')).toBe(true);

    const { prompt, options } = started[0];
    expect(prompt).toBe('Review the diff');
    expect(options).toMatchObject({
      cwd: '/w',
      model: 'openai/gpt-6.1-sol',
      settingSources: ['user', 'project'],
      pathToClaudeCodeExecutable: '/l.sh',
      persistSession: false,
    });
    expect(options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://proxy',
      CLAWED_SESSION_SCOPE: 'clawed-session-sid-abc-child-n1.scope',
      CLAWED_CLAUDE_BIN: '/claude',
    });
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');

    out.push({ type: 'assistant' } as unknown as SDKMessage);
    out.push(result('two bugs'));
    expect(await run).toEqual({ text: 'two bugs', isError: false });
    expect(hasActiveGptRuns('sid')).toBe(false);
    expect(mockStopScope).toHaveBeenCalledWith('clawed-session-sid-abc-child-n1.scope');
  });

  it('runs unscoped when the session is', async () => {
    const { out, started } = fakeRun();
    const run = runGptAgent({ ...ctx, scope: null }, 'luna', 'x');
    await vi.waitFor(() => expect(started).toHaveLength(1));
    expect(started[0].options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(started[0].options.env).not.toHaveProperty('CLAWED_SESSION_SCOPE');
    out.push(result('ok'));
    await run;
    expect(mockStopScope).not.toHaveBeenCalled();
  });

  it('stops the run when the caller aborts', async () => {
    const { started } = fakeRun();
    const controller = new AbortController();
    const run = runGptAgent(ctx, 'astra', 'prove it', controller.signal);
    await vi.waitFor(() => expect(started).toHaveLength(1));
    controller.abort();
    expect(await run).toEqual({ text: 'GPT agent was interrupted', isError: true });
    expect(hasActiveGptRuns('sid')).toBe(false);
  });

  it('reports a run that ends without a result as an error', async () => {
    const { out, started } = fakeRun();
    const run = runGptAgent(ctx, 'sol', 'x');
    await vi.waitFor(() => expect(started).toHaveLength(1));
    out.close();
    expect(await run).toEqual({ text: 'GPT agent ended without a result', isError: true });
  });
});
