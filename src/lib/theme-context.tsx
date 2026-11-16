'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  DARK_CLASS,
  THEME_STORAGE_KEY,
  resolveTheme,
  themePreferenceSchema,
  type Theme,
  type ThemePreference,
} from './theme';

interface ThemeContextType {
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>('auto');
  // null until read on mount: the server can't know it, and the first client
  // render must match the server's.
  const [systemDark, setSystemDark] = useState<boolean | null>(null);
  const theme = resolveTheme(themePreference, systemDark ?? false);

  // Read the stored preference and follow the system theme.
  useEffect(() => {
    const mediaQuery = window.matchMedia(DARK_QUERY);
    // Deferred to avoid a synchronous setState in an effect (React 19 lint rule).
    queueMicrotask(() => {
      setThemePreferenceState(themePreferenceSchema.parse(localStorage.getItem(THEME_STORAGE_KEY)));
      setSystemDark(mediaQuery.matches);
    });
    const handleChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // THEME_INIT_SCRIPT set the class for first paint; take over once the stored
  // preference has been read, so the placeholder state never un-darkens the page.
  useEffect(() => {
    if (systemDark === null) return;
    document.documentElement.classList.toggle(DARK_CLASS, theme === 'dark');
  }, [theme, systemDark]);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    setThemePreferenceState(preference);
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themePreference,
        setThemePreference,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
