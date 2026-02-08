import { describe, it, expect } from 'vitest';
import { inferAlias } from './anthropic-models';

describe('inferAlias', () => {
  it('should strip date suffix from model IDs', () => {
    expect(inferAlias('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(inferAlias('claude-opus-4-6-20260101')).toBe('claude-opus-4-6');
    expect(inferAlias('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  it('should return null for model IDs without a date suffix', () => {
    expect(inferAlias('opus')).toBeNull();
    expect(inferAlias('sonnet')).toBeNull();
    expect(inferAlias('claude-sonnet-4-5')).toBeNull();
  });

  it('should not strip non-date suffixes', () => {
    expect(inferAlias('claude-sonnet-v2')).toBeNull();
    expect(inferAlias('claude-sonnet-latest')).toBeNull();
  });
});
