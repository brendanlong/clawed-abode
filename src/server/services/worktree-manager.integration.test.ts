import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { cloneRepo, getSessionWorkspacePath, getCurrentBranch } from './worktree-manager';
import { GITHUB_CREDENTIAL_HELPER_KEY, getGithubTokenPath } from './github-credentials';

const execFileAsync = promisify(execFile);

const TOKEN = 'github_pat_clone_test_secret';
const REPO_FULL_NAME = 'test-owner/test-repo';

let tmpRoot: string;
const sessionIds: string[] = [];

function newSessionId(): string {
  const id = `worktree-test-${uuid()}`;
  sessionIds.push(id);
  return id;
}

/**
 * `cloneRepo` always clones `https://github.com/<repo>.git`. Rewrite that prefix
 * to a local bare repo with `url.<base>.insteadOf` so the real clone runs offline
 * — which also means a token smuggled back into the URL would fail to match the
 * rewrite, and the clone would fail.
 */
async function createOriginAndRedirect(): Promise<void> {
  const originPath = path.join(tmpRoot, 'origin', `${REPO_FULL_NAME.split('/')[1]}.git`);
  const seedPath = path.join(tmpRoot, 'seed');
  await mkdir(originPath, { recursive: true });
  await mkdir(seedPath, { recursive: true });

  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originPath]);
  await execFileAsync('git', ['init', '--initial-branch=main', seedPath]);
  await writeFile(path.join(seedPath, 'README.md'), '# test\n');
  const seed = (args: string[]) => execFileAsync('git', ['-C', seedPath, ...args]);
  await seed(['add', '.']);
  await seed(['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-m', 'init']);
  await seed(['remote', 'add', 'origin', originPath]);
  await seed(['push', 'origin', 'main']);

  const gitConfig = path.join(tmpRoot, 'gitconfig');
  await writeFile(
    gitConfig,
    `[url "${path.join(tmpRoot, 'origin')}/"]\n\tinsteadOf = https://github.com/${REPO_FULL_NAME.split('/')[0]}/\n`
  );
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'worktree-manager-'));
  await createOriginAndRedirect();
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  await Promise.all(
    sessionIds.map((id) => rm(getSessionWorkspacePath(id), { recursive: true, force: true }))
  );
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_SYSTEM;
});

describe('cloneRepo', () => {
  it('checks out the branch under a session branch and tracks all remote branches', async () => {
    const sessionId = newSessionId();
    const { repoPath, workingDir } = await cloneRepo({
      sessionId,
      repoFullName: REPO_FULL_NAME,
      branch: 'main',
      githubToken: TOKEN,
    });

    expect(repoPath).toBe('test-repo');
    expect(workingDir).toBe(path.join(getSessionWorkspacePath(sessionId), 'test-repo'));
    expect(await getCurrentBranch(workingDir)).toContain(sessionId);
    expect(await readFile(path.join(workingDir, 'README.md'), 'utf8')).toBe('# test\n');

    const { stdout: refspec } = await execFileAsync('git', [
      '-C',
      workingDir,
      'config',
      '--get',
      'remote.origin.fetch',
    ]);
    expect(refspec.trim()).toBe('+refs/heads/*:refs/remotes/origin/*');
  });

  it('leaves the token nowhere in the clone, only in a mode-0600 workspace file', async () => {
    const sessionId = newSessionId();
    const { workingDir } = await cloneRepo({
      sessionId,
      repoFullName: REPO_FULL_NAME,
      branch: 'main',
      githubToken: TOKEN,
    });

    const config = await readFile(path.join(workingDir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);

    // The stored remote URL is the one git was given (`insteadOf` rewrites only
    // at connect time), so this is exactly what the clone put in the config.
    const { stdout: remoteUrl } = await execFileAsync('git', [
      '-C',
      workingDir,
      'config',
      '--get',
      'remote.origin.url',
    ]);
    expect(remoteUrl.trim()).toBe(`https://github.com/${REPO_FULL_NAME}.git`);

    const tokenPath = getGithubTokenPath(getSessionWorkspacePath(sessionId));
    expect(await readFile(tokenPath, 'utf8')).toBe(TOKEN);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  it('clones without a credential helper or token file when there is no token', async () => {
    const sessionId = newSessionId();
    const { workingDir } = await cloneRepo({
      sessionId,
      repoFullName: REPO_FULL_NAME,
      branch: 'main',
    });

    await expect(
      execFileAsync('git', ['-C', workingDir, 'config', '--get', GITHUB_CREDENTIAL_HELPER_KEY])
    ).rejects.toThrow();
    await expect(stat(getGithubTokenPath(getSessionWorkspacePath(sessionId)))).rejects.toThrow();
  });
});
