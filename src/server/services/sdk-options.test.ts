import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MergedSessionSettings } from './settings-merger';
import { buildMcpServersRecord, buildSdkOptions } from './sdk-options';
import { createSessionState } from './session-state';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
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
const mockPersistScope = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./session-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-state')>()),
  persistSessionScope: mockPersistScope,
}));
vi.mock('./input-sanitizer', () => ({ sanitizeToolOutputHook: vi.fn() }));

const settings = (overrides: Partial<MergedSessionSettings> = {}): MergedSessionSettings => ({
  systemPrompt: 'prompt',
  envVars: [],
  mcpServers: [],
  claudeModel: undefined,
  advisorModel: null,
  claudeApiKey: undefined,
  settingSources: ['project'],
  customSystemPrompt: null,
  globalSettings: {
    systemPromptOverride: null,
    systemPromptOverrideEnabled: false,
    systemPromptAppend: null,
    claudeModel: null,
    advisorModel: null,
    claudeApiKey: null,
    settingSources: { user: false, project: true, local: false },
    envVars: [],
    mcpServers: [],
  },
  ...overrides,
});

const build = (s: MergedSessionSettings, shouldResume = false) => {
  const state = createSessionState('/w', []);
  return buildSdkOptions({
    sessionId: 'sid',
    workingDir: '/w',
    settings: s,
    shouldResume,
    state,
  }).then((options) => ({ options, state }));
};

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
  it('uses sessionId for a fresh session and resume for one with history, keeping cwd', async () => {
    const fresh = (await build(settings())).options;
    expect(fresh).toMatchObject({
      sessionId: 'sid',
      cwd: '/w',
      permissionMode: 'bypassPermissions',
    });
    expect(fresh.resume).toBeUndefined();
    const resumed = (await build(settings(), true)).options;
    expect(resumed.resume).toBe('sid');
    expect(resumed.sessionId).toBeUndefined();
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

  it('wires the systemd scope launcher and records the unit before the query exists', async () => {
    mockScopeConfig.mockResolvedValueOnce({ launcherPath: '/l.sh', claudeBin: '/claude' });
    const { options, state } = await build(settings());
    expect(options.pathToClaudeCodeExecutable).toBe('/l.sh');
    expect(state.sessionScope).toMatch(/nonce/);
    expect(mockPersistScope).toHaveBeenCalledWith('sid', state.sessionScope);
    expect(options.env).toMatchObject({
      CLAWED_SESSION_SCOPE: state.sessionScope,
      CLAWED_CLAUDE_BIN: '/claude',
    });
  });

  it('canUseTool parks interactive tools on state and allows everything else', async () => {
    const { options, state } = await build(settings());
    type ToolContext = Parameters<NonNullable<typeof options.canUseTool>>[2];
    const ctx = (toolUseID: string) =>
      ({ toolUseID, signal: new AbortController().signal }) as unknown as ToolContext;
    const allowed = await options.canUseTool!('Bash', { command: 'ls' }, ctx('t1'));
    expect(allowed).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });

    const parked = options.canUseTool!('AskUserQuestion', { questions: [] }, ctx('t2'));
    expect(state.pendingInput).toMatchObject({ toolName: 'AskUserQuestion', toolUseId: 't2' });
    state.pendingInput!.resolve({ behavior: 'deny', message: 'no' });
    expect(await parked).toEqual({ behavior: 'deny', message: 'no' });
  });
});
