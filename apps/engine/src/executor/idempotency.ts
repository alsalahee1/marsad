import { createHash } from 'node:crypto';
import type { JsonValue } from '@marsad/shared';

/** JSON with object keys sorted at every level, so equal inputs hash equally. */
export function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] ?? null)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic key for a tool call: the same run, step, tool and input always map to the
 * same key, so a retried worker finds the existing row instead of inserting a second one.
 */
export function deriveIdempotencyKey(
  runId: string,
  step: number,
  tool: string,
  input: JsonValue,
): string {
  return createHash('sha256')
    .update(`${runId}\n${step}\n${tool}\n${stableStringify(input)}`)
    .digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
