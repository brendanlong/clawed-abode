import { describe, it, expect } from 'vitest';
import { buildSanitizationInfo, parseSanitizationInfo } from './sanitization';

describe('buildSanitizationInfo', () => {
  it('returns null when nothing was found', () => {
    expect(buildSanitizationInfo([], [], false)).toBeNull();
    // Even a "removed" flag with no categories is nothing to surface.
    expect(buildSanitizationInfo([], ['some warning'], true)).toBeNull();
  });

  it('builds an info object when categories were found', () => {
    expect(buildSanitizationInfo(['invisible-unicode'], ['stripped 1 char'], true)).toEqual({
      found: ['invisible-unicode'],
      warnings: ['stripped 1 char'],
      removed: true,
    });
  });

  it('preserves advisory-only findings (removed=false)', () => {
    const info = buildSanitizationInfo(['exfil-url'], ['suspicious URL'], false);
    expect(info?.removed).toBe(false);
    expect(info?.found).toEqual(['exfil-url']);
  });
});

describe('parseSanitizationInfo', () => {
  it('returns null for undefined / malformed / empty values', () => {
    expect(parseSanitizationInfo(undefined)).toBeNull();
    expect(parseSanitizationInfo(null)).toBeNull();
    expect(parseSanitizationInfo({ found: 'not-an-array' })).toBeNull();
    expect(parseSanitizationInfo({ found: [], warnings: [], removed: true })).toBeNull();
  });

  it('parses a valid persisted info object', () => {
    const value = { found: ['ansi'], warnings: ['removed escapes'], removed: true };
    expect(parseSanitizationInfo(value)).toEqual(value);
  });

  it('rejects a shape missing required fields', () => {
    expect(parseSanitizationInfo({ found: ['ansi'] })).toBeNull();
  });
});
