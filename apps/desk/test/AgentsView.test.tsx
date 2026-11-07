import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsView } from '../src/agents/AgentsView.js';
import { FakeEventSource } from './support/fakeEventSource.js';
import { mockFetch } from './support/fetchMock.js';
import { AGENT_ID, LIMITS, RUN_ID, rosterRow } from './support/fixtures.js';
import { Providers, fakeRoute } from './support/harness.js';

const TOOLS = [
  {
    name: 'echo',
    description: 'echo',
    blastRadius: 'reversible',
    inputSchema: {},
    version: '1',
    active: true,
  },
  {
    name: 'demo.wipe',
    description: 'wipes',
    blastRadius: 'irreversible',
    inputSchema: {},
    version: '1',
    active: true,
  },
];

describe('AgentsView', () => {
  beforeEach(() => {
    FakeEventSource.reset();
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

  it('renders the roster as a table with tabular figures and selects a row', async () => {
    mockFetch({
      'GET /agents': () => ({
        agents: [rosterRow({ activeRun: { id: RUN_ID, status: 'running' } })],
      }),
      'GET /approvals': () => ({ approvals: [] }),
      'GET /limits': () => LIMITS,
    });
    const setFocus = vi.fn();
    render(
      <Providers route={fakeRoute({ dest: 'agents', setFocus })}>
        <AgentsView viewport="desktop" />
      </Providers>,
    );
    const row = await screen.findByRole('option', { name: /Inventory sync/ });
    expect(row.querySelector('.chip-state')?.getAttribute('data-state')).toBe('running');
    expect(row.querySelector('.roster-cell--spend')).toHaveTextContent('1.2500');
    fireEvent.click(row);
    expect(setFocus).toHaveBeenCalledWith({ agent: AGENT_ID });
  });

  it('renders cards on the phone and opens the create form with the tool picker', async () => {
    mockFetch({
      'GET /agents': () => ({ agents: [rosterRow()] }),
      'GET /approvals': () => ({ approvals: [] }),
      'GET /limits': () => LIMITS,
      'GET /tools': () => ({ tools: TOOLS }),
    });
    render(
      <Providers route={fakeRoute({ dest: 'agents' })}>
        <AgentsView viewport="phone" />
      </Providers>,
    );
    const card = await screen.findByRole('button', { name: /Inventory sync/ });
    expect(card.className).toContain('agent-card');
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    const wipe = await screen.findByText('demo.wipe');
    expect(wipe.closest('.tool-picker__item')?.className).toContain('action--irreversible');
  });
});
