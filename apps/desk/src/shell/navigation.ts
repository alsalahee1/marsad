import { useCallback, useSyncExternalStore } from 'react';
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

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function read(): Destination {
  return destinationForPath(window.location.pathname);
}

/** History-API routing for five destinations; no router dependency for five routes. */
export function useRoute(): [Destination, (dest: Destination) => void] {
  const dest = useSyncExternalStore(subscribe, read, (): Destination => 'desk');
  const navigate = useCallback((next: Destination) => {
    const path = pathFor(next);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    for (const l of listeners) l();
  }, []);
  return [dest, navigate];
}
