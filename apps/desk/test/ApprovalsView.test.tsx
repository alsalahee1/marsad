import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsView } from '../src/approvals/ApprovalsView.js';
import { FakeEventSource } from './support/fakeEventSource.js';
import { mockFetch } from './support/fetchMock.js';
import { APPROVAL_ID, LIMITS, approvalItem } from './support/fixtures.js';
import { Providers, fakeRoute } from './support/harness.js';

describe('ApprovalsView', () => {
  beforeEach(() => {
    FakeEventSource.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists a budget hold with its stripe and allows it once: token, then decision', async () => {
    let pending = [approvalItem('budget')];
    const { calls } = mockFetch({
      'GET /approvals': () => ({ approvals: pending }),
      'GET /limits': () => LIMITS,
      [`POST /approvals/${APPROVAL_ID}/token`]: () => ({
        token: 't'.repeat(43),
        expiresAt: '2026-09-09T10:10:00.000Z',
      }),
      [`POST /approvals/${APPROVAL_ID}/decide`]: (init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          token: string;
          decision: string;
        };
        expect(body.token).toBe('t'.repeat(43));
        expect(body.decision).toBe('approve');
        pending = [];
        return {
          approval: { ...approvalItem('budget').approval, status: 'approved' },
          resumed: true,
        };
      },
    });
    render(
      <Providers route={fakeRoute({ dest: 'approvals' })}>
        <ApprovalsView viewport="desktop" />
      </Providers>,
    );
    const row = await screen.findByRole('button', { name: /demo\.pay/ });
    expect(row.className).toContain('action--costly');
    expect(screen.getByText('Budget hold')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => {
      expect(screen.getByText('Nothing is waiting for your decision.')).toBeTruthy();
    });
    const order = calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(order).toEqual([`/approvals/${APPROVAL_ID}/token`, `/approvals/${APPROVAL_ID}/decide`]);
  });

  it('approving an irreversible call takes two clicks and selecting a row opens its detail', async () => {
    mockFetch({
      'GET /approvals': () => ({ approvals: [approvalItem('irreversible')] }),
      'GET /limits': () => LIMITS,
    });
    const setFocus = vi.fn();
    render(
      <Providers route={fakeRoute({ dest: 'approvals', setFocus })}>
        <ApprovalsView viewport="desktop" />
      </Providers>,
    );
    const row = await screen.findByRole('button', { name: /demo\.wipe/ });
    expect(row.className).toContain('action--irreversible');
    const approve = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    expect(screen.getByRole('button', { name: 'Confirm approve' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(row);
    expect(setFocus).toHaveBeenCalledWith({ approval: APPROVAL_ID });
  });
});
