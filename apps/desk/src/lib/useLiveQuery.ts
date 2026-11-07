import type { EventType } from '@marsad/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../api/client.js';
import { useEventStream } from '../log/EventStreamProvider.js';

export interface LiveQuery<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Rows about runs, calls, approvals and agents all change on these; budgets ride along. */
export const RUN_EVENT_PREFIXES = ['run.', 'tool.', 'approval.', 'budget.', 'agent.', 'system.'];

function matchesAny(type: EventType, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => type.startsWith(p));
}

const REFRESH_DEBOUNCE_MS = 150;

interface Result<T> {
  key: string;
  tick: number;
  data: T | null;
  error: string | null;
}

/**
 * A read model kept honest by the log. The engine's tables are projections of the same
 * transactions that write the events, so the desk fetches the rows it needs and re-fetches
 * whenever a relevant event arrives on the stream: no second copy of the state machine in
 * the browser, nothing to drift. `key` names the subject; changing it drops the old rows.
 */
export function useLiveQuery<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  key: string,
  prefixes: readonly string[] = RUN_EVENT_PREFIXES,
): LiveQuery<T> {
  const { snapshot } = useEventStream();
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T>>({ key, tick: -1, data: null, error: null });
  const fetcherRef = useRef(fetcher);
  const lastSeen = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Declared before the fetch effect so the latest fetcher is in place when it runs.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const controller = new AbortController();
    fetcherRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ key, tick, data, error: null });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Keep the rows we had for this subject; show the error next to them.
        setResult((prev) => ({
          key,
          tick,
          data: prev.key === key ? prev.data : null,
          error: describeError(err),
        }));
      },
    );
    return () => {
      controller.abort();
    };
  }, [key, tick]);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  // Watch the stream: any new row of a relevant type schedules one refresh.
  const events = snapshot.buffer.events;
  useEffect(() => {
    const last = events[events.length - 1];
    if (!last) return undefined;
    if (lastSeen.current === null) {
      lastSeen.current = last.id;
      return undefined;
    }
    if (last.id === lastSeen.current) return undefined;
    let relevant = false;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev || ev.id === lastSeen.current) break;
      if (matchesAny(ev.type, prefixes)) {
        relevant = true;
        break;
      }
    }
    lastSeen.current = last.id;
    if (!relevant || timer.current !== null) return undefined;
    timer.current = setTimeout(() => {
      timer.current = null;
      setTick((n) => n + 1);
    }, REFRESH_DEBOUNCE_MS);
    return undefined;
  }, [events, prefixes]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const current = result.key === key;
  return {
    data: current ? result.data : null,
    error: current ? result.error : null,
    loading: !(current && result.tick === tick),
    refresh,
  };
}
