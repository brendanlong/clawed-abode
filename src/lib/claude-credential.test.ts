import { describe, it, expect } from 'vitest';
import { classifyClaudeCredential } from './claude-credential';

describe('classifyClaudeCredential', () => {
  it('treats sk-ant-oat values as OAuth bearer tokens', () => {
    expect(classifyClaudeCredential('sk-ant-oat01-abc')).toEqual({
      apiKey: null,
      authToken: 'sk-ant-oat01-abc',
    });
  });

  it('treats anything else as an API key', () => {
    expect(classifyClaudeCredential('sk-ant-api03-abc')).toEqual({ apiKey: 'sk-ant-api03-abc' });
  });
});
