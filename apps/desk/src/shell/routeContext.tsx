import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Destination, Focus, RouteApi } from './navigation.js';

const RouteContext = createContext<RouteApi | null>(null);

export function RouteProvider({ value, children }: { value: RouteApi; children: ReactNode }) {
  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}

export function useRouteApi(): RouteApi {
  const ctx = useContext(RouteContext);
  if (!ctx) throw new Error('useRouteApi outside RouteProvider');
  return ctx;
}

export interface FocusApi {
  focus: Focus;
  dest: Destination;
  openRun: (id: string) => void;
  closeRun: () => void;
  openAgent: (id: string) => void;
  closeAgent: () => void;
  openApproval: (id: string) => void;
  closeApproval: () => void;
  navigate: (dest: Destination) => void;
}

function focusApi(route: RouteApi): FocusApi {
  const { dest, focus, navigate, setFocus } = route;
  return {
    focus,
    dest,
    navigate,
    openRun: (id) => {
      setFocus({ run: id });
    },
    closeRun: () => {
      setFocus({ run: null });
    },
    openAgent: (id) => {
      setFocus({ agent: id });
    },
    closeAgent: () => {
      setFocus({ agent: null });
    },
    openApproval: (id) => {
      setFocus({ approval: id });
    },
    closeApproval: () => {
      setFocus({ approval: null });
    },
  };
}

/** Open a run from anywhere; open an agent or approval on its own screen. */
export function useFocus(): FocusApi {
  const route = useRouteApi();
  return useMemo(() => focusApi(route), [route]);
}

/** Same, but null outside the shell (components also rendered standalone in tests). */
export function useOptionalFocus(): FocusApi | null {
  const route = useContext(RouteContext);
  return useMemo(() => (route ? focusApi(route) : null), [route]);
}
