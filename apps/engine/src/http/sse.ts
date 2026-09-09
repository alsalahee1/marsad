import { SSE_HEARTBEAT_INTERVAL_MS, SSE_LAST_EVENT_ID_PARAM, type Event } from '@marsad/shared';
import type { Request, Response } from 'express';
import type { EventBus } from '../events/bus.js';
import type { Logger } from '../logger.js';
import type { EventStore } from '../store/types.js';

const REPLAY_BATCH = 500;

function frame(event: Event): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function lastEventIdOf(req: Request): string | null {
  const header = req.header('last-event-id');
  const query = req.query[SSE_LAST_EVENT_ID_PARAM];
  const raw = header ?? (typeof query === 'string' ? query : undefined);
  return raw !== undefined && /^\d+$/.test(raw) ? raw : null;
}

/**
 * GET /events/stream. With a Last-Event-ID (header or ?lastEventId=) the handler replays every
 * row after it from the events table, then switches to the live feed. Live events that arrive
 * during replay are buffered and de-duplicated by id, so nothing is skipped or repeated.
 */
export async function streamEvents(
  req: Request,
  res: Response,
  deps: { events: EventStore; bus: EventBus; log: Logger; heartbeatMs?: number },
): Promise<void> {
  const lastEventId = lastEventIdOf(req);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tell Nginx not to buffer this response, or nothing arrives until the buffer fills.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);
  res.write('retry: 3000\n\n');

  let lastSent: bigint = lastEventId === null ? -1n : BigInt(lastEventId);
  let replaying = lastEventId !== null;
  const buffered: Event[] = [];
  let closed = false;

  const send = (event: Event): void => {
    const id = BigInt(event.id);
    if (id <= lastSent) return;
    lastSent = id;
    res.write(frame(event));
  };

  const unsubscribe = deps.bus.subscribe((event) => {
    if (closed) return;
    if (replaying) buffered.push(event);
    else send(event);
  });

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': hb\n\n');
  }, deps.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  try {
    if (replaying) {
      let cursor: string | null = lastEventId;
      for (;;) {
        const batch = await deps.events.listAfter(cursor, REPLAY_BATCH);
        for (const event of batch) send(event);
        if (batch.length < REPLAY_BATCH) break;
        cursor = batch[batch.length - 1]?.id ?? cursor;
      }
      replaying = false;
      for (const event of buffered) send(event);
      buffered.length = 0;
    }
  } catch (err) {
    deps.log.error({ err }, 'sse replay failed');
    cleanup();
    res.end();
  }
}
