/**
 * Theme constants shared by the ThemeProvider and the blocking script in the
 * root layout, which applies the stored preference before first paint so the
 * page doesn't flash light on a dark device.
 */

export type Theme = 'light' | 'dark';
export type ThemePreference = 'auto' | Theme;

export const THEME_STORAGE_KEY = 'theme_preference';
export const DARK_CLASS = 'dark';

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'auto') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * Inline script for `<head>`. It mirrors {@link resolveTheme} in plain JS because
 * it must run before any module loads; the key and class name are interpolated so
 * they can't drift from the provider.
 */
export const THEME_INIT_SCRIPT = `
(function() {
  try {
    var preference = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || 'auto';
    var dark = preference === 'auto'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : preference === 'dark';
    if (dark) document.documentElement.classList.add(${JSON.stringify(DARK_CLASS)});
  } catch (e) {}
})();
`;
