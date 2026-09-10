import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import { GITHUB_CREDENTIAL_CONFIG_KEY, GITHUB_TOKEN_ENV } from '@/lib/git-credentials';
import {
  cloneRepo,
  ensureGithubCredentialHelper,
  getSessionWorkspacePath,
  removeWorkspace,
} from './worktree-manager';

const execFileAsync = promisify(execFile);

const LEGACY_TOKEN = 'ghp_token_from_an_older_clone';
const TOKEN = 'ghp_test_token_value';

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

describe('cloneRepo', () => {
  // Serve github.com URLs from a local bare repo, so the real clone runs offline.
  const sessionId = `worktree-manager-test-${uuid()}`;
  let originalGlobalConfig: string | undefined;

  beforeEach(async () => {
    const originDir = path.join(workDir, 'owner', 'repo.git');
    await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', originDir]);
    const seed = path.join(workDir, 'seed');
    await execFileAsync('git', ['clone', '-q', originDir, seed]);
    await writeFile(path.join(seed, 'README.md'), '# seed\n');
    await execFileAsync('git', ['-C', seed, 'add', '.']);
    await execFileAsync('git', ['-C', seed, 'commit', '-qm', 'seed']);
    await execFileAsync('git', ['-C', seed, 'push', '-q', 'origin', 'main']);

    const globalConfig = path.join(workDir, 'gitconfig');
    await writeFile(
      globalConfig,
      `[url "${path.join(workDir)}/"]\n\tinsteadOf = https://github.com/\n`
    );
    originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });

  afterAll(async () => {
    process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
    await removeWorkspace(sessionId);
  });

  it('leaves the token in neither the recorded remote nor the clone config', async () => {
    const { workingDir } = await cloneRepo({
      sessionId,
      repoFullName: 'owner/repo',
      branch: 'main',
      githubToken: TOKEN,
    });

    expect(workingDir).toBe(path.join(getSessionWorkspacePath(sessionId), 'repo'));
    const config = await readFile(path.join(workingDir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).toContain(GITHUB_TOKEN_ENV);
    const { stdout: remote } = await execFileAsync('git', [
      '-C',
      workingDir,
      'remote',
      'get-url',
      'origin',
    ]);
    expect(remote).not.toContain(TOKEN);
  });
});
