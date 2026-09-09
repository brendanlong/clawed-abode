import { describe, it, expect } from 'vitest';
import {
  shellSingleQuote,
  buildGithubCredentialHelper,
  githubCredentialArgs,
  GITHUB_CREDENTIAL_HELPER_KEY,
} from './github-credentials';

describe('shellSingleQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellSingleQuote('/home/app/worktrees/abc')).toBe("'/home/app/worktrees/abc'");
  });

  it('escapes embedded single quotes', () => {
    // POSIX form: close the quote, emit an escaped quote, reopen.
    expect(shellSingleQuote("/tmp/we'ird")).toBe(`'/tmp/we'\\''ird'`);
  });

  it('leaves other shell metacharacters inert inside the quotes', () => {
    expect(shellSingleQuote('/tmp/$(id);`id`')).toBe("'/tmp/$(id);`id`'");
  });
});

describe('buildGithubCredentialHelper', () => {
  it('reads the token from the quoted path rather than embedding it', () => {
    const helper = buildGithubCredentialHelper("/home/app/worktrees/we'ird/.github-token");
    expect(helper).toContain(`cat '/home/app/worktrees/we'\\''ird/.github-token'`);
    expect(helper).toContain('username=x-access-token');
  });
});

describe('githubCredentialArgs', () => {
  it('installs the helper for one command under the github.com-scoped key', () => {
    const args = githubCredentialArgs('/w/.github-token');
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(
      `${GITHUB_CREDENTIAL_HELPER_KEY}=${buildGithubCredentialHelper('/w/.github-token')}`
    );
  });
});
