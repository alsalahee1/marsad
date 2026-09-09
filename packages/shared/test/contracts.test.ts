import { describe, expect, it } from 'vitest';
import {
  BLAST_RADII,
  EVENT_TYPES,
  EventSchema,
  RUN_STATUSES,
  SseEnvelopeSchema,
  type Event,
} from '../src/index.js';

describe('run state and blast radius contracts', () => {
  it('has exactly the six run states from CLAUDE.md §3, in theme order', () => {
    expect(RUN_STATUSES).toEqual(['queued', 'running', 'blocked', 'done', 'failed', 'halted']);
  });

  it('has exactly three blast radii', () => {
    expect(BLAST_RADII).toEqual(['reversible', 'costly', 'irreversible']);
  });
});

describe('event union', () => {
  const base = {
    id: '42',
    runId: '9b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e',
    at: '2026-09-09T10:00:00.000Z',
  };

  it('narrows payload by type', () => {
    const parsed = EventSchema.parse({
      ...base,
      type: 'run.halted',
      payload: { reason: 'ceiling.steps', limit: 40, value: 40 },
    });
    if (parsed.type !== 'run.halted') throw new Error('expected run.halted');
    expect(parsed.payload.reason).toBe('ceiling.steps');
  });

  it('rejects an unknown type and a payload that does not match the type', () => {
    expect(EventSchema.safeParse({ ...base, type: 'run.exploded', payload: {} }).success).toBe(
      false,
    );
    expect(
      EventSchema.safeParse({ ...base, type: 'run.halted', payload: { reason: 'because' } })
        .success,
    ).toBe(false);
  });

  it('every event is a valid SSE envelope', () => {
    const ev: Event = { ...base, type: 'system.resumed', payload: { by: 'operator' } };
    expect(SseEnvelopeSchema.safeParse(ev).success).toBe(true);
  });

  it('lists every event type exactly once', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(EVENT_TYPES).toContain('system.halted');
  });
});
