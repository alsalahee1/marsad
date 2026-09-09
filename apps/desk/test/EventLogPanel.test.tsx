import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLogPanel } from '../src/log/EventLogPanel.js';
import { EventStreamProvider, useSelection } from '../src/log/EventStreamProvider.js';
import { EventStreamStore } from '../src/log/stream.js';
import { FakeEventSource } from './support/fakeEventSource.js';
import { makeEvent, range } from './support/events.js';

function Selected() {
  const { selected } = useSelection();
  return <output data-testid="selected">{selected?.id ?? 'none'}</output>;
}

describe('EventLogPanel', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    // jsdom has no layout: give the list a viewport so the virtualiser renders rows.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 280;
      },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the tail page, appends live frames, and selects with click and keyboard', async () => {
    const store = new EventStreamStore({
      streamPath: '/events/stream',
      fetchTail: () => Promise.resolve(range(1, 5, 'run.step')),
      createSource: (url) => new FakeEventSource(url),
      sessionAlive: () => Promise.resolve(true),
      pageSize: 300,
    });
    render(
      <EventStreamProvider store={store}>
        <EventLogPanel />
        <Selected />
      </EventStreamProvider>,
    );
    await screen.findAllByText('Step');
    const list = screen.getByRole('listbox', { name: 'Events' });
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(document.querySelector('.desk-panel__meta .num')).toHaveTextContent('5');

    const source = FakeEventSource.instances[0];
    if (!source) throw new Error('no source');
    source.open();
    expect(await screen.findByText('Live')).toBeTruthy();
    source.emit('system.halted', makeEvent(6, 'system.halted'));
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(6);
    });
    expect(screen.getByText(/Global halt by operator/)).toBeTruthy();

    const second = screen.getAllByRole('option')[1];
    if (!second) throw new Error('missing row');
    fireEvent.click(second);
    expect(screen.getByTestId('selected')).toHaveTextContent('2');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(screen.getByTestId('selected')).toHaveTextContent('3');
    fireEvent.keyDown(list, { key: 'End' });
    expect(screen.getByTestId('selected')).toHaveTextContent('6');
    expect(screen.getByRole('button', { name: /Follow/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks action rows with their blast-radius stripe and never with a hue', async () => {
    const store = new EventStreamStore({
      streamPath: '/events/stream',
      fetchTail: () =>
        Promise.resolve([makeEvent(1, 'tool.requested'), makeEvent(2, 'approval.requested')]),
      createSource: (url) => new FakeEventSource(url),
      sessionAlive: () => Promise.resolve(true),
    });
    render(
      <EventStreamProvider store={store}>
        <EventLogPanel />
      </EventStreamProvider>,
    );
    const rows = await screen.findAllByRole('option');
    expect(rows[0]?.className).toContain('action--costly');
    expect(rows[1]?.className).toContain('action--irreversible');
    expect(rows[1]?.querySelector('.state-dot')?.getAttribute('data-state')).toBe('blocked');
  });
});
