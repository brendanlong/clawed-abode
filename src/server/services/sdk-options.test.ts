import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { MergedSessionSettings } from './settings-merger';
import { buildMcpServersRecord, buildSdkOptions } from './sdk-options';

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
vi.mock('./session-cgroup', () => ({
  getSessionScopeConfig: mockScopeConfig,
  sessionScopeNonce: () => 'nonce',
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
  ...overrides,
});

const waitForUserInput = vi.fn(async (): Promise<PermissionResult> => ({
  behavior: 'deny',
  message: 'no',
}));
const recordSanitization = vi.fn();

const build = (s: MergedSessionSettings, resumeId: string | null = null) =>
  buildSdkOptions({
    sessionId: 'sid',
    agentName: 'math-fable-d37e',
    workingDir: '/w',
    settings: s,
    resumeId,
    waitForUserInput,
    recordSanitization,
  });

beforeEach(() => vi.clearAllMocks());

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
    expect(withMcp.extraArgs).toEqual({ 'mcp-config': '/ws/sid/mcp-config.json' });
    expect(withMcp.mcpServers).toBeUndefined();
    expect(mockRemoveMcp).not.toHaveBeenCalled();

    const without = (await build(settings())).options;
    expect(without.extraArgs).toBeUndefined();
    expect(mockRemoveMcp).toHaveBeenCalledWith('sid');
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
      'mcp-config': '/ws/sid/mcp-config.json',
      settings: JSON.stringify({ advisorModel: 'claude-x' }),
    });
  });

  it('registers the agent name for cross-session messaging', async () => {
    const { options } = await build(settings());
    expect(options.env).toMatchObject({ CLAUDE_CODE_SESSION_NAME: 'math-fable-d37e' });
  });

  it('wires the systemd scope launcher and returns the unit for the runner to record', async () => {
    mockScopeConfig.mockResolvedValueOnce({ launcherPath: '/l.sh', claudeBin: '/claude' });
    const { options, sessionScope } = await build(settings());
    expect(options.pathToClaudeCodeExecutable).toBe('/l.sh');
    expect(sessionScope).toMatch(/nonce/);
    expect(options.env).toMatchObject({
      CLAWED_SESSION_SCOPE: sessionScope,
      CLAWED_CLAUDE_BIN: '/claude',
    });
  });

  it('leaves the scope unset when cgroup scoping is unavailable', async () => {
    const { options, sessionScope } = await build(settings());
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
