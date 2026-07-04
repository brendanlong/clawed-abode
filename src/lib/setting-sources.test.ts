import { describe, it, expect } from 'vitest';
import {
  resolveSettingSources,
  settingSourceFlagsFromRow,
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

describe('settingSourceFlagsFromRow', () => {
  it('falls back to the defaults when no row exists', () => {
    expect(settingSourceFlagsFromRow(null)).toEqual(DEFAULT_SETTING_SOURCE_FLAGS);
    expect(settingSourceFlagsFromRow(undefined)).toEqual(DEFAULT_SETTING_SOURCE_FLAGS);
  });

  it('maps the per-scope columns to flags', () => {
    expect(
      settingSourceFlagsFromRow({
        settingSourceUser: true,
        settingSourceProject: false,
        settingSourceLocal: true,
      })
    ).toEqual({ user: true, project: false, local: true });
  });

  it('resolves via resolveSettingSources to the SDK array', () => {
    const flags = settingSourceFlagsFromRow({
      settingSourceUser: true,
      settingSourceProject: true,
      settingSourceLocal: false,
    });
    expect(resolveSettingSources(flags)).toEqual(['user', 'project']);
  });
});
