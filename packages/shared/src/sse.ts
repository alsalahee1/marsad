import { z } from 'zod';
import { JsonValueSchema } from './json.js';

/**
 * One SSE `data:` frame on `GET /events/stream`. The engine writes every event row exactly
 * as one envelope; the desk validates with {@link EventSchema} to narrow the payload.
 *
 * `id` doubles as the SSE `id:` field, so a reconnecting EventSource resumes from the last row
 * it saw via `Last-Event-ID`.
 */
export const SseEnvelopeSchema = z.object({
  id: z.string().regex(/^\d+$/),
  type: z.string().min(1),
  runId: z.uuid().optional(),
  at: z.iso.datetime(),
  payload: JsonValueSchema,
});
export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;

/** The engine writes a comment frame this often so proxies and clients see a live socket. */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
/** Query parameter accepted on first connect, when the browser cannot send `Last-Event-ID`. */
export const SSE_LAST_EVENT_ID_PARAM = 'lastEventId';
