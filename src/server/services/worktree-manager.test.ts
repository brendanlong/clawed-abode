import { describe, it, expect } from 'vitest';
import { GITHUB_TOKEN_ENV } from '@/lib/git-credentials';
import { buildCloneCommand } from './worktree-manager';

const TOKEN = 'ghp_test_token_value';

describe('buildCloneCommand', () => {
  const params = {
    repoFullName: 'owner/repo',
    branch: 'main',
    clonePath: '/worktrees/session-1/repo',
    githubToken: TOKEN,
  };

  it('keeps the token out of argv and carries it in the environment instead', () => {
    const { args, env } = buildCloneCommand(params);

    // /proc/<pid>/cmdline is world-readable and sessions share a host user.
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(args).toContain('https://github.com/owner/repo.git');
    expect(env[GITHUB_TOKEN_ENV]).toBe(TOKEN);
  });

  it('clones the requested branch only, into the given path', () => {
    expect(buildCloneCommand(params).args).toEqual([
      'clone',
      '--branch',
      'main',
      '--single-branch',
      'https://github.com/owner/repo.git',
      '/worktrees/session-1/repo',
    ]);
  });

  it('refuses to prompt for a username, with or without a token', () => {
    expect(buildCloneCommand(params).env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(buildCloneCommand({ ...params, githubToken: undefined }).env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
    });
  });
});
