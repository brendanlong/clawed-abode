import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGptSubagentCommand } from './gpt-subagent-command';

const execFileAsync = promisify(execFile);

/** A stand-in CLI that prints the env and args it was run with, and its stdin. */
const FAKE_CLAUDE = `#!/bin/bash
env | grep -E '^(ANTHROPIC_|CLAUDE_CODE_)' | sort
printf 'arg:%s\\n' "$@"
[ -t 0 ] || sed 's/^/stdin:/'
`;

describe('GPT subagent command', () => {
  let dir: string;
  let command: string;
  const baseEnv = () => ({
    PATH: process.env.PATH ?? '',
    CLAWED_CLAUDE_BIN: join(dir, 'fake-claude'),
    CLAWED_LLM_PROXY_URL: 'http://127.0.0.1:4000',
    CLAWED_LLM_PROXY_KEY: 'sk-proxy',
    CLAWED_SETTING_SOURCES: 'user,project',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret',
    ANTHROPIC_API_KEY: 'sk-ant-api-secret',
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gpt-subagent-'));
    await writeFile(join(dir, 'fake-claude'), FAKE_CLAUDE);
    await chmod(join(dir, 'fake-claude'), 0o755);
    command = (await ensureGptSubagentCommand(dir))!;
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('runs the tier through the proxy with no Claude credentials', async () => {
    const run = execFileAsync(command, ['sol', 'review the diff'], { env: baseEnv() });
    run.child.stdin!.end();
    const { stdout } = await run;
    const lines = stdout.split('\n');
    expect(lines).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:4000');
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=sk-proxy');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=openai/gpt-6-luna');
    expect(stdout).not.toContain('secret');
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
    const run = execFileAsync(command, ['astra'], { env: baseEnv() });
    run.child.stdin!.end('prove it\n');
    const { stdout } = await run;
    expect(stdout).toContain('arg:openai/gpt-6-astra');
    expect(stdout).toContain('stdin:prove it');
  });

  it('rejects an unknown tier and a session without a proxy', async () => {
    await expect(execFileAsync(command, ['opus', 'x'], { env: baseEnv() })).rejects.toMatchObject({
      code: 2,
    });
    const { CLAWED_LLM_PROXY_URL: _url, ...noProxy } = baseEnv();
    await expect(execFileAsync(command, ['luna', 'x'], { env: noProxy })).rejects.toThrow(
      /no LLM proxy/
    );
  });
});
