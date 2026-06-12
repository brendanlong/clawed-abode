import { describe, it, expect } from 'vitest';
import { buildMcpConfig, buildClaudeArgs, buildSessionEnvVars } from './claude-command';

describe('buildMcpConfig', () => {
  it('returns null when no servers configured', () => {
    expect(buildMcpConfig([])).toBeNull();
  });

  it('converts stdio servers to .mcp.json format', () => {
    const config = buildMcpConfig([
      {
        name: 'memory',
        type: 'stdio',
        command: 'npx',
        args: ['@anthropic/mcp-server-memory'],
        env: { API_KEY: 'secret' },
      },
    ]);
    expect(config).toEqual({
      mcpServers: {
        memory: {
          command: 'npx',
          args: ['@anthropic/mcp-server-memory'],
          env: { API_KEY: 'secret' },
        },
      },
    });
  });

  it('omits empty args and env for stdio servers', () => {
    const config = buildMcpConfig([{ name: 'simple', type: 'stdio', command: 'mcp-server' }]);
    expect(config?.mcpServers['simple']).toEqual({ command: 'mcp-server' });
  });

  it('converts http and sse servers with headers', () => {
    const config = buildMcpConfig([
      { name: 'api', type: 'http', url: 'https://example.com/mcp', headers: { Auth: 'token' } },
      { name: 'events', type: 'sse', url: 'https://example.com/sse' },
    ]);
    expect(config).toEqual({
      mcpServers: {
        api: { type: 'http', url: 'https://example.com/mcp', headers: { Auth: 'token' } },
        events: { type: 'sse', url: 'https://example.com/sse' },
      },
    });
  });
});

describe('buildClaudeArgs', () => {
  const sessionId = '0a4e8c1e-7c2c-4b6e-bd62-0f5276c9a1de';

  it('uses --session-id and includes initial prompt on first launch', () => {
    const args = buildClaudeArgs({
      sessionId,
      resume: false,
      model: 'opus',
      systemPromptAppend: 'Extra instructions',
      mcpConfigPath: '/tmp/mcp.json',
      initialPrompt: 'Fix the bug',
    });
    expect(args).toEqual([
      '--session-id',
      sessionId,
      '--model',
      'opus',
      '--append-system-prompt',
      'Extra instructions',
      '--mcp-config',
      '/tmp/mcp.json',
      '--dangerously-skip-permissions',
      'Fix the bug',
    ]);
  });

  it('uses --resume and drops the initial prompt when resuming', () => {
    const args = buildClaudeArgs({
      sessionId,
      resume: true,
      initialPrompt: 'Fix the bug',
    });
    expect(args).toEqual(['--resume', sessionId, '--dangerously-skip-permissions']);
  });

  it('omits optional flags that are not set', () => {
    const args = buildClaudeArgs({ sessionId, resume: false });
    expect(args).toEqual(['--session-id', sessionId, '--dangerously-skip-permissions']);
  });
});

describe('buildSessionEnvVars', () => {
  it('applies the API key before user env vars so they can override it', () => {
    const env = buildSessionEnvVars(
      [
        { name: 'FOO', value: 'bar' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'per-repo-token' },
      ],
      'global-token'
    );
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'per-repo-token', FOO: 'bar' });
  });

  it('uses the global API key when no env var overrides it', () => {
    const env = buildSessionEnvVars([{ name: 'FOO', value: 'bar' }], 'global-token');
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'global-token', FOO: 'bar' });
  });

  it('returns only env vars when no API key configured', () => {
    expect(buildSessionEnvVars([{ name: 'FOO', value: 'bar' }], null)).toEqual({ FOO: 'bar' });
  });
});
