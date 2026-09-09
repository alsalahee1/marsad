import type { Event } from '@marsad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStreamStore } from '../src/log/stream.js';
import { FakeEventSource } from './support/fakeEventSource.js';
import { makeEvent, range } from './support/events.js';

type FetchTail = (limit: number, before?: string) => Promise<Event[]>;

function build(opts: { tail?: FetchTail; alive?: boolean } = {}) {
  const fetchTail = vi.fn<FetchTail>(opts.tail ?? (() => Promise.resolve(range(1, 3))));
  const sessionAlive = vi.fn(() => Promise.resolve(opts.alive ?? true));
  const store = new EventStreamStore({
    streamPath: '/events/stream',
    fetchTail,
    createSource: (url) => new FakeEventSource(url),
    sessionAlive,
    pageSize: 3,
    capacity: 100,
  });
  return { store, fetchTail, sessionAlive };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const source = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

describe('EventStreamStore', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the tail page, then opens the stream from the last id it holds', async () => {
    const { store, fetchTail } = build();
    await store.start();
    expect(fetchTail).toHaveBeenCalledWith(3);
    expect(store.getSnapshot().buffer.events.map((e) => e.id)).toEqual(['1', '2', '3']);
    expect(source()?.url).toBe('/events/stream?lastEventId=3');
    expect(store.getSnapshot().connection).toBe('connecting');
    source()?.open();
    expect(store.getSnapshot().connection).toBe('live');
  });

  it('opens without a cursor when the log is empty', async () => {
    const { store } = build({ tail: () => Promise.resolve([]) });
    await store.start();
    expect(source()?.url).toBe('/events/stream');
    expect(store.getSnapshot().historyExhausted).toBe(true);
  });

  it('validates every frame with EventSchema, batches good ones, counts bad ones', async () => {
    const { store } = build();
    const listener = vi.fn();
    store.subscribe(listener);
    await store.start();
    source()?.open();
    source()?.emit('run.step', makeEvent(4, 'run.step'));
    source()?.emit('run.step', makeEvent(5, 'run.step'));
    source()?.emit('run.halted', { ...makeEvent(6, 'run.halted'), payload: { reason: 'because' } });
    source()?.emit('system.resumed', '{nope');
    expect(store.getSnapshot().buffer.events).toHaveLength(3); // not flushed yet
    vi.advanceTimersByTime(20); // one animation frame
    const snap = store.getSnapshot();
    expect(snap.buffer.events.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(snap.invalidFrames).toBe(2);
    expect(snap.lastError).toContain('JSON');
  });

  it('ignores a replayed duplicate', async () => {
    const { store } = build();
    await store.start();
    source()?.open();
    source()?.emit('system.resumed', makeEvent(3));
    vi.advanceTimersByTime(20);
    expect(store.getSnapshot().buffer.events).toHaveLength(3);
  });

  it("marks the browser's own retry as reconnecting and leaves the source alone", async () => {
    const { store } = build();
    await store.start();
    source()?.open();
    source()?.drop();
    expect(store.getSnapshot().connection).toBe('reconnecting');
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('when the browser gives up, checks the session and reopens from the last id with backoff', async () => {
    const { store, sessionAlive } = build();
    await store.start();
    source()?.open();
    source()?.emit('system.resumed', makeEvent(4));
    vi.advanceTimersByTime(20);
    source()?.fail();
    expect(store.getSnapshot().connection).toBe('offline');
    await flush();
    expect(sessionAlive).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(source()?.url).toBe('/events/stream?lastEventId=4');
    expect(store.getSnapshot().connection).toBe('reconnecting');
    source()?.fail();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2); // second backoff is 2s
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('does not reconnect once the session is gone', async () => {
    const { store } = build({ alive: false });
    await store.start();
    source()?.open();
    source()?.fail();
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('retries the first page when it fails, instead of streaming blind', async () => {
    let calls = 0;
    const { store } = build({
      tail: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('engine unreachable'))
          : Promise.resolve(range(1, 2));
      },
    });
    await store.start();
    expect(store.getSnapshot().connection).toBe('offline');
    expect(store.getSnapshot().lastError).toBe('engine unreachable');
    expect(FakeEventSource.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(store.getSnapshot().buffer.events).toHaveLength(2);
    expect(source()?.url).toBe('/events/stream?lastEventId=2');
  });

  it('pages history backwards from the first id and knows when it is exhausted', async () => {
    const { store, fetchTail } = build();
    fetchTail.mockImplementation((_limit: number, before?: string) =>
      Promise.resolve(before === undefined ? range(10, 12) : range(8, 9)),
    );
    await store.start();
    await store.loadEarlier();
    expect(fetchTail).toHaveBeenLastCalledWith(3, '10');
    expect(store.getSnapshot().buffer.events.map((e) => e.id)).toEqual([
      '8',
      '9',
      '10',
      '11',
      '12',
    ]);
    expect(store.getSnapshot().historyExhausted).toBe(true);
  });

  it('stop closes the source and cancels any pending reconnect', async () => {
    const { store } = build();
    await store.start();
    source()?.open();
    source()?.fail();
    await flush();
    store.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(store.getSnapshot().connection).toBe('offline');
  });
});
