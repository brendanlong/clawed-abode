import { mkdir, writeFile, chmod } from 'fs/promises';
import path from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('github-credentials');

/**
 * Filename of the per-session GitHub token, written inside the session workspace
 * (a sibling of the repo clone, like `mcp-config.json` — so it doesn't pollute
 * git status). Removed with the workspace when the session is archived.
 */
const GITHUB_TOKEN_FILENAME = '.github-token';

/** The git config key the credential helper is installed under. */
export const GITHUB_CREDENTIAL_HELPER_KEY = 'credential.https://github.com.helper';

export function getGithubTokenPath(workspacePath: string): string {
  return path.join(workspacePath, GITHUB_TOKEN_FILENAME);
}

/** Quote a string for safe interpolation into a single-quoted shell word. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the `credential.https://github.com.helper` value: a shell snippet that
 * reads the token out of `tokenPath` at push time.
 *
 * The token itself must never appear here. This string is passed on git's argv
 * (world-readable via `/proc/<pid>/cmdline`) and is persisted in plaintext in the
 * clone's `.git/config`; only the *path* may live in either. See issue #498.
 *
 * git invokes the helper as `sh -c '<helper> "$@"' <helper> <operation>`, so `$1`
 * is the operation — and only `get` needs an answer. Ignoring the rest means a
 * rejected token is never erased from the file behind the operator's back.
 */
export function buildGithubCredentialHelper(tokenPath: string): string {
  const quoted = shellSingleQuote(tokenPath);
  return `!f() { test "$1" = get || return 0; printf 'username=x-access-token\\npassword=%s\\n' "$(cat ${quoted})"; }; f`;
}

/**
 * Write a GitHub token to a **mode-0600** file in a session workspace and return
 * its path. `chmod` is explicit because `writeFile`'s mode only applies when the
 * file is created.
 */
export async function writeGithubToken(workspacePath: string, token: string): Promise<string> {
  await mkdir(workspacePath, { recursive: true });

  const tokenPath = getGithubTokenPath(workspacePath);
  await writeFile(tokenPath, token, { mode: 0o600 });
  await chmod(tokenPath, 0o600);

  log.info('Wrote GitHub token file', { tokenPath });
  return tokenPath;
}
