import type { Event } from '@marsad/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { apiUrl } from '../api/base.js';
import { ApiRequestError } from '../api/client.js';
import { getEventsTail, getSession } from '../api/endpoints.js';
import { EventStreamStore, type StreamSnapshot } from './stream.js';

interface StreamApi {
  snapshot: StreamSnapshot;
  loadEarlier: () => void;
}

interface SelectionApi {
  selected: Event | null;
  select: (event: Event | null) => void;
}

const StreamContext = createContext<StreamApi | null>(null);
const SelectionContext = createContext<SelectionApi | null>(null);

function createStore(): EventStreamStore {
  return new EventStreamStore({
    streamPath: apiUrl('/events/stream'),
    fetchTail: (limit, before) => getEventsTail(limit, before),
    createSource: (url) => new EventSource(url, { withCredentials: true }),
    sessionAlive: async () => {
      try {
        await getSession();
        return true;
      } catch (err) {
        return !(err instanceof ApiRequestError && err.status === 401);
      }
    },
  });
}

/**
 * One EventSource for the whole desk, mounted inside the auth gate so it starts with a valid
 * session and is torn down the moment the session goes. Every panel that shows events reads
 * the same buffer: the log is the foundation, everything else is a projection of it.
 */
export function EventStreamProvider({
  children,
  store: injected,
}: {
  children: ReactNode;
  /** Test seam. */
  store?: EventStreamStore;
}) {
  const [store] = useState(() => injected ?? createStore());
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [selected, setSelected] = useState<Event | null>(null);

  useEffect(() => {
    void store.start();
    return () => {
      store.stop();
    };
  }, [store]);

  const loadEarlier = useCallback(() => {
    void store.loadEarlier();
  }, [store]);
  const select = useCallback((event: Event | null) => {
    setSelected(event);
  }, []);

  const streamApi = useMemo<StreamApi>(() => ({ snapshot, loadEarlier }), [snapshot, loadEarlier]);
  const selectionApi = useMemo<SelectionApi>(() => ({ selected, select }), [selected, select]);

  return (
    <StreamContext.Provider value={streamApi}>
      <SelectionContext.Provider value={selectionApi}>{children}</SelectionContext.Provider>
    </StreamContext.Provider>
  );
}

export function useEventStream(): StreamApi {
  const ctx = useContext(StreamContext);
  if (!ctx) throw new Error('useEventStream outside EventStreamProvider');
  return ctx;
}

export function useSelection(): SelectionApi {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection outside EventStreamProvider');
  return ctx;
}
