import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  GITHUB_CREDENTIAL_CONFIG_KEY,
  GITHUB_CREDENTIAL_HELPER,
  GITHUB_TOKEN_ENV,
  githubCredentialEnv,
} from './git-credentials';

const execFileAsync = promisify(execFile);

const TOKEN = 'ghp_test_token_value';
/** Stands in for a host-wide helper like `gh auth git-credential`. */
const HOST_HELPER_CONFIG =
  '[credential "https://github.com"]\n' +
  '\thelper = "!f() { echo username=host-account; echo password=host-token; }; f"\n';

let workDir: string;
let hostConfigPath: string;

interface GitEnvOptions {
  /** Config file to expose as git's global config; none by default. */
  globalConfig?: string;
  env?: Record<string, string>;
}

/** Env that isolates git from the host's real user/system config and token. */
function gitEnv({ globalConfig, env }: GitEnvOptions = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [GITHUB_TOKEN_ENV]: undefined,
    GIT_CONFIG_GLOBAL: globalConfig ?? '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...env,
  };
}

async function makeRepo(name: string): Promise<string> {
  const repoDir = path.join(workDir, name);
  await execFileAsync('git', ['init', '-q', repoDir], { env: gitEnv() });
  return repoDir;
}

function repoConfigPath(repoDir: string): string {
  return path.join(repoDir, '.git', 'config');
}

/** Ask git for github.com credentials the way `clone`/`fetch`/`push` do. */
async function credentialFill(
  repoDir: string,
  options: GitEnvOptions = {}
): Promise<{ stdout: string; failed: boolean }> {
  const child = execFile('git', ['-C', repoDir, 'credential', 'fill'], { env: gitEnv(options) });
  child.stdin!.end('protocol=https\nhost=github.com\n\n');
  const chunks: string[] = [];
  child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve(exitCode));
  });
  return { stdout: chunks.join(''), failed: code !== 0 };
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'git-credentials-test-'));
  hostConfigPath = path.join(workDir, 'gitconfig-host');
  await writeFile(hostConfigPath, HOST_HELPER_CONFIG);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('githubCredentialEnv', () => {
  it('supplies the token to git while leaving no secret in any config file', async () => {
    const repoDir = await makeRepo('injected');

    const { stdout } = await credentialFill(repoDir, {
      globalConfig: hostConfigPath,
      env: githubCredentialEnv(TOKEN),
    });

    expect(stdout).toContain('username=x-access-token');
    expect(stdout).toContain(`password=${TOKEN}`);
    // It also wins over the helper the host configured globally.
    expect(stdout).not.toContain('host-token');
    expect(await readFile(repoConfigPath(repoDir), 'utf8')).not.toContain(TOKEN);
    expect(await readFile(hostConfigPath, 'utf8')).not.toContain(TOKEN);
  });
});

describe('GITHUB_CREDENTIAL_HELPER persisted in a clone', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await makeRepo('persisted');
    await execFileAsync(
      'git',
      ['-C', repoDir, 'config', GITHUB_CREDENTIAL_CONFIG_KEY, GITHUB_CREDENTIAL_HELPER],
      { env: gitEnv() }
    );
  });

  it('reads the token from the environment at run time, storing no secret on disk', async () => {
    const { stdout } = await credentialFill(repoDir, { env: { [GITHUB_TOKEN_ENV]: TOKEN } });

    expect(stdout).toContain('username=x-access-token');
    expect(stdout).toContain(`password=${TOKEN}`);
    expect(await readFile(repoConfigPath(repoDir), 'utf8')).not.toContain(TOKEN);
  });

  it('preserves a token containing shell escapes', async () => {
    const awkward = 'tok\\cen\\nvalue';

    const { stdout } = await credentialFill(repoDir, { env: { [GITHUB_TOKEN_ENV]: awkward } });

    expect(stdout).toContain(`password=${awkward}`);
  });

  it('answers nothing when the token is absent rather than sending an empty password', async () => {
    const { stdout, failed } = await credentialFill(repoDir);

    // Nothing else can answer here, so git has to give up entirely.
    expect(stdout).not.toContain('username=');
    expect(failed).toBe(true);
  });

  it('leaves another configured helper free to answer when the token is absent', async () => {
    const { stdout } = await credentialFill(repoDir, { globalConfig: hostConfigPath });

    expect(stdout).toContain('username=host-account');
    expect(stdout).toContain('password=host-token');
  });
});
