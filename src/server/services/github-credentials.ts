import path from 'path';
import { runGit } from './git';
import { writeSecretFile } from './secret-file';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('github-credentials');

/**
 * Filename of the per-session GitHub token. It sits in the workspace root, which
 * has to be somewhere outside the clone anyway: the helper is installed for the
 * clone itself, so the token must exist before the clone directory does. Removed
 * with the workspace when the session is archived.
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
 * git appends the operation (`get`/`store`/`erase`) to the snippet and runs the
 * result with `sh`, so `$1` is the operation and only `get` has an answer worth
 * printing — git discards helper output for the other two. Returning without
 * output is also how a helper *declines*, which is what an unreadable or empty
 * token file must do: printing an empty password instead would hand git a
 * credential it believes in, so it would fail to authenticate rather than fall
 * through to another helper.
 */
export function buildGithubCredentialHelper(tokenPath: string): string {
  const quoted = shellSingleQuote(tokenPath);
  return (
    `!f() { test "$1" = get || return 0; t=$(cat ${quoted}) || return 0; test -n "$t" || return 0; ` +
    `printf 'username=x-access-token\\npassword=%s\\n' "$t"; }; f`
  );
}

/** Extra `git` args that install the helper for a single command (e.g. the clone). */
export function githubCredentialArgs(tokenPath: string): string[] {
  return ['-c', `${GITHUB_CREDENTIAL_HELPER_KEY}=${buildGithubCredentialHelper(tokenPath)}`];
}

/** Write the token to a mode-0600 file in the session workspace, returning its path. */
export async function writeGithubToken(workspacePath: string, token: string): Promise<string> {
  const tokenPath = getGithubTokenPath(workspacePath);
  await writeSecretFile(tokenPath, token);
  return tokenPath;
}

/** Point a clone's persisted credential helper at the workspace token file. */
export async function installGithubCredentialHelper(
  clonePath: string,
  tokenPath: string
): Promise<void> {
  await runGit([
    '-C',
    clonePath,
    'config',
    GITHUB_CREDENTIAL_HELPER_KEY,
    buildGithubCredentialHelper(tokenPath),
  ]);
}

/**
 * Best-effort refresh on session revive: rewrites a token file the agent deleted,
 * picks up a rotated `GITHUB_TOKEN`, and converges clones made before #498 — whose
 * `.git/config` still holds an inline token — onto the file.
 * A failure here only means the session's pushes need credentials it may already
 * have, so it must never block establishing the query.
 */
export async function refreshGithubCredentials(
  workspacePath: string,
  clonePath: string,
  token: string
): Promise<void> {
  try {
    await installGithubCredentialHelper(clonePath, await writeGithubToken(workspacePath, token));
  } catch (error) {
    log.error('Failed to refresh GitHub credentials', toError(error), { clonePath });
  }
}
