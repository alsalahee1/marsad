import type { Event } from '@marsad/shared';

/**
 * The desk's window onto the append-only log: events in ascending id order, deduplicated,
 * capped. Immutable — every operation returns a new buffer, which is what lets React and
 * useSyncExternalStore treat it as a snapshot.
 */
export interface EventBuffer {
  readonly events: readonly Event[];
  readonly capacity: number;
  /** Rows evicted from the front to stay within capacity (never lost: they are in MySQL). */
  readonly evicted: number;
}

export const DEFAULT_CAPACITY = 5000;

export function createBuffer(capacity = DEFAULT_CAPACITY): EventBuffer {
  return { events: [], capacity, evicted: 0 };
}

/** Numeric order for decimal-string BIGINT ids without BigInt allocations on every frame. */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function lastId(buffer: EventBuffer): string | null {
  const last = buffer.events[buffer.events.length - 1];
  return last ? last.id : null;
}

export function firstId(buffer: EventBuffer): string | null {
  const first = buffer.events[0];
  return first ? first.id : null;
}

/**
 * Append live or replayed rows. Anything at or below the last known id is a duplicate (a
 * replay overlapping the first page, a retried reconnect) and is dropped. Incoming rows are
 * assumed ascending, as the stream guarantees; the guard only costs one comparison each.
 */
export function appendEvents(
  buffer: EventBuffer,
  incoming: readonly Event[],
): { buffer: EventBuffer; added: number } {
  if (incoming.length === 0) return { buffer, added: 0 };
  let last = lastId(buffer);
  const fresh: Event[] = [];
  for (const event of incoming) {
    if (last !== null && compareIds(event.id, last) <= 0) continue;
    fresh.push(event);
    last = event.id;
  }
  if (fresh.length === 0) return { buffer, added: 0 };
  let events = buffer.events.concat(fresh);
  let evicted = buffer.evicted;
  if (events.length > buffer.capacity) {
    const overflow = events.length - buffer.capacity;
    events = events.slice(overflow);
    evicted += overflow;
  }
  return { buffer: { events, capacity: buffer.capacity, evicted }, added: fresh.length };
}

/**
 * Prepend an older page (ascending). Only rows strictly before the current first id are
 * taken. The capacity is not applied here: history the operator asked for is never thrown
 * away for being long.
 */
export function prependEvents(buffer: EventBuffer, older: readonly Event[]): EventBuffer {
  const first = firstId(buffer);
  const fresh = first === null ? [...older] : older.filter((e) => compareIds(e.id, first) < 0);
  if (fresh.length === 0) return buffer;
  return { ...buffer, events: fresh.concat(buffer.events) };
}
