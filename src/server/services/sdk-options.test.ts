import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { MergedSessionSettings } from './settings-merger';
import { builtinToolsPrompt } from '@/lib/builtin-tools';
import { buildLiveMcpServersRecord, buildMcpServersRecord, buildSdkOptions } from './sdk-options';

vi.mock('./agent-env', () => ({
  buildAgentEnv: vi.fn(async (vars: { name: string; value: string }[]) => ({
    PATH: '/bin',
    ...Object.fromEntries(vars.map((v) => [v.name, v.value])),
  })),
}));
const mockWriteMcp = vi.hoisted(() => vi.fn(async (id: string) => `/ws/${id}/mcp-config.json`));
const mockRemoveMcp = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./mcp-config-file', () => ({
  writeSessionMcpConfig: mockWriteMcp,
  removeSessionMcpConfig: mockRemoveMcp,
}));
const mockScopeConfig = vi.hoisted(() =>
  vi.fn(async () => null as null | { launcherPath: string; claudeBin: string })
);
const mockApplySliceLimits = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./session-cgroup', () => ({
  getSessionScopeConfig: mockScopeConfig,
  ensureSessionsSliceLimits: mockApplySliceLimits,
  sessionScopeNonce: () => 'nonce',
}));
const mockEnv = vi.hoisted(() => ({
  LLM_PROXY_URL: undefined as string | undefined,
  LLM_PROXY_KEY: undefined as string | undefined,
}));
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  env: mockEnv,
}));
vi.mock('./gpt-subagent-command', () => ({
  ensureGptSubagentCommand: vi.fn(async () => '/home/u/.clawed/gpt-subagent'),
}));
vi.mock('./input-sanitizer', () => ({ sanitizeToolOutputHook: vi.fn() }));
const mockScheduleRefresh = vi.hoisted(() => vi.fn());
vi.mock('./session-branch-pr', () => ({ scheduleBranchPrRefresh: mockScheduleRefresh }));

const settings = (overrides: Partial<MergedSessionSettings> = {}): MergedSessionSettings => ({
  systemPrompt: 'prompt',
  envVars: [],
  mcpServers: [],
  claudeModel: undefined,
  advisorModel: null,
  claudeApiKey: undefined,
  settingSources: ['project'],
  builtinTools: null,
  ...overrides,
});

const waitForUserInput = vi.fn(async (): Promise<PermissionResult> => ({
  behavior: 'deny',
  message: 'no',
}));
const recordSanitization = vi.fn();

const build = (
  s: MergedSessionSettings,
  resumeId: string | null = null,
  agentName: string | null = 'math-fable-d37e',
  createdBySessionId: string | null = null
) =>
  buildSdkOptions({
    sessionId: 'sid',
    agentName,
    sessionNameIsDefault: true,
    createdBySessionId,
    workingDir: '/w',
    settings: s,
    resumeId,
    waitForUserInput,
    recordSanitization,
  });

function appendedPrompt(options: { systemPrompt?: unknown }): string {
  return (options.systemPrompt as { append: string }).append;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.LLM_PROXY_URL = undefined;
  mockEnv.LLM_PROXY_KEY = undefined;
});

describe('buildMcpServersRecord', () => {
  it('maps stdio and http/sse servers to the SDK shape, omitting empty maps', () => {
    expect(buildMcpServersRecord([])).toBeUndefined();
    expect(
      buildMcpServersRecord([
        { name: 's', type: 'stdio', command: 'node', args: ['a.js'], env: { K: 'v' } },
        { name: 'b', type: 'stdio', command: 'bare' },
        { name: 'h', type: 'sse', url: 'https://x', headers: { A: 'b' } },
      ])
    ).toEqual({
      s: { command: 'node', args: ['a.js'], env: { K: 'v' } },
      b: { command: 'bare' },
      h: { type: 'sse', url: 'https://x', headers: { A: 'b' } },
    });
  });
});

describe('buildSdkOptions', () => {
  it('uses sessionId for a fresh session and resumes the given conversation otherwise, keeping cwd', async () => {
    const fresh = (await build(settings())).options;
    expect(fresh).toMatchObject({
      sessionId: 'sid',
      cwd: '/w',
      permissionMode: 'bypassPermissions',
    });
    expect(fresh.resume).toBeUndefined();
    const resumed = (await build(settings(), 'post-clear-id')).options;
    expect(resumed.resume).toBe('post-clear-id');
    expect(resumed.sessionId).toBeUndefined();
  });

  // The SDK's systemPrompt.snapshot default flipped to true in 0.3.266: a recorded
  // prompt is replayed verbatim through every resume, so an edited system prompt
  // would never reach a session that has history. doc/settings.md promises it takes
  // effect on Stop->Start, which only holds while we opt out explicitly.
  it('renders the appended system prompt fresh rather than letting the SDK record it', async () => {
    for (const resumeId of [null, 'sid']) {
      const { options } = await build(settings(), resumeId);
      expect(options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'prompt',
        snapshot: false,
      });
    }
  });

  it('passes MCP servers via a config file path and removes a stale file when there are none', async () => {
    const withMcp = (
      await build(settings({ mcpServers: [{ name: 's', type: 'stdio', command: 'node' }] }))
    ).options;
    expect(withMcp.extraArgs).toEqual({
      'replay-user-messages': null,
      'mcp-config': '/ws/sid/mcp-config.json',
    });
    expect(withMcp.mcpServers).toBeUndefined();
    expect(mockRemoveMcp).not.toHaveBeenCalled();

    const without = (await build(settings())).options;
    expect(without.extraArgs).toEqual({ 'replay-user-messages': null });
    expect(mockRemoveMcp).toHaveBeenCalledWith('sid');
  });

  it('appends the built-in tools prompt only when the tools are enabled', async () => {
    const append = async (s: MergedSessionSettings) => {
      const { systemPrompt } = (await build(s)).options;
      return typeof systemPrompt === 'object' && 'append' in systemPrompt
        ? systemPrompt.append
        : undefined;
    };
    expect(await append(settings({ builtinTools: 'basic' }))).toBe(
      `prompt\n\n${builtinToolsPrompt('basic', true)}`
    );
    expect(await append(settings({ builtinTools: null }))).toBe('prompt');
  });

  it('gives a session another agent created the basic tools even when management is on', async () => {
    const { options } = await build(settings({ builtinTools: 'manage' }), null, null, 'creator');
    const { systemPrompt } = options;
    expect(
      typeof systemPrompt === 'object' && 'append' in systemPrompt && systemPrompt.append
    ).toBe(`prompt\n\n${builtinToolsPrompt('basic', true)}`);
  });

  it('registers the built-in server in-process only when enabled, keeping configured servers in the file', async () => {
    const enabled = await build(
      settings({
        builtinTools: 'basic',
        mcpServers: [{ name: 's', type: 'stdio', command: 'node' }],
      })
    );
    expect(Object.keys(enabled.options.mcpServers ?? {})).toEqual(['clawed-abode']);
    expect(enabled.options.mcpServers?.['clawed-abode']).toMatchObject({ type: 'sdk' });
    expect(enabled.builtinMcpServer).toBe(enabled.options.mcpServers?.['clawed-abode']);
    expect(enabled.options.extraArgs?.['mcp-config']).toBe('/ws/sid/mcp-config.json');

    const disabled = await build(settings({ builtinTools: null }));
    expect(disabled.options.mcpServers).toBeUndefined();
    expect(disabled.builtinMcpServer).toBeNull();
  });

  it('adds the advisor settings arg only when an advisor model is set, alongside the MCP arg', async () => {
    const { options } = await build(
      settings({
        advisorModel: 'claude-x',
        claudeModel: 'opus',
        mcpServers: [{ name: 's', type: 'stdio', command: 'node' }],
      })
    );
    expect(options.model).toBe('opus');
    expect(options.extraArgs).toEqual({
      'replay-user-messages': null,
      'mcp-config': '/ws/sid/mcp-config.json',
      settings: JSON.stringify({ advisorModel: 'claude-x' }),
    });
  });

  it('sends a proxied model through the proxy without any Claude credential or advisor', async () => {
    mockEnv.LLM_PROXY_URL = 'http://proxy';
    mockEnv.LLM_PROXY_KEY = 'sk-proxy';
    const { options } = await build(
      settings({
        claudeModel: 'openai/gpt-6-astra',
        advisorModel: 'claude-x',
        envVars: [
          { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat-secret' },
          { name: 'ANTHROPIC_BASE_URL', value: 'http://elsewhere' },
        ],
      })
    );
    expect(options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://proxy',
      ANTHROPIC_AUTH_TOKEN: 'sk-proxy',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'openai/gpt-6-astra',
    });
    expect(options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(options.model).toBe('openai/gpt-6-astra');
    expect(options.extraArgs).not.toHaveProperty('settings');
  });

  it('refuses a proxied model when no proxy is configured', async () => {
    await expect(build(settings({ claudeModel: 'openai/gpt-6-astra' }))).rejects.toThrow(
      /LLM_PROXY_URL/
    );
  });

  it('leaves a Claude model off the proxy even when one is configured', async () => {
    mockEnv.LLM_PROXY_URL = 'http://proxy';
    const { options } = await build(settings({ claudeModel: 'opus' }));
    expect(options.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });

  it('offers GPT subagents to a Claude session when a proxy is configured', async () => {
    mockEnv.LLM_PROXY_URL = 'http://proxy';
    mockEnv.LLM_PROXY_KEY = 'sk-proxy';
    const { options } = await build(settings({ claudeModel: 'opus' }));
    expect(options.env).toMatchObject({
      CLAWED_LLM_PROXY_URL: 'http://proxy',
      CLAWED_LLM_PROXY_KEY: 'sk-proxy',
      CLAWED_SETTING_SOURCES: 'project',
    });
    expect(appendedPrompt(options)).toContain('/home/u/.clawed/gpt-subagent');
  });

  it('offers no GPT subagents without a proxy or to a proxied session', async () => {
    const { options: noProxy } = await build(settings({ claudeModel: 'opus' }));
    expect(noProxy.env).not.toHaveProperty('CLAWED_LLM_PROXY_URL');
    expect(appendedPrompt(noProxy)).not.toContain('gpt-subagent');

    mockEnv.LLM_PROXY_URL = 'http://proxy';
    const { options: proxied } = await build(settings({ claudeModel: 'openai/gpt-6-astra' }));
    expect(proxied.env).not.toHaveProperty('CLAWED_LLM_PROXY_URL');
    expect(appendedPrompt(proxied)).not.toContain('gpt-subagent');
  });

  it('echoes injected user messages so messages from other sessions can be persisted', async () => {
    const { options } = await build(settings());
    expect(options.extraArgs).toMatchObject({ 'replay-user-messages': null });
  });

  it('registers the agent name for cross-session messaging', async () => {
    const { options } = await build(settings());
    expect(options.env).toMatchObject({ CLAUDE_CODE_SESSION_NAME: 'math-fable-d37e' });
    const unnamed = (await build(settings(), null, null)).options;
    expect(unnamed.env).not.toHaveProperty('CLAUDE_CODE_SESSION_NAME');
  });

  it('wires the systemd scope launcher and returns the unit for the runner to record', async () => {
    mockScopeConfig.mockResolvedValueOnce({ launcherPath: '/l.sh', claudeBin: '/claude' });
    const { options, sessionScope } = await build(settings());
    expect(options.pathToClaudeCodeExecutable).toBe('/l.sh');
    expect(sessionScope).toMatch(/nonce/);
    expect(options.env).toMatchObject({
      CLAWED_SESSION_SCOPE: sessionScope,
      CLAWED_CLAUDE_BIN: '/claude',
      CLAWED_SESSIONS_SLICE: 'clawed-sessions.slice',
    });
    expect(mockApplySliceLimits).toHaveBeenCalled();
  });

  it('leaves the scope unset when cgroup scoping is unavailable', async () => {
    mockApplySliceLimits.mockClear();
    const { options, sessionScope } = await build(settings());
    expect(mockApplySliceLimits).not.toHaveBeenCalled();
    expect(sessionScope).toBeNull();
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('canUseTool hands interactive tools to waitForUserInput and allows everything else', async () => {
    const { options } = await build(settings());
    type ToolContext = Parameters<NonNullable<typeof options.canUseTool>>[2];
    const ctx = (toolUseID: string) =>
      ({ toolUseID, signal: new AbortController().signal }) as unknown as ToolContext;
    const allowed = await options.canUseTool!('Bash', { command: 'ls' }, ctx('t1'));
    expect(allowed).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(waitForUserInput).not.toHaveBeenCalled();

    const answered = await options.canUseTool!('AskUserQuestion', { questions: [] }, ctx('t2'));
    expect(waitForUserInput).toHaveBeenCalledWith({
      toolName: 'AskUserQuestion',
      toolUseId: 't2',
      input: { questions: [] },
    });
    expect(answered).toEqual({ behavior: 'deny', message: 'no' });
  });

  it('schedules a branch/PR refresh after a tool call that may change them', async () => {
    const { options } = await build(settings());
    const hooks = options.hooks!.PostToolUse![0].hooks;
    const runHooks = (tool_name: string, command: string) =>
      Promise.all(
        hooks.map((hook) =>
          hook(
            {
              hook_event_name: 'PostToolUse',
              tool_name,
              tool_input: { command },
              tool_response: '',
              tool_use_id: 't1',
              session_id: 'sid',
              transcript_path: '',
              cwd: '/w',
            },
            't1',
            { signal: new AbortController().signal }
          )
        )
      );

    await runHooks('Bash', 'git status');
    expect(mockScheduleRefresh).not.toHaveBeenCalled();

    await runHooks('Bash', 'git push -u origin HEAD');
    expect(mockScheduleRefresh).toHaveBeenCalledWith('sid', '/w');

    mockScheduleRefresh.mockClear();
    await runHooks('mcp__GitHub__merge_pull_request', '');
    expect(mockScheduleRefresh).toHaveBeenCalledWith('sid', '/w');
  });
});

describe('buildLiveMcpServersRecord', () => {
  it('keeps the bound built-in server alongside the configured ones so a live update never drops it', async () => {
    const { builtinMcpServer } = await build(settings({ builtinTools: 'manage' }));
    const servers = [{ name: 's', type: 'stdio' as const, command: 'node' }];

    expect(buildLiveMcpServersRecord(servers, builtinMcpServer)).toEqual({
      s: { command: 'node' },
      'clawed-abode': builtinMcpServer,
    });
    expect(buildLiveMcpServersRecord([], null)).toEqual({});
  });
});
