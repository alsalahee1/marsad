import type { AgentStats, Run, RunStatus } from '@marsad/shared';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { RunPatch, RunStore } from '../types.js';
import {
  affected,
  dateOrNull,
  iso,
  isoOrNull,
  jsonOrNull,
  num,
  str,
  strOrNull,
  toJson,
  type Row,
} from './rows.js';

const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'halted'];

function toRun(row: Row): Run {
  const kind = strOrNull(row['blocked_on_kind']);
  return {
    id: str(row['id']),
    agentId: str(row['agent_id']),
    status: str(row['status']) as RunStatus,
    task: str(row['task']),
    stepCount: num(row['step_count']),
    tokensUsed: num(row['tokens_used']),
    costUsd: num(row['cost_usd']),
    activeMs: num(row['active_ms']),
    statusReason: strOrNull(row['status_reason']),
    blockedOn:
      kind === null
        ? null
        : { kind: kind as 'approval' | 'budget', id: strOrNull(row['blocked_on_id']) },
    output: jsonOrNull(row['output']),
    createdAt: iso(row['created_at']),
    startedAt: isoOrNull(row['started_at']),
    finishedAt: isoOrNull(row['finished_at']),
    updatedAt: iso(row['updated_at']),
  };
}

const COLUMNS =
  'id, agent_id, status, task, step_count, tokens_used, cost_usd, active_ms, status_reason, blocked_on_kind, blocked_on_id, output, created_at, started_at, finished_at, updated_at';

function patchClauses(patch: RunPatch | undefined, sets: string[], params: unknown[]): void {
  if (!patch) return;
  if (patch.statusReason !== undefined) {
    sets.push('status_reason = ?');
    params.push(patch.statusReason);
  }
  if (patch.blockedOn !== undefined) {
    sets.push('blocked_on_kind = ?', 'blocked_on_id = ?');
    params.push(patch.blockedOn?.kind ?? null, patch.blockedOn?.id ?? null);
  }
  if (patch.output !== undefined) {
    sets.push('output = ?');
    params.push(patch.output === null ? null : toJson(patch.output));
  }
}

/** SET clauses shared by single and bulk transitions. */
function transitionSets(
  to: RunStatus,
  now: Date,
  patch: RunPatch | undefined,
): { sets: string[]; params: unknown[] } {
  const sets: string[] = ['status = ?'];
  const params: unknown[] = [to];
  if (to === 'running') {
    sets.push(
      'claimed_at = ?',
      'started_at = COALESCE(started_at, ?)',
      'status_reason = NULL',
      'blocked_on_kind = NULL',
      'blocked_on_id = NULL',
    );
    params.push(now, now);
  } else {
    sets.push(
      'active_ms = active_ms + IF(claimed_at IS NULL, 0, GREATEST(0, TIMESTAMPDIFF(MICROSECOND, claimed_at, ?) DIV 1000))',
      'claimed_at = NULL',
    );
    params.push(now);
    if (TERMINAL.includes(to)) {
      sets.push('finished_at = ?');
      params.push(now);
    }
    if (to !== 'blocked') {
      sets.push('blocked_on_kind = NULL', 'blocked_on_id = NULL');
    }
  }
  patchClauses(patch, sets, params);
  sets.push('updated_at = ?');
  params.push(now);
  return { sets, params };
}

export function mysqlRunStore(pool: Pool): RunStore {
  async function getRun(id: string): Promise<Run | null> {
    const [rows] = await pool.query<Row[]>(`SELECT ${COLUMNS} FROM runs WHERE id = ?`, [id]);
    const row = rows[0];
    return row ? toRun(row) : null;
  }

  return {
    async create(input, now) {
      await pool.query(
        `INSERT INTO runs (id, agent_id, status, task, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)`,
        [input.id, input.agentId, input.task, now, now],
      );
      const run = await getRun(input.id);
      if (!run) throw new Error('run vanished after insert');
      return run;
    },

    get: getRun,

    async list(filter) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.status) {
        where.push('status = ?');
        params.push(filter.status);
      }
      if (filter.agentId !== undefined) {
        where.push('agent_id = ?');
        params.push(filter.agentId);
      }
      if (filter.before) {
        const at = new Date(filter.before.createdAt);
        where.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(at, at, filter.before.id);
      }
      params.push(filter.limit);
      const [rows] = await pool.query<Row[]>(
        `SELECT ${COLUMNS} FROM runs
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        params,
      );
      return rows.map(toRun);
    },

    async agentStats(since) {
      const [totals] = await pool.query<Row[]>(
        `SELECT agent_id,
                COALESCE(SUM(created_at >= ?), 0) AS runs_today,
                COALESCE(SUM(IF(created_at >= ?, cost_usd, 0)), 0) AS spent_today_usd,
                MAX(created_at) AS last_run_at
           FROM runs GROUP BY agent_id`,
        [since, since],
      );
      const [active] = await pool.query<Row[]>(
        `SELECT id, agent_id, status FROM runs
          WHERE status IN ('queued', 'running', 'blocked')
          ORDER BY created_at DESC, id DESC`,
      );
      const activeByAgent = new Map<string, { id: string; status: RunStatus }>();
      for (const r of active) {
        const agentId = str(r['agent_id']);
        if (!activeByAgent.has(agentId))
          activeByAgent.set(agentId, { id: str(r['id']), status: str(r['status']) as RunStatus });
      }
      return totals.map((r): AgentStats => {
        const agentId = str(r['agent_id']);
        return {
          agentId,
          activeRun: activeByAgent.get(agentId) ?? null,
          runsToday: num(r['runs_today']),
          spentTodayUsd: num(r['spent_today_usd']),
          lastRunAt: isoOrNull(r['last_run_at']),
        };
      });
    },

    async transition(id, from, to, now, patch) {
      if (from.length === 0) return false;
      const { sets, params } = transitionSets(to, now, patch);
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND status IN (?)`,
        [...params, id, from],
      );
      return affected(res) === 1;
    },

    async transitionAll(from, to, now, patch) {
      if (from.length === 0) return [];
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query<Row[]>(
          'SELECT id FROM runs WHERE status IN (?) FOR UPDATE',
          [from],
        );
        const ids = rows.map((r) => str(r['id']));
        if (ids.length > 0) {
          const { sets, params } = transitionSets(to, now, patch);
          await conn.query(`UPDATE runs SET ${sets.join(', ')} WHERE id IN (?)`, [...params, ids]);
        }
        await conn.commit();
        return ids;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },

    async recordStep(id, tokens, now) {
      await pool.query(
        'UPDATE runs SET step_count = step_count + 1, tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?',
        [tokens, now, id],
      );
    },

    async addCost(id, usd, now) {
      await pool.query('UPDATE runs SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?', [
        usd,
        now,
        id,
      ]);
    },

    activeMs(run, claimedAt, now) {
      return run.activeMs + (claimedAt ? Math.max(0, now.getTime() - claimedAt.getTime()) : 0);
    },

    async getClaimedAt(id) {
      const [rows] = await pool.query<Row[]>('SELECT claimed_at FROM runs WHERE id = ?', [id]);
      return dateOrNull(rows[0]?.['claimed_at']);
    },
  };
}
