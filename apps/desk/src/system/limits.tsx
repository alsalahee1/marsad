import type { LimitsResponse } from '@marsad/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getLimits } from '../api/endpoints.js';

const LimitsContext = createContext<LimitsResponse | null>(null);

/** The ceilings and caps the engine enforces: fetched once, read-only, drawn as meters. */
export function LimitsProvider({ children }: { children: ReactNode }) {
  const [limits, setLimits] = useState<LimitsResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      getLimits(controller.signal).then(
        (l) => {
          setLimits(l);
        },
        () => {
          if (!controller.signal.aborted) timer = setTimeout(load, 5000);
        },
      );
    };
    load();
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return <LimitsContext.Provider value={limits}>{children}</LimitsContext.Provider>;
}

export function useLimits(): LimitsResponse | null {
  return useContext(LimitsContext);
}
