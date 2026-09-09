import type { BlastRadius, ToolCall, ToolCallStatus } from '@marsad/shared';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { IdempotencyConflictError } from '../../errors.js';
import type { ToolCallPatch, ToolCallStore } from '../types.js';
import {
  affected,
  iso,
  isoOrNull,
  json,
  jsonOrNull,
  num,
  numOrNull,
  str,
  strOrNull,
  toJson,
  type Row,
} from './rows.js';

const COLUMNS =
  'id, run_id, step, tool, blast_radius, idempotency_key, status, input, output, estimated_cost_usd, actual_cost_usd, error, created_at, started_at, finished_at';

function toToolCall(row: Row): ToolCall {
  return {
    id: str(row['id']),
    runId: str(row['run_id']),
    step: num(row['step']),
    tool: str(row['tool']),
    blastRadius: str(row['blast_radius']) as BlastRadius,
    idempotencyKey: str(row['idempotency_key']),
    status: str(row['status']) as ToolCallStatus,
    input: json(row['input']),
    output: jsonOrNull(row['output']),
    estimatedCostUsd: num(row['estimated_cost_usd']),
    actualCostUsd: numOrNull(row['actual_cost_usd']),
    error: strOrNull(row['error']),
    createdAt: iso(row['created_at']),
    startedAt: isoOrNull(row['started_at']),
    finishedAt: isoOrNull(row['finished_at']),
  };
}

function isDuplicateKey(err: unknown, index: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ER_DUP_ENTRY' &&
    String((err as { message?: string }).message).includes(index)
  );
}

export function mysqlToolCallStore(pool: Pool): ToolCallStore {
  async function getOne(where: string, params: unknown[]): Promise<ToolCall | null> {
    const [rows] = await pool.query<Row[]>(
      `SELECT ${COLUMNS} FROM tool_calls WHERE ${where} LIMIT 1`,
      params,
    );
    const row = rows[0];
    return row ? toToolCall(row) : null;
  }

  return {
    async insert(input, now) {
      try {
        await pool.query(
          `INSERT INTO tool_calls (id, run_id, step, tool, blast_radius, idempotency_key, status, input, estimated_cost_usd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.runId,
            input.step,
            input.tool,
            input.blastRadius,
            input.idempotencyKey,
            input.status,
            toJson(input.input),
            input.estimatedCostUsd,
            now,
            now,
          ],
        );
      } catch (err) {
        if (isDuplicateKey(err, 'uq_tool_calls_idempotency'))
          throw new IdempotencyConflictError(input.idempotencyKey);
        throw err;
      }
      const tc = await getOne('id = ?', [input.id]);
      if (!tc) throw new Error('tool call vanished after insert');
      return tc;
    },

    get: (id) => getOne('id = ?', [id]),
    findByIdempotencyKey: (key) => getOne('idempotency_key = ?', [key]),
    findByRunAndStatus: (runId, status) =>
      getOne('run_id = ? AND status = ? ORDER BY step ASC', [runId, status]),

    async listByRun(runId) {
      const [rows] = await pool.query<Row[]>(
        `SELECT ${COLUMNS} FROM tool_calls WHERE run_id = ? ORDER BY step ASC, created_at ASC`,
        [runId],
      );
      return rows.map(toToolCall);
    },

    async transition(id, from, to, now, patch: ToolCallPatch = {}) {
      if (from.length === 0) return false;
      const sets = ['status = ?', 'updated_at = ?'];
      const params: unknown[] = [to, now];
      if (patch.output !== undefined) {
        sets.push('output = ?');
        params.push(patch.output === null ? null : toJson(patch.output));
      }
      if (patch.actualCostUsd !== undefined) {
        sets.push('actual_cost_usd = ?');
        params.push(patch.actualCostUsd);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        params.push(patch.error);
      }
      if (patch.startedAt !== undefined) {
        sets.push('started_at = ?');
        params.push(patch.startedAt);
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        params.push(patch.finishedAt);
      }
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE tool_calls SET ${sets.join(', ')} WHERE id = ? AND status IN (?)`,
        [...params, id, from],
      );
      return affected(res) === 1;
    },
  };
}
