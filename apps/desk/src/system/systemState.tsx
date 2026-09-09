import type { Event, SystemState } from '@marsad/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { describeError } from '../api/client.js';
import { getSystem, haltAll, resumeAll } from '../api/endpoints.js';
import { useEventStream } from '../log/EventStreamProvider.js';

interface SystemApi {
  /** null until the first GET /system answers and no system.* row has been seen. */
  state: SystemState | null;
  pending: 'halt' | 'resume' | null;
  error: string | null;
  halt: () => Promise<void>;
  resume: () => Promise<void>;
}

const SystemContext = createContext<SystemApi | null>(null);

/** The flag as implied by the newest system.* row in the buffer, or null if there is none. */
export function projectSystemState(events: readonly Event[]): SystemState | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.type === 'system.halted')
      return { halted: true, haltedAt: ev.at, reason: ev.payload.reason };
    if (ev.type === 'system.resumed') return { halted: false, haltedAt: null, reason: null };
  }
  return null;
}

/**
 * The global halt flag as the desk sees it. The event log is the truth: the newest
 * `system.halted` / `system.resumed` row wins. GET /system only fills the gap when no such
 * row is inside the buffer's window. Halt and resume never set state themselves — the engine
 * writes the row before it answers, so the row is what flips the switch.
 */
export function SystemProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useEventStream();
  const [fetched, setFetched] = useState<SystemState | null>(null);
  const [pending, setPending] = useState<'halt' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getSystem(controller.signal).then(
      (s) => {
        setFetched(s);
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(describeError(err));
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  const events = snapshot.buffer.events;
  const projected = useMemo(() => projectSystemState(events), [events]);
  const state = projected ?? fetched;

  const halt = useCallback(async () => {
    setPending('halt');
    setError(null);
    try {
      await haltAll('operator');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(null);
    }
  }, []);

  const resume = useCallback(async () => {
    setPending('resume');
    setError(null);
    try {
      await resumeAll();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(null);
    }
  }, []);

  const api = useMemo<SystemApi>(
    () => ({ state, pending, error, halt, resume }),
    [state, pending, error, halt, resume],
  );
  return <SystemContext.Provider value={api}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemApi {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error('useSystem outside SystemProvider');
  return ctx;
}
