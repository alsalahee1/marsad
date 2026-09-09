import { EventSchema, type Event } from '@marsad/shared';

export type FrameResult =
  | { ok: true; event: Event }
  | { ok: false; reason: 'invalid_json' | 'invalid_event'; detail: string };

/**
 * One SSE `data:` frame in, one narrowed Event out. The schema is the contract: a frame that
 * does not match is dropped and counted, never rendered with a guessed shape.
 */
export function parseFrame(data: string): FrameResult {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch (err) {
    return { ok: false, reason: 'invalid_json', detail: err instanceof Error ? err.message : '' };
  }
  const parsed = EventSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'invalid_event',
      detail: first ? `${first.path.map(String).join('.')}: ${first.message}` : 'schema mismatch',
    };
  }
  return { ok: true, event: parsed.data };
}
