import { describe, expect, it } from 'vitest';
import {
  appendEvents,
  compareIds,
  createBuffer,
  firstId,
  lastId,
  prependEvents,
} from '../src/log/eventBuffer.js';
import { makeEvent, range } from './support/events.js';

describe('compareIds', () => {
  it('orders decimal-string ids numerically, not lexically', () => {
    expect(compareIds('9', '10')).toBeLessThan(0);
    expect(compareIds('10', '9')).toBeGreaterThan(0);
    expect(compareIds('123', '123')).toBe(0);
    expect(compareIds('18446744073709551615', '18446744073709551614')).toBeGreaterThan(0);
  });
});

describe('appendEvents', () => {
  it('appends in order and reports how many were new', () => {
    const { buffer, added } = appendEvents(createBuffer(), range(1, 3));
    expect(added).toBe(3);
    expect(buffer.events.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(lastId(buffer)).toBe('3');
    expect(firstId(buffer)).toBe('1');
  });

  it('drops anything at or below the last known id (replay overlap, retried reconnect)', () => {
    const first = appendEvents(createBuffer(), range(1, 5)).buffer;
    const { buffer, added } = appendEvents(first, [...range(3, 5), makeEvent(6), makeEvent(6)]);
    expect(added).toBe(1);
    expect(buffer.events.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('returns the same buffer instance when nothing is new', () => {
    const first = appendEvents(createBuffer(), range(1, 2)).buffer;
    expect(appendEvents(first, range(1, 2)).buffer).toBe(first);
    expect(appendEvents(first, []).buffer).toBe(first);
  });

  it('evicts from the front beyond capacity and counts the evictions', () => {
    const { buffer } = appendEvents(createBuffer(3), range(1, 5));
    expect(buffer.events.map((e) => e.id)).toEqual(['3', '4', '5']);
    expect(buffer.evicted).toBe(2);
  });
});

describe('prependEvents', () => {
  it('prepends only rows strictly before the first held id', () => {
    const live = appendEvents(createBuffer(), range(10, 12)).buffer;
    const older = prependEvents(live, range(7, 10));
    expect(older.events.map((e) => e.id)).toEqual(['7', '8', '9', '10', '11', '12']);
  });

  it('ignores capacity: history the operator asked for is kept', () => {
    const live = appendEvents(createBuffer(3), range(10, 12)).buffer;
    const older = prependEvents(live, range(1, 9));
    expect(older.events).toHaveLength(12);
    expect(older.evicted).toBe(0);
  });

  it('returns the same instance when nothing qualifies', () => {
    const live = appendEvents(createBuffer(), range(10, 12)).buffer;
    expect(prependEvents(live, range(10, 12))).toBe(live);
  });
});
