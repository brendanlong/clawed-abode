import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { GITHUB_CREDENTIAL_CONFIG_KEY, GITHUB_TOKEN_ENV } from '@/lib/git-credentials';
import { ensureGithubCredentialHelper } from './worktree-manager';

const execFileAsync = promisify(execFile);

const LEGACY_TOKEN = 'ghp_token_from_an_older_clone';

let workDir: string;
let repoDir: string;

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  return stdout;
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'worktree-manager-test-'));
  repoDir = path.join(workDir, 'repo');
  await execFileAsync('git', ['init', '-q', repoDir]);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('ensureGithubCredentialHelper', () => {
  it('replaces a helper that inlined the token with one that reads the environment', async () => {
    await git([
      'config',
      GITHUB_CREDENTIAL_CONFIG_KEY,
      `!f() { echo "password=${LEGACY_TOKEN}"; }; f`,
    ]);

    await ensureGithubCredentialHelper(repoDir);

    const config = await readFile(path.join(repoDir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(LEGACY_TOKEN);
    expect(config).toContain(GITHUB_TOKEN_ENV);
  });

  it('leaves a single helper behind when run repeatedly', async () => {
    await ensureGithubCredentialHelper(repoDir);
    await ensureGithubCredentialHelper(repoDir);

    const helpers = await git(['config', '--get-all', GITHUB_CREDENTIAL_CONFIG_KEY]);
    expect(helpers.trim().split('\n')).toHaveLength(1);
  });
});
