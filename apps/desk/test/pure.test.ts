import { describe, expect, it } from 'vitest';
import { approveLabel } from '../src/approvals/ApprovalActions.js';
import { brokeRuns } from '../src/desk/Tiles.js';
import { meterLevel } from '../src/lib/Meter.js';
import { SWIPE_THRESHOLD_PX, swipeSideFor } from '../src/lib/Swipeable.js';
import { filterItems, type PaletteItem } from '../src/shell/CommandPalette.js';
import { approvalItem, run } from './support/fixtures.js';

describe('meterLevel', () => {
  it('is ok below 75%, warn up to the cap, breach at or past it', () => {
    expect(meterLevel(0, 10)).toBe('ok');
    expect(meterLevel(7.4, 10)).toBe('ok');
    expect(meterLevel(7.5, 10)).toBe('warn');
    expect(meterLevel(10, 10)).toBe('breach');
    expect(meterLevel(12, 10)).toBe('breach');
    expect(meterLevel(1, 0)).toBe('breach');
    expect(meterLevel(0, 0)).toBe('ok');
  });
});

describe('swipeSideFor', () => {
  it('needs the threshold and follows the writing direction', () => {
    expect(swipeSideFor(SWIPE_THRESHOLD_PX - 1, false)).toBeNull();
    expect(swipeSideFor(SWIPE_THRESHOLD_PX, false)).toBe('leading');
    expect(swipeSideFor(-SWIPE_THRESHOLD_PX, false)).toBe('trailing');
    expect(swipeSideFor(SWIPE_THRESHOLD_PX, true)).toBe('trailing');
    expect(swipeSideFor(-SWIPE_THRESHOLD_PX, true)).toBe('leading');
  });
});

describe('approveLabel', () => {
  it('names the budget hold action and the armed state', () => {
    expect(approveLabel(approvalItem('irreversible'), false, false)).toBe('Approve');
    expect(approveLabel(approvalItem('irreversible'), true, false)).toBe('Confirm approve');
    expect(approveLabel(approvalItem('budget'), false, false)).toBe('Allow once');
    expect(approveLabel(approvalItem('budget'), false, true)).toBe('Deciding');
  });
});

describe('brokeRuns', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  it('keeps failed runs and ceiling halts from the last day, newest first', () => {
    const runs = [
      run('failed', { id: 'a', finishedAt: '2026-09-09T11:00:00.000Z' }),
      run('halted', {
        id: 'b',
        statusReason: 'ceiling.steps',
        finishedAt: '2026-09-09T11:30:00.000Z',
      }),
      run('halted', { id: 'c', statusReason: 'operator', finishedAt: '2026-09-09T11:40:00.000Z' }),
      run('failed', { id: 'd', finishedAt: '2026-09-07T11:00:00.000Z' }),
      run('done', { id: 'e', finishedAt: '2026-09-09T11:50:00.000Z' }),
    ];
    expect(brokeRuns(runs, now).map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('filterItems', () => {
  const items: PaletteItem[] = [
    { id: '1', group: 'Go to', label: 'Agents', run: () => undefined },
    { id: '2', group: 'Runs', label: 'reconcile invoices', hint: 'blocked', run: () => undefined },
    {
      id: '3',
      group: 'Actions',
      label: 'Halt all',
      hint: 'stop every worker',
      run: () => undefined,
    },
  ];
  it('matches label or hint case-insensitively and lists everything for an empty query', () => {
    expect(filterItems(items, '').map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(filterItems(items, 'BLOCK').map((i) => i.id)).toEqual(['2']);
    expect(filterItems(items, 'worker').map((i) => i.id)).toEqual(['3']);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});
