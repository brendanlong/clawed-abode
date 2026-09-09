import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  GITHUB_CREDENTIAL_HELPER_KEY,
  buildGithubCredentialHelper,
  getGithubTokenPath,
  writeGithubToken,
} from './github-credentials';

const execFileAsync = promisify(execFile);

const TOKEN = 'github_pat_integration_test_secret';

/** Isolate from the operator's real git config (and any OS keychain helper). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

let tmpRoot: string;
// A workspace path containing a single quote, to prove the helper quoting holds.
let workspacePath: string;
let clonePath: string;

function git(args: string[], input?: string): Promise<{ stdout: string }> {
  const child = execFileAsync('git', ['-C', clonePath, ...args], { env: GIT_ENV });
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  return child;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'github-credentials-'));
  workspacePath = path.join(tmpRoot, "we'ird workspace");
  clonePath = path.join(workspacePath, 'repo');
  await mkdir(clonePath, { recursive: true });
  await execFileAsync('git', ['-C', clonePath, 'init'], { env: GIT_ENV });

  const tokenPath = await writeGithubToken(workspacePath, TOKEN);
  await git(['config', GITHUB_CREDENTIAL_HELPER_KEY, buildGithubCredentialHelper(tokenPath)]);
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('github credential helper', () => {
  it('writes the token file mode 0600 in the workspace, beside the clone', async () => {
    const tokenPath = getGithubTokenPath(workspacePath);
    expect(await readFile(tokenPath, 'utf8')).toBe(TOKEN);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(path.dirname(clonePath)).toBe(path.dirname(tokenPath));
  });

  it('resolves github.com credentials from the token file', async () => {
    const { stdout } = await git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
    expect(stdout).toContain('username=x-access-token');
    expect(stdout).toContain(`password=${TOKEN}`);
  });

  it('keeps the token out of the persisted .git/config', async () => {
    const config = await readFile(path.join(clonePath, '.git', 'config'), 'utf8');
    expect(config).toContain(GITHUB_CREDENTIAL_HELPER_KEY.split('.').pop());
    expect(config).not.toContain(TOKEN);
  });

  it('does not erase the token when git rejects the credential', async () => {
    await git(
      ['credential', 'reject'],
      `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n\n`
    );
    expect(await readFile(getGithubTokenPath(workspacePath), 'utf8')).toBe(TOKEN);
  });
});
