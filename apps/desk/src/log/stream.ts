import { EVENT_TYPES, SSE_LAST_EVENT_ID_PARAM, type Event } from '@marsad/shared';
import {
  appendEvents,
  createBuffer,
  firstId,
  lastId,
  prependEvents,
  type EventBuffer,
} from './eventBuffer.js';
import { parseFrame } from './frames.js';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface StreamSnapshot {
  readonly buffer: EventBuffer;
  readonly connection: ConnectionState;
  /** Frames that failed EventSchema and were dropped. Shown, never hidden. */
  readonly invalidFrames: number;
  /** Rows appended since the log was last scrolled to its tail; the follow toggle shows it. */
  readonly historyExhausted: boolean;
  readonly loadingHistory: boolean;
  readonly lastError: string | null;
}

/** The subset of EventSource the store touches, so tests can hand in a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: globalThis.Event) => unknown) | null;
  onerror: ((ev: globalThis.Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface StreamDeps {
  fetchTail(limit: number, before?: string): Promise<Event[]>;
  createSource(url: string): EventSourceLike;
  /** Resolves false when the session is gone (401); the auth gate is already reacting. */
  sessionAlive(): Promise<boolean>;
  streamPath: string;
  pageSize?: number;
  capacity?: number;
}

const READY_CLOSED = 2;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;

type Listener = () => void;

/**
 * Owns the log's life: first page from `/events/tail`, then one EventSource on
 * `/events/stream?lastEventId=<last id>`, every frame through EventSchema, batched into the
 * buffer once per animation frame. The browser resends `Last-Event-ID` on its own retries;
 * when it gives up (an HTTP error closes the source for good) the store checks the session and
 * reopens from the last id it holds, with exponential backoff. Framework-free: React reads it
 * through useSyncExternalStore.
 */
export class EventStreamStore {
  #snapshot: StreamSnapshot;
  readonly #listeners = new Set<Listener>();
  readonly #deps: StreamDeps;
  readonly #pageSize: number;
  #source: EventSourceLike | null = null;
  #pending: Event[] = [];
  #flushScheduled = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #running = false;

  constructor(deps: StreamDeps) {
    this.#deps = deps;
    this.#pageSize = deps.pageSize ?? 300;
    this.#snapshot = {
      buffer: createBuffer(deps.capacity),
      connection: 'connecting',
      invalidFrames: 0,
      historyExhausted: false,
      loadingHistory: false,
      lastError: null,
    };
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): StreamSnapshot => this.#snapshot;

  /** Load the first page, then go live. Idempotent. */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const page = await this.#deps.fetchTail(this.#pageSize);
      if (this.#stopped()) return;
      const { buffer } = appendEvents(this.#snapshot.buffer, page);
      this.#set({ buffer, historyExhausted: page.length < this.#pageSize, lastError: null });
    } catch (err) {
      if (this.#stopped()) return;
      this.#set({ lastError: describe(err), connection: 'offline' });
      this.#scheduleReconnect();
      return;
    }
    this.#open();
  }

  stop(): void {
    this.#running = false;
    this.#closeSource();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#set({ connection: 'offline' });
  }

  /** Page backwards from the first row held. */
  async loadEarlier(): Promise<void> {
    const snap = this.#snapshot;
    if (snap.loadingHistory || snap.historyExhausted) return;
    const before = firstId(snap.buffer);
    if (before === null) return;
    this.#set({ loadingHistory: true });
    try {
      const older = await this.#deps.fetchTail(this.#pageSize, before);
      this.#set({
        buffer: prependEvents(this.#snapshot.buffer, older),
        historyExhausted: older.length < this.#pageSize,
        loadingHistory: false,
        lastError: null,
      });
    } catch (err) {
      this.#set({ loadingHistory: false, lastError: describe(err) });
    }
  }

  #open(): void {
    // Anything still batched belongs in the buffer before we decide where to resume from.
    this.#flush();
    this.#closeSource();
    const last = lastId(this.#snapshot.buffer);
    const url =
      last === null
        ? this.#deps.streamPath
        : `${this.#deps.streamPath}?${SSE_LAST_EVENT_ID_PARAM}=${encodeURIComponent(last)}`;
    const source = this.#deps.createSource(url);
    this.#source = source;
    this.#set({ connection: this.#attempt === 0 ? 'connecting' : 'reconnecting' });

    source.onopen = () => {
      if (this.#source !== source) return;
      this.#attempt = 0;
      this.#set({ connection: 'live', lastError: null });
    };
    source.onerror = () => {
      if (this.#source !== source) return;
      if (source.readyState === READY_CLOSED) {
        // The browser will not retry (non-200, wrong content type, network fatal). Our turn.
        this.#source = null;
        this.#set({ connection: 'offline' });
        void this.#recoverAfterClose();
      } else {
        // The browser is retrying itself and will send Last-Event-ID.
        this.#set({ connection: 'reconnecting' });
      }
    };
    const onFrame = (ev: MessageEvent<string>) => {
      if (this.#source !== source) return;
      const result = parseFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (result.ok) {
        this.#pending.push(result.event);
        this.#scheduleFlush();
      } else {
        this.#set({ invalidFrames: this.#snapshot.invalidFrames + 1, lastError: result.detail });
      }
    };
    // Frames carry `event: <type>`, so `onmessage` never fires: subscribe to every known type.
    for (const type of EVENT_TYPES) source.addEventListener(type, onFrame);
  }

  async #recoverAfterClose(): Promise<void> {
    if (this.#stopped()) return;
    // A failed check means unreachable, not unauthorised: keep trying.
    const alive = await this.#deps.sessionAlive().catch(() => true);
    if (!alive || this.#stopped()) return; // the auth gate is unmounting us
    this.#scheduleReconnect();
  }

  /** `#running` can flip during any await; a method call keeps TypeScript from narrowing it. */
  #stopped(): boolean {
    return !this.#running;
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#running) return;
      if (this.#snapshot.buffer.events.length === 0 && this.#snapshot.lastError !== null) {
        // The first page never arrived: try the whole start again rather than stream blind.
        this.#running = false;
        void this.start();
        return;
      }
      this.#open();
    }, delay);
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const run = () => {
      this.#flushScheduled = false;
      this.#flush();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  #flush(): void {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    const { buffer } = appendEvents(this.#snapshot.buffer, batch);
    if (buffer !== this.#snapshot.buffer) this.#set({ buffer });
  }

  #closeSource(): void {
    if (this.#source) {
      const s = this.#source;
      this.#source = null;
      s.close();
    }
    this.#pending = [];
  }

  #set(patch: Partial<StreamSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
