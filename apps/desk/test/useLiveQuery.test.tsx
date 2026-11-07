import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveQuery } from '../src/lib/useLiveQuery.js';
import { EventStreamProvider } from '../src/log/EventStreamProvider.js';
import { makeEvent } from './support/events.js';
import { FakeEventSource } from './support/fakeEventSource.js';
import { fakeStream } from './support/harness.js';

function Probe({ fetcher }: { fetcher: (signal: AbortSignal) => Promise<number> }) {
  const q = useLiveQuery(fetcher, 'probe');
  return <output data-testid="value">{q.loading ? 'loading' : String(q.data)}</output>;
}

describe('useLiveQuery', () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches on mount and again when a relevant event arrives, not for an irrelevant one', async () => {
    let n = 0;
    const fetcher = vi.fn(() => Promise.resolve(++n));
    const store = fakeStream();
    render(
      <EventStreamProvider store={store}>
        <Probe fetcher={fetcher} />
      </EventStreamProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('value')).toHaveTextContent('1');
    });
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error('no source');
    source.open();

    source.emit('auth.login', makeEvent(1, 'auth.login'));
    await new Promise((r) => setTimeout(r, 250));
    expect(fetcher).toHaveBeenCalledTimes(1);

    source.emit('run.done', makeEvent(2, 'run.done'));
    await waitFor(() => {
      expect(screen.getByTestId('value')).toHaveTextContent('2');
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
