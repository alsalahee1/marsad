import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '../src/runs/RunDetail.js';
import { makeEvent } from './support/events.js';
import { FakeEventSource } from './support/fakeEventSource.js';
import { mockFetch } from './support/fetchMock.js';
import { LIMITS, RUN_ID, runDetail } from './support/fixtures.js';
import { Providers, fakeRoute } from './support/harness.js';

describe('RunDetail', () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws every ceiling as a meter, lists calls and the timeline, and halts the run', async () => {
    let detail = runDetail('running');
    const { calls } = mockFetch({
      [`GET /runs/${RUN_ID}`]: () => detail,
      'GET /events/tail': () => ({
        events: [makeEvent(1, 'run.started'), makeEvent(2, 'tool.requested')],
      }),
      'GET /limits': () => LIMITS,
      'GET /approvals': () => ({ approvals: [] }),
      [`POST /runs/${RUN_ID}/halt`]: () => {
        detail = runDetail('halted');
        return detail;
      },
    });
    render(
      <Providers route={fakeRoute({ dest: 'log' })}>
        <RunDetail runId={RUN_ID} />
      </Providers>,
    );
    await screen.findByText('reconcile invoices for September');
    const meters = await screen.findAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Steps',
      'Tokens',
      'Active time',
      'Spend',
    ]);
    expect(screen.getByRole('meter', { name: 'Steps' })).toHaveAttribute('aria-valuenow', '4');
    expect(
      screen.getByRole('meter', { name: 'Steps' }).closest('.meter')?.getAttribute('data-level'),
    ).toBe('ok');
    expect(await screen.findByText(/http\.get requested/)).toBeTruthy();
    expect(screen.getByText('executed')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Halt run' }));
    await waitFor(() => {
      expect(screen.getByText('halted')).toBeTruthy();
    });
    expect(calls.some((c) => c.method === 'POST' && c.path === `/runs/${RUN_ID}/halt`)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Halt run' })).toBeNull();
  });
});
