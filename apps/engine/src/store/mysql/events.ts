import { EventSchema, type Event } from '@marsad/shared';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { EventStore } from '../types.js';
import { iso, json, str, strOrNull, toJson, type Row } from './rows.js';

function toEvent(row: Row): Event {
  const runId = strOrNull(row['run_id']);
  return EventSchema.parse({
    id: str(row['id']),
    type: str(row['type']),
    ...(runId === null ? {} : { runId }),
    at: iso(row['at']),
    payload: json(row['payload']),
  });
}

export function mysqlEventStore(pool: Pool): EventStore {
  return {
    async insert(input, at) {
      const [res] = await pool.query<ResultSetHeader>(
        'INSERT INTO events (type, run_id, payload, at) VALUES (?, ?, ?, ?)',
        [input.type, input.runId ?? null, toJson(input.payload), at],
      );
      return {
        id: String(res.insertId),
        type: input.type,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        at: at.toISOString(),
        payload: input.payload,
      } as Event;
    },

    async listAfter(afterId, limit, runId) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (afterId !== null) {
        where.push('id > ?');
        params.push(afterId);
      }
      if (runId !== undefined) {
        where.push('run_id = ?');
        params.push(runId);
      }
      params.push(limit);
      const [rows] = await pool.query<Row[]>(
        `SELECT id, type, run_id, payload, at FROM events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id ASC LIMIT ?`,
        params,
      );
      return rows.map(toEvent);
    },
  };
}
