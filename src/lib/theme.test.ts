import { describe, it, expect } from 'vitest';
import {
  resolveTheme,
  themePreferenceSchema,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  DARK_CLASS,
} from './theme';

describe('resolveTheme', () => {
  it('follows the system in auto mode', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
  });

  it('ignores the system for an explicit preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('themePreferenceSchema', () => {
  it('accepts the three preferences and maps anything else to auto', () => {
    expect(themePreferenceSchema.parse('dark')).toBe('dark');
    expect(themePreferenceSchema.parse(null)).toBe('auto');
    expect(themePreferenceSchema.parse('purple')).toBe('auto');
  });
});

describe('THEME_INIT_SCRIPT', () => {
  it('reads the same storage key and applies the same class as the provider', () => {
    expect(THEME_INIT_SCRIPT).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(THEME_INIT_SCRIPT).toContain(`classList.add("${DARK_CLASS}")`);
  });
});
