import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { AgentsIcon, ApprovalsIcon, DeskIcon, LogIcon, SettingsIcon } from '../lib/Icons.js';

export type Destination = 'desk' | 'agents' | 'approvals' | 'log' | 'settings';

export interface DestinationDef {
  id: Destination;
  path: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Exactly five, in tab order. The phone tab bar renders this list and nothing else. */
export const DESTINATIONS: readonly DestinationDef[] = [
  { id: 'desk', path: '/', label: 'Desk', icon: DeskIcon },
  { id: 'agents', path: '/agents', label: 'Agents', icon: AgentsIcon },
  { id: 'approvals', path: '/approvals', label: 'Approvals', icon: ApprovalsIcon },
  { id: 'log', path: '/log', label: 'Log', icon: LogIcon },
  { id: 'settings', path: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function destinationForPath(pathname: string): Destination {
  const clean = pathname.replace(/\/+$/, '') || '/';
  return DESTINATIONS.find((d) => d.path === clean)?.id ?? 'desk';
}

export function pathFor(dest: Destination): string {
  return DESTINATIONS.find((d) => d.id === dest)?.path ?? '/';
}

/**
 * What is open on top of a destination: a run (any screen), an agent (the roster's detail), an
 * approval (the queue's detail). Kept in the query string so the back button closes a detail
 * and a URL can be shared: `/log?run=<id>`.
 */
export interface Focus {
  run: string | null;
  agent: string | null;
  approval: string | null;
}

export type FocusKey = keyof Focus;
const FOCUS_KEYS: readonly FocusKey[] = ['run', 'agent', 'approval'];
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
export const NO_FOCUS: Focus = { run: null, agent: null, approval: null };

export interface Route {
  dest: Destination;
  focus: Focus;
}

export function parseLocation(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const focus: Focus = { ...NO_FOCUS };
  for (const key of FOCUS_KEYS) {
    const value = params.get(key);
    if (value !== null && ID.test(value)) focus[key] = value;
  }
  return { dest: destinationForPath(pathname), focus };
}

export function buildLocation(route: Route): string {
  const params = new URLSearchParams();
  for (const key of FOCUS_KEYS) {
    const value = route.focus[key];
    if (value !== null) params.set(key, value);
  }
  const query = params.toString();
  return `${pathFor(route.dest)}${query ? `?${query}` : ''}`;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** A string snapshot keeps useSyncExternalStore stable; the object is derived with useMemo. */
function read(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function push(location: string): void {
  if (`${window.location.pathname}${window.location.search}` !== location)
    window.history.pushState(null, '', location);
  for (const l of listeners) l();
}

export interface RouteApi extends Route {
  /** Switch destination; any open detail closes with it. */
  navigate: (dest: Destination) => void;
  /** Open or close details. `null` closes; absent keys are kept. */
  setFocus: (patch: Partial<Focus>) => void;
}

/** History-API routing for five destinations and three detail keys; no router dependency. */
export function useRoute(): RouteApi {
  const location = useSyncExternalStore(subscribe, read, () => '/');
  const route = useMemo(() => {
    const at = location.indexOf('?');
    return at === -1
      ? parseLocation(location, '')
      : parseLocation(location.slice(0, at), location.slice(at));
  }, [location]);
  const navigate = useCallback((dest: Destination) => {
    push(buildLocation({ dest, focus: NO_FOCUS }));
  }, []);
  // Reads the live location, not the rendered one, so `navigate('agents'); openAgent(id)` in
  // one handler lands on /agents?agent=id instead of racing a stale destination.
  const setFocus = useCallback((patch: Partial<Focus>) => {
    const current = parseLocation(window.location.pathname, window.location.search);
    push(buildLocation({ dest: current.dest, focus: { ...current.focus, ...patch } }));
  }, []);
  return useMemo(() => ({ ...route, navigate, setFocus }), [route, navigate, setFocus]);
}
