import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type DensityPref = 'comfortable' | 'compact';

export interface Prefs {
  theme: ThemePref;
  density: DensityPref;
  railExpanded: boolean;
}

const STORAGE_KEY = 'marsad.desk.prefs';
const DEFAULTS: Prefs = { theme: 'system', density: 'compact', railExpanded: false };

function isTheme(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}
function isDensity(v: unknown): v is DensityPref {
  return v === 'comfortable' || v === 'compact';
}

export function readPrefs(storage: Pick<Storage, 'getItem'> | null): Prefs {
  if (!storage) return DEFAULTS;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const p = parsed as Record<string, unknown>;
    return {
      theme: isTheme(p['theme']) ? p['theme'] : DEFAULTS.theme,
      density: isDensity(p['density']) ? p['density'] : DEFAULTS.density,
      railExpanded:
        typeof p['railExpanded'] === 'boolean' ? p['railExpanded'] : DEFAULTS.railExpanded,
    };
  } catch {
    return DEFAULTS;
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the desk still works, it just forgets on reload.
  }
}

interface PrefsApi extends Prefs {
  setTheme: (theme: ThemePref) => void;
  setDensity: (density: DensityPref) => void;
  setRailExpanded: (expanded: boolean) => void;
}

const PrefsContext = createContext<PrefsApi | null>(null);

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Applies `data-theme` and `data-density` on <html>, the hooks marsad-theme.css keys on. */
function applyToDocument(theme: ThemePref, density: DensityPref): void {
  const root = document.documentElement;
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  if (dark) root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  root.setAttribute('data-density', density);
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() =>
    readPrefs(typeof localStorage === 'undefined' ? null : localStorage),
  );

  useEffect(() => {
    applyToDocument(prefs.theme, prefs.density);
    writePrefs(prefs);
    if (prefs.theme !== 'system' || typeof matchMedia !== 'function') return undefined;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      applyToDocument(prefs.theme, prefs.density);
    };
    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, [prefs]);

  const setTheme = useCallback((theme: ThemePref) => {
    setPrefs((p) => ({ ...p, theme }));
  }, []);
  const setDensity = useCallback((density: DensityPref) => {
    setPrefs((p) => ({ ...p, density }));
  }, []);
  const setRailExpanded = useCallback((railExpanded: boolean) => {
    setPrefs((p) => ({ ...p, railExpanded }));
  }, []);

  const api = useMemo<PrefsApi>(
    () => ({ ...prefs, setTheme, setDensity, setRailExpanded }),
    [prefs, setTheme, setDensity, setRailExpanded],
  );
  return <PrefsContext.Provider value={api}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsApi {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs outside PrefsProvider');
  return ctx;
}
