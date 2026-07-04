import { describe, it, expect } from 'vitest';
import {
  resolveSettingSources,
  DEFAULT_SETTING_SOURCE_FLAGS,
  SETTING_SOURCES,
} from './setting-sources';

describe('resolveSettingSources', () => {
  it('returns only the project scope for the defaults', () => {
    expect(resolveSettingSources(DEFAULT_SETTING_SOURCE_FLAGS)).toEqual(['project']);
  });

  it('returns an empty array when every scope is disabled', () => {
    expect(resolveSettingSources({ user: false, project: false, local: false })).toEqual([]);
  });

  it('includes every enabled scope in canonical order', () => {
    expect(resolveSettingSources({ user: true, project: true, local: true })).toEqual([
      'user',
      'project',
      'local',
    ]);
  });

  it('preserves canonical order regardless of which scopes are enabled', () => {
    expect(resolveSettingSources({ user: true, project: false, local: true })).toEqual([
      'user',
      'local',
    ]);
  });

  it('resolves each scope independently', () => {
    for (const source of SETTING_SOURCES) {
      const flags = { user: false, project: false, local: false, [source]: true };
      expect(resolveSettingSources(flags)).toEqual([source]);
    }
  });
});
