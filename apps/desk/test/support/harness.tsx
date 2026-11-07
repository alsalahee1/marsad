import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { ApprovalsProvider } from '../../src/approvals/ApprovalsProvider.js';
import { EventStreamProvider } from '../../src/log/EventStreamProvider.js';
import { EventStreamStore } from '../../src/log/stream.js';
import { NO_FOCUS, type Focus, type RouteApi } from '../../src/shell/navigation.js';
import { RouteProvider } from '../../src/shell/routeContext.js';
import { LimitsProvider } from '../../src/system/limits.js';
import { FakeEventSource } from './fakeEventSource.js';

export function fakeRoute(over: Partial<RouteApi> = {}): RouteApi {
  const focus: Focus = { ...NO_FOCUS, ...(over.focus ?? {}) };
  return {
    dest: over.dest ?? 'desk',
    focus,
    navigate: over.navigate ?? vi.fn(),
    setFocus: over.setFocus ?? vi.fn(),
  };
}

export function fakeStream(): EventStreamStore {
  return new EventStreamStore({
    streamPath: '/events/stream',
    fetchTail: () => Promise.resolve([]),
    createSource: (url) => new FakeEventSource(url),
    sessionAlive: () => Promise.resolve(true),
  });
}

/** Everything a screen needs under it: route, stream, limits, the approvals queue. */
export function Providers({
  route,
  store = fakeStream(),
  children,
}: {
  route: RouteApi;
  store?: EventStreamStore;
  children: ReactNode;
}) {
  return (
    <RouteProvider value={route}>
      <EventStreamProvider store={store}>
        <LimitsProvider>
          <ApprovalsProvider>{children}</ApprovalsProvider>
        </LimitsProvider>
      </EventStreamProvider>
    </RouteProvider>
  );
}
