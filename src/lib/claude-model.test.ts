import { describe, it, expect } from 'vitest';
import { DEFAULT_CLAUDE_MODEL, fallbackClaudeModel } from './claude-model';

describe('fallbackClaudeModel', () => {
  it('prefers the global override', () => {
    expect(fallbackClaudeModel({ claudeModel: 'sonnet', defaultClaudeModel: 'opus' })).toBe(
      'sonnet'
    );
  });

  it('falls back to the env default when no global override is set', () => {
    expect(fallbackClaudeModel({ claudeModel: null, defaultClaudeModel: 'opus' })).toBe('opus');
  });

  it('uses the built-in default while settings are still loading', () => {
    expect(fallbackClaudeModel(undefined)).toBe(DEFAULT_CLAUDE_MODEL);
  });
});
