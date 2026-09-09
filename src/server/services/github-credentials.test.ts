import { describe, it, expect } from 'vitest';
import { shellSingleQuote, buildGithubCredentialHelper } from './github-credentials';

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
  it('references the token path instead of embedding a secret', () => {
    const helper = buildGithubCredentialHelper('/home/app/worktrees/abc/.github-token');
    expect(helper).toContain("cat '/home/app/worktrees/abc/.github-token'");
    expect(helper).toContain('username=x-access-token');
    expect(helper).not.toContain('password=ghp_');
  });

  it('only answers the get operation', () => {
    expect(buildGithubCredentialHelper('/t')).toContain('test "$1" = get || return 0');
  });
});
