import type { EventSourceLike } from '../../src/log/stream.js';

/** A controllable EventSource: tests emit frames, open, and fail it by hand. */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = FakeEventSource.CONNECTING;
  onopen: ((ev: globalThis.Event) => unknown) | null = null;
  onerror: ((ev: globalThis.Event) => unknown) | null = null;
  readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Deliver a frame as the browser would: only listeners for the `event:` type fire. */
  emit(type: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data: payload }));
  }

  /** The browser gave up: readyState CLOSED, then onerror. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }

  /** The browser is retrying on its own. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}
