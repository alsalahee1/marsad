import type { Approval, ApprovalStatus } from '@marsad/shared';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { ApprovalStore } from '../types.js';
import { affected, iso, isoOrNull, str, strOrNull, type Row } from './rows.js';

const COLUMNS =
  'id, run_id, tool_call_id, status, token_expires_at, decided_at, decided_by, created_at';

function toApproval(row: Row): Approval {
  return {
    id: str(row['id']),
    runId: str(row['run_id']),
    toolCallId: str(row['tool_call_id']),
    status: str(row['status']) as ApprovalStatus,
    tokenExpiresAt: isoOrNull(row['token_expires_at']),
    decidedAt: isoOrNull(row['decided_at']),
    decidedBy: strOrNull(row['decided_by']),
    createdAt: iso(row['created_at']),
  };
}

export function mysqlApprovalStore(pool: Pool): ApprovalStore {
  async function getOne(id: string): Promise<Approval | null> {
    const [rows] = await pool.query<Row[]>(`SELECT ${COLUMNS} FROM approvals WHERE id = ?`, [id]);
    const row = rows[0];
    return row ? toApproval(row) : null;
  }

  return {
    async create(input, now) {
      await pool.query(
        `INSERT INTO approvals (id, run_id, tool_call_id, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
        [input.id, input.runId, input.toolCallId, now, now],
      );
      const a = await getOne(input.id);
      if (!a) throw new Error('approval vanished after insert');
      return a;
    },

    get: getOne,

    async list(filter) {
      const params: unknown[] = [];
      let where = '';
      if (filter.status) {
        where = 'WHERE status = ?';
        params.push(filter.status);
      }
      params.push(filter.limit);
      const [rows] = await pool.query<Row[]>(
        `SELECT ${COLUMNS} FROM approvals ${where} ORDER BY created_at ASC LIMIT ?`,
        params,
      );
      return rows.map(toApproval);
    },

    async setToken(id, tokenHash, expiresAt, now) {
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE approvals SET token_hash = ?, token_expires_at = ?, token_used_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [tokenHash, expiresAt, now, id],
      );
      return affected(res) === 1;
    },

    async consumeToken(id, tokenHash, decision, decidedBy, now) {
      const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'rejected';
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE approvals
           SET status = ?, decided_at = ?, decided_by = ?, token_used_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND token_hash = ? AND token_used_at IS NULL AND token_expires_at > ?`,
        [status, now, decidedBy, now, now, id, tokenHash, now],
      );
      return affected(res) === 1;
    },
  };
}
