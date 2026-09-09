import type { JsonValue } from '@marsad/shared';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type Row = RowDataPacket;

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string')
    return new Date(value.includes('Z') ? value : `${value}Z`).toISOString();
  throw new Error(`expected a date, got ${typeof value}`);
}

export function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(iso(value));
}

export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${String(value)}`);
  return n;
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`expected a string, got ${typeof value}`);
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

/** mysql2 parses JSON columns already; a raw string means a driver that did not. */
export function json(value: unknown): JsonValue {
  if (typeof value === 'string') return JSON.parse(value) as JsonValue;
  return value as JsonValue;
}

export function jsonOrNull(value: unknown): JsonValue | null {
  return value === null || value === undefined ? null : json(value);
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function affected(result: ResultSetHeader): number {
  return result.affectedRows;
}
