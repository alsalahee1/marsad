import { describe, expect, it } from 'vitest';
import { virtualWindow } from '../src/log/useVirtualRows.js';
import { classifyWidth } from '../src/shell/viewport.js';
import { destinationForPath, pathFor } from '../src/shell/navigation.js';
import { readPrefs } from '../src/lib/prefs.js';

describe('virtualWindow', () => {
  it('renders only the rows around the viewport, with overscan', () => {
    const w = virtualWindow({
      scrollTop: 280,
      viewportHeight: 140,
      rowHeight: 28,
      count: 1000,
      overscan: 2,
    });
    expect(w.start).toBe(8);
    expect(w.end).toBe(18);
    expect(w.totalHeight).toBe(28_000);
  });

  it('clamps at both ends and handles empty lists', () => {
    expect(
      virtualWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 28, count: 3, overscan: 8 }),
    ).toEqual({ start: 0, end: 3, totalHeight: 84 });
    expect(
      virtualWindow({ scrollTop: 0, viewportHeight: 100, rowHeight: 28, count: 0, overscan: 8 }),
    ).toEqual({ start: 0, end: 0, totalHeight: 0 });
  });
});

describe('breakpoints', () => {
  it('classifies the five CLAUDE.md widths exactly', () => {
    expect(classifyWidth(375)).toBe('phone');
    expect(classifyWidth(599)).toBe('phone');
    expect(classifyWidth(600)).toBe('fold');
    expect(classifyWidth(767)).toBe('fold');
    expect(classifyWidth(768)).toBe('tablet');
    expect(classifyWidth(1023)).toBe('tablet');
    expect(classifyWidth(1024)).toBe('desktop');
    expect(classifyWidth(1439)).toBe('desktop');
    expect(classifyWidth(1440)).toBe('wide');
  });
});

describe('navigation', () => {
  it('maps paths to the five destinations and unknown paths to the desk', () => {
    expect(destinationForPath('/')).toBe('desk');
    expect(destinationForPath('/log/')).toBe('log');
    expect(destinationForPath('/approvals')).toBe('approvals');
    expect(destinationForPath('/nope')).toBe('desk');
    expect(pathFor('settings')).toBe('/settings');
  });
});

describe('readPrefs', () => {
  it('falls back to defaults on missing, malformed, or foreign values', () => {
    expect(readPrefs(null)).toEqual({ theme: 'system', density: 'compact', railExpanded: false });
    expect(readPrefs({ getItem: () => '{nope' })).toEqual({
      theme: 'system',
      density: 'compact',
      railExpanded: false,
    });
    expect(
      readPrefs({
        getItem: () =>
          JSON.stringify({ theme: 'neon', density: 'comfortable', railExpanded: 'yes' }),
      }),
    ).toEqual({ theme: 'system', density: 'comfortable', railExpanded: false });
  });
});
