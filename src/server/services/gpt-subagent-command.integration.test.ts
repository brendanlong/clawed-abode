import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureGptSubagentCommand } from './gpt-subagent-command';

vi.mock('./session-cgroup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-cgroup')>()),
  getClaudeBinary: async () => '/sdk/claude',
}));

const execFileAsync = promisify(execFile);

/** A stand-in CLI that prints the env and args it was run with, and its stdin. */
const FAKE_CLAUDE = `#!/bin/bash
env | grep -E '^(ANTHROPIC_|CLAUDE_CODE_)' | sort
echo "name:\${CLAUDE_CODE_SESSION_NAME-unset}"
printf 'arg:%s\\n' "$@"
[ -t 0 ] || sed 's/^/stdin:/'
`;

describe('GPT subagent command', () => {
  let dir: string;
  let command: string;
  const baseEnv = (): Record<string, string> => ({
    PATH: process.env.PATH ?? '',
    CLAWED_CLAUDE_BIN: join(dir, 'fake-claude'),
    CLAWED_LLM_PROXY_URL: 'http://127.0.0.1:4000',
    CLAWED_LLM_PROXY_KEY: 'sk-proxy',
    CLAWED_SETTING_SOURCES: 'user,project',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
    ANTHROPIC_API_KEY: 'sk-ant-api-secret',
    CLAUDE_CODE_SESSION_NAME: 'parent-session-ab12',
  });

  /** Run the command with the given env and stdin (closed when omitted). */
  const run = async (args: string[], env: Record<string, string>, stdin = '') => {
    const child = execFileAsync(command, args, { env: env as NodeJS.ProcessEnv });
    child.child.stdin!.end(stdin);
    return (await child).stdout;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-subagent-'));
    await writeFile(join(dir, 'fake-claude'), FAKE_CLAUDE);
    await chmod(join(dir, 'fake-claude'), 0o755);
    command = (await ensureGptSubagentCommand(dir))!.path;
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('runs the tier through the proxy with no Claude credentials', async () => {
    const stdout = await run(['sol', 'review the diff'], baseEnv());
    const lines = stdout.split('\n');
    expect(lines).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:4000');
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=sk-proxy');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=openai/gpt-6-luna');
    expect(stdout).not.toContain('secret');
    expect(lines).toContain('name:unset');
    expect(lines.filter((l) => l.startsWith('arg:'))).toEqual([
      'arg:-p',
      'arg:--model',
      'arg:openai/gpt-6.1-sol',
      'arg:--output-format',
      'arg:text',
      'arg:--permission-mode',
      'arg:bypassPermissions',
      'arg:--allow-dangerously-skip-permissions',
      'arg:--setting-sources',
      'arg:user,project',
      'arg:review the diff',
    ]);
  });

  it('passes a prompt on stdin through to the CLI', async () => {
    const stdout = await run(['astra'], baseEnv(), 'prove it\n');
    expect(stdout).toContain('arg:openai/gpt-6-astra');
    expect(stdout).toContain('stdin:prove it');
  });

  it('loads no settings files when the session loads none', async () => {
    const stdout = await run(['luna', 'x'], { ...baseEnv(), CLAWED_SETTING_SOURCES: '' });
    const args = stdout.split('\n').filter((l) => l.startsWith('arg:'));
    expect(args[args.indexOf('arg:--setting-sources') + 1]).toBe('arg:');
  });

  it('rejects an unknown tier and a session without a proxy', async () => {
    await expect(run(['opus', 'x'], baseEnv())).rejects.toMatchObject({ code: 2 });
    const { CLAWED_LLM_PROXY_URL: _url, ...noProxy } = baseEnv();
    await expect(run(['luna', 'x'], noProxy)).rejects.toThrow(/no LLM proxy/);
  });
});
