import { describe, it, expect } from 'vitest';
import { mergeAgentEnv } from './agent-env';

describe('mergeAgentEnv', () => {
  const baseEnv = { PATH: '/usr/bin:/bin', HOME: '/home/user' };

  it('starts from the base env and overlays user-configured vars (which may override base)', () => {
    const env = mergeAgentEnv(baseEnv, [
      { name: 'MY_API_KEY', value: 'key-123' },
      { name: 'HOME', value: '/custom/home' },
    ]);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/custom/home', MY_API_KEY: 'key-123' });
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN from claudeApiKey, and lets a per-repo env var win over it', () => {
    expect(mergeAgentEnv(baseEnv, [], 'global-key').CLAUDE_CODE_OAUTH_TOKEN).toBe('global-key');
    expect(
      mergeAgentEnv(baseEnv, [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'repo-key' }], 'global-key')
        .CLAUDE_CODE_OAUTH_TOKEN
    ).toBe('repo-key');
  });

  it('passes a shell-provided token through when no claudeApiKey is configured', () => {
    const env = mergeAgentEnv({ ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: 'shell-token' }, [], null);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('shell-token');
    expect(mergeAgentEnv(baseEnv, [], null).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('does not mutate the base env', () => {
    const input = { ...baseEnv };
    mergeAgentEnv(input, [{ name: 'HOME', value: '/custom/home' }], 'key');
    expect(input).toEqual(baseEnv);
  });
});
