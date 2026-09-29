import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import { resetEnvCache } from '@/lib/env';
import { GITHUB_TOKEN_ENV } from '@/lib/git-credentials';
import { cloneRepo, getSessionWorkspacePath, removeWorkspace } from './worktree-manager';

const execFileAsync = promisify(execFile);

const TOKEN = 'ghp_test_token_value';

let workDir: string;

/**
 * Env for the fixture's own git commands: no host config, and an identity, so
 * the seed commit works on a CI runner that has neither.
 */
const fixtureEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function fixtureGit(args: string[]): Promise<void> {
  await execFileAsync('git', args, { env: fixtureEnv });
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'worktree-manager-test-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('cloneRepo', () => {
  // Serve github.com URLs from a local bare repo, so the real clone runs offline.
  const sessionId = `worktree-manager-test-${uuid()}`;
  let originalGlobalConfig: string | undefined;
  let originalToken: string | undefined;

  beforeEach(async () => {
    const originDir = path.join(workDir, 'owner', 'repo.git');
    await fixtureGit(['init', '-q', '--bare', '-b', 'main', originDir]);
    const seed = path.join(workDir, 'seed');
    await fixtureGit(['clone', '-q', originDir, seed]);
    await writeFile(path.join(seed, 'README.md'), '# seed\n');
    await fixtureGit(['-C', seed, 'add', '.']);
    await fixtureGit(['-C', seed, 'commit', '-qm', 'seed']);
    await fixtureGit(['-C', seed, 'push', '-q', 'origin', 'main']);

    const globalConfig = path.join(workDir, 'gitconfig');
    await writeFile(
      globalConfig,
      `[url "${path.join(workDir)}/"]\n\tinsteadOf = https://github.com/\n`
    );
    originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = TOKEN;
    resetEnvCache();
  });

  afterAll(async () => {
    process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    resetEnvCache();
    await removeWorkspace(sessionId);
  });

  it('leaves the token in neither the recorded remote nor the clone config', async () => {
    const { workingDir } = await cloneRepo({
      sessionId,
      repoFullName: 'owner/repo',
      branch: 'main',
    });

    expect(workingDir).toBe(path.join(getSessionWorkspacePath(sessionId), 'repo'));
    const config = await readFile(path.join(workingDir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).toContain(GITHUB_TOKEN_ENV);
    const { stdout: remote } = await execFileAsync(
      'git',
      ['-C', workingDir, 'config', '--get', 'remote.origin.url'],
      { env: fixtureEnv }
    );
    expect(remote).not.toContain(TOKEN);
  });
});
