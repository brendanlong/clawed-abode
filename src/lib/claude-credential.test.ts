import { describe, it, expect } from 'vitest';
import { classifyClaudeCredential } from './claude-credential';

describe('classifyClaudeCredential', () => {
  it('treats sk-ant- prefixed values as API keys', () => {
    expect(classifyClaudeCredential('sk-ant-api03-abc')).toEqual({ apiKey: 'sk-ant-api03-abc' });
  });

  it('treats anything else as an OAuth token', () => {
    expect(classifyClaudeCredential('oauth-token')).toEqual({ authToken: 'oauth-token' });
  });
});
