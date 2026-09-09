import type { Event, EventInput } from '@marsad/shared';
import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import type { EventStore } from '../store/types.js';

export type EventListener = (event: Event) => void;

export interface EventBus {
  /**
   * The only way anything in the engine emits an event. INSERT first; only a row that exists
   * in the append-only table is published to live subscribers. If the insert fails, nothing is
   * published and the caller sees the error.
   */
  insertEvent(input: EventInput): Promise<Event>;
  /** Live feed. Returns an unsubscribe function. Listeners must never throw. */
  subscribe(listener: EventListener): () => void;
  readonly listenerCount: number;
}

export function createEventBus(store: EventStore, clock: Clock, log?: Logger): EventBus {
  const listeners = new Set<EventListener>();
  return {
    async insertEvent(input) {
      const event = await store.insert(input, clock());
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          log?.error({ err, eventId: event.id }, 'event listener threw');
        }
      }
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}
