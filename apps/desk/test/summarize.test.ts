import { EVENT_TYPES } from '@marsad/shared';
import { describe, expect, it } from 'vitest';
import { blastRadiusOf, impliedRunState, segmentsToText, summarize } from '../src/log/summarize.js';
import { makeEvent } from './support/events.js';

describe('summarize', () => {
  it('produces a non-empty summary for every event type in the contract', () => {
    for (const type of EVENT_TYPES) {
      const text = segmentsToText(summarize(makeEvent(1, type)));
      expect(text.length, type).toBeGreaterThan(0);
    }
  });

  it('keeps every number in a num segment so it renders tabular', () => {
    const segments = summarize(makeEvent(1, 'run.step'));
    const numbers = segments.filter((s) => s.kind === 'num').map((s) => s.text);
    expect(numbers).toEqual(['3', '1,234']);
    for (const s of segments) if (s.kind === 'text') expect(s.text).not.toMatch(/\d/);
  });

  it('derives the run state a row implies, and nothing for neutral rows', () => {
    expect(impliedRunState(makeEvent(1, 'run.started'))).toBe('running');
    expect(impliedRunState(makeEvent(1, 'run.blocked'))).toBe('blocked');
    expect(impliedRunState(makeEvent(1, 'run.failed'))).toBe('failed');
    expect(impliedRunState(makeEvent(1, 'system.halted'))).toBe('halted');
    expect(impliedRunState(makeEvent(1, 'tool.completed'))).toBeNull();
  });

  it('reports the blast radius of actions only', () => {
    expect(blastRadiusOf(makeEvent(1, 'tool.requested'))).toBe('costly');
    expect(blastRadiusOf(makeEvent(1, 'approval.requested'))).toBe('irreversible');
    expect(blastRadiusOf(makeEvent(1, 'run.step'))).toBeNull();
  });
});
