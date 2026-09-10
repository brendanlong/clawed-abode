/**
 * Wiring for the GitHub token git uses to clone, fetch and push.
 *
 * git has no "read the token from $FOO" setting, so the token has to arrive
 * through a credential helper. The helper below reads it from the environment
 * at run time, which keeps the secret out of both places it used to land:
 * git's argv (world-readable via /proc/<pid>/cmdline) and the clone's
 * persisted .git/config.
 */

/** Env var the credential helper reads the token from. */
export const GITHUB_TOKEN_ENV = 'CLAWED_ABODE_GITHUB_TOKEN';

/** Config key holding the helper, scoped to github.com. */
export const GITHUB_CREDENTIAL_CONFIG_KEY = 'credential.https://github.com.helper';

/**
 * Emits nothing when the var is unset, so git falls through to whatever other
 * helpers the host has configured instead of answering with an empty password.
 */
export const GITHUB_CREDENTIAL_HELPER =
  `!f() { test -n "$${GITHUB_TOKEN_ENV}" || return; ` +
  `echo username=x-access-token; echo "password=$${GITHUB_TOKEN_ENV}"; }; f`;

/**
 * Environment for a git command that must authenticate to GitHub as `token`.
 *
 * `GIT_CONFIG_*` injects the helper for this one command without touching any
 * config file. Environment config is applied after system/global/local, and an
 * empty helper value resets the list, so this token wins over a host-wide
 * helper (e.g. `gh auth git-credential`) that might answer for a different
 * account.
 */
export function githubCredentialEnv(token: string): Record<string, string> {
  return {
    [GITHUB_TOKEN_ENV]: token,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: GITHUB_CREDENTIAL_CONFIG_KEY,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: GITHUB_CREDENTIAL_CONFIG_KEY,
    GIT_CONFIG_VALUE_1: GITHUB_CREDENTIAL_HELPER,
  };
}
