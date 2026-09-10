import { execFile } from 'child_process';
import { promisify } from 'util';
import { env } from '@/lib/env';
import { GITHUB_TOKEN_ENV } from '@/lib/git-credentials';
import { createLogger, toError } from '@/lib/logger';
import type { ResolvedEnvVar } from '@/lib/settings-types';

const execFileAsync = promisify(execFile);
const log = createLogger('agent-env');

/** Env vars to seed the login shell with (and to use as the fallback env). */
const SEED_ENV_VARS = [
  'HOME',
  'USER',
  'SHELL',
  'LOGNAME',
  'PATH',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
];

let cachedBaseEnv: Record<string, string> | null = null;
let pendingBaseEnv: Promise<Record<string, string>> | null = null;

/**
 * The agent's base environment: a fresh login shell's env (PATH, HOME, anything
 * exported from the user's profile) **without** the server's own runtime vars
 * such as the encryption key or password hash. Cached for the process lifetime.
 */
export async function getBaseEnv(): Promise<Record<string, string>> {
  if (cachedBaseEnv) return cachedBaseEnv;
  if (pendingBaseEnv) return pendingBaseEnv;

  pendingBaseEnv = fetchBaseEnv();
  try {
    return await pendingBaseEnv;
  } finally {
    pendingBaseEnv = null;
  }
}

function seedEnv(): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const key of SEED_ENV_VARS) {
    const value = process.env[key];
    if (value) seed[key] = value;
  }
  return seed;
}

async function fetchBaseEnv(): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync('bash', ['-lc', 'env -0'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: seedEnv() as NodeJS.ProcessEnv,
    });

    const baseEnv: Record<string, string> = {};
    for (const entry of stdout.split('\0')) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) continue;
      baseEnv[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }

    cachedBaseEnv = baseEnv;
    log.info('Captured base environment from login shell', {
      varCount: Object.keys(baseEnv).length,
    });
    return baseEnv;
  } catch (err) {
    log.error(
      'Failed to capture base environment from login shell, falling back to minimal env',
      toError(err)
    );
    return seedEnv();
  }
}

export function resetBaseEnvCache(): void {
  cachedBaseEnv = null;
  pendingBaseEnv = null;
}

/**
 * Merge the agent environment from its sources, lowest to highest precedence:
 * the base (login shell) env, the server's own tokens, and the user-configured
 * env vars. Never removes vars from the base env — a CLAUDE_CODE_OAUTH_TOKEN
 * exported by the login shell passes through when no claudeApiKey is
 * configured.
 *
 * `githubToken` is what the clone's credential helper reads, so the agent's
 * own fetches and pushes authenticate (see src/lib/git-credentials.ts).
 */
export function mergeAgentEnv(
  baseEnv: Record<string, string>,
  userEnvVars: ResolvedEnvVar[],
  claudeApiKey?: string | null,
  githubToken?: string
): Record<string, string | undefined> {
  const agentEnv: Record<string, string | undefined> = { ...baseEnv };

  if (claudeApiKey) {
    agentEnv['CLAUDE_CODE_OAUTH_TOKEN'] = claudeApiKey;
  }

  if (githubToken) {
    agentEnv[GITHUB_TOKEN_ENV] = githubToken;
  }

  for (const { name, value } of userEnvVars) {
    agentEnv[name] = value;
  }

  return agentEnv;
}

/** The environment to pass to the Claude SDK for a session. */
export async function buildAgentEnv(
  userEnvVars: ResolvedEnvVar[],
  claudeApiKey?: string | null
): Promise<Record<string, string | undefined>> {
  return mergeAgentEnv(await getBaseEnv(), userEnvVars, claudeApiKey, env.GITHUB_TOKEN);
}
