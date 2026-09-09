import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  GITHUB_CREDENTIAL_HELPER_KEY,
  buildGithubCredentialHelper,
  getGithubTokenPath,
  githubCredentialArgs,
  installGithubCredentialHelper,
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

const FILL_REQUEST = 'protocol=https\nhost=github.com\n\n';

let tmpRoot: string;
/** A workspace path containing a single quote, to exercise the helper quoting. */
let workspacePath: string;
let clonePath: string;

function git(args: string[], input?: string): Promise<{ stdout: string }> {
  const child = execFileAsync('git', ['-C', clonePath, ...args], { env: GIT_ENV });
  if (input !== undefined) child.child.stdin?.end(input);
  return child;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'github-credentials-'));
  workspacePath = path.join(tmpRoot, "we'ird workspace");
  clonePath = path.join(workspacePath, 'repo');
  await mkdir(clonePath, { recursive: true });
  await execFileAsync('git', ['-C', clonePath, 'init'], { env: GIT_ENV });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('github credential helper', () => {
  it('writes the token mode 0600 beside the clone, not inside it', async () => {
    const tokenPath = await writeGithubToken(workspacePath, TOKEN);

    expect(tokenPath).toBe(getGithubTokenPath(workspacePath));
    expect(path.dirname(tokenPath)).toBe(path.dirname(clonePath));
    expect(await readFile(tokenPath, 'utf8')).toBe(TOKEN);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  it('resolves github.com credentials from the token file once persisted', async () => {
    await installGithubCredentialHelper(clonePath, await writeGithubToken(workspacePath, TOKEN));

    const { stdout } = await git(['credential', 'fill'], FILL_REQUEST);
    expect(stdout).toContain('username=x-access-token');
    expect(stdout).toContain(`password=${TOKEN}`);
  });

  it('resolves credentials when installed for a single command, as the clone does', async () => {
    const tokenPath = await writeGithubToken(workspacePath, TOKEN);

    const { stdout } = await git(
      [...githubCredentialArgs(tokenPath), 'credential', 'fill'],
      FILL_REQUEST
    );
    expect(stdout).toContain(`password=${TOKEN}`);
  });

  it('persists only the token path, never the token', async () => {
    await installGithubCredentialHelper(clonePath, await writeGithubToken(workspacePath, TOKEN));

    const { stdout } = await git(['config', '--get', GITHUB_CREDENTIAL_HELPER_KEY]);
    expect(stdout.trim()).toBe(buildGithubCredentialHelper(getGithubTokenPath(workspacePath)));

    const config = await readFile(path.join(clonePath, '.git', 'config'), 'utf8');
    expect(config).toContain('[credential "https://github.com"]');
    expect(config).not.toContain(TOKEN);
  });

  it('replaces an inline-token helper left by a pre-#498 clone', async () => {
    await git([
      'config',
      GITHUB_CREDENTIAL_HELPER_KEY,
      `!f() { echo "username=x-access-token"; echo "password=${TOKEN}"; }; f`,
    ]);

    await installGithubCredentialHelper(clonePath, await writeGithubToken(workspacePath, TOKEN));

    const config = await readFile(path.join(clonePath, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    const { stdout } = await git(['credential', 'fill'], FILL_REQUEST);
    expect(stdout).toContain(`password=${TOKEN}`);
  });

  it('declines instead of supplying an empty password when the token file is gone', async () => {
    const tokenPath = await writeGithubToken(workspacePath, TOKEN);
    await installGithubCredentialHelper(clonePath, tokenPath);
    await rm(tokenPath);

    // A helper that answered with an empty password would leave git believing it
    // had a credential; declining lets git report that it has none.
    await expect(git(['credential', 'fill'], FILL_REQUEST)).rejects.toThrow(
      /could not read Username/
    );
  });
});
