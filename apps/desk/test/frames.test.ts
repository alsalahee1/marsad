import { describe, expect, it } from 'vitest';
import { parseFrame } from '../src/log/frames.js';
import { makeEvent } from './support/events.js';

describe('parseFrame', () => {
  it('accepts a frame that matches EventSchema and narrows it', () => {
    const result = parseFrame(JSON.stringify(makeEvent(42, 'run.halted')));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.event.type).toBe('run.halted');
    if (result.event.type !== 'run.halted') throw new Error('narrowing');
    expect(result.event.payload.reason).toBe('ceiling.steps');
  });

  it('rejects malformed JSON', () => {
    const result = parseFrame('{nope');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('rejects an unknown type and a payload that does not fit its type', () => {
    const unknown = parseFrame(JSON.stringify({ ...makeEvent(1), type: 'run.exploded' }));
    expect(unknown).toMatchObject({ ok: false, reason: 'invalid_event' });
    const wrong = parseFrame(
      JSON.stringify({ ...makeEvent(2, 'run.halted'), payload: { reason: 'because' } }),
    );
    expect(wrong).toMatchObject({ ok: false, reason: 'invalid_event' });
    if (wrong.ok) throw new Error('expected failure');
    expect(wrong.detail).toContain('payload');
  });
});
