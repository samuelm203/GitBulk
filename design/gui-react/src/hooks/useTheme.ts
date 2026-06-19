/**
 * `useTheme` — heller/dunkler Modus mit Persistenz.
 *
 * Der Initialwert wird bereits VOR React in `index.html` gesetzt (kein FOUC);
 * dieser Hook spiegelt nur den aktuellen Zustand, schaltet die `.dark`-Klasse
 * auf `<html>` und merkt sich die Wahl in `localStorage`.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'gitbulk-theme';

function currentTheme(): Theme {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
    return 'dark';
  }
  return 'light';
}

export interface ThemeControl {
  readonly theme: Theme;
  readonly toggle: () => void;
}

export function useTheme(): ThemeControl {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage nicht verfügbar — egal */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((value) => (value === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
