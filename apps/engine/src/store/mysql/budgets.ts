import type { Budget, BudgetScope } from '@marsad/shared';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { BudgetStore } from '../types.js';
import { affected, iso, num, numOrNull, str, type Row } from './rows.js';

function toBudget(row: Row): Budget {
  return {
    scope: str(row['scope']) as BudgetScope,
    key: str(row['scope_key']),
    spentUsd: num(row['spent_usd']),
    callCount: num(row['call_count']),
    capUsd: num(row['cap_usd']),
    capCalls: numOrNull(row['cap_calls']),
    updatedAt: iso(row['updated_at']),
  };
}

export function mysqlBudgetStore(pool: Pool): BudgetStore {
  async function getOne(scope: BudgetScope, key: string): Promise<Budget | null> {
    const [rows] = await pool.query<Row[]>(
      'SELECT scope, scope_key, spent_usd, call_count, cap_usd, cap_calls, updated_at FROM budgets WHERE scope = ? AND scope_key = ?',
      [scope, key],
    );
    const row = rows[0];
    return row ? toBudget(row) : null;
  }

  return {
    async reserve(scope, key, amountUsd, caps, now) {
      // Ensure the row exists with the caps currently in force (caps come from config, not the row).
      await pool.query(
        `INSERT INTO budgets (scope, scope_key, spent_usd, call_count, cap_usd, cap_calls, created_at, updated_at)
         VALUES (?, ?, 0, 0, ?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE cap_usd = new.cap_usd, cap_calls = new.cap_calls`,
        [scope, key, caps.capUsd, caps.capCalls, now, now],
      );
      const [res] = await pool.query<ResultSetHeader>(
        `UPDATE budgets SET spent_usd = spent_usd + ?, call_count = call_count + 1, updated_at = ?
         WHERE scope = ? AND scope_key = ?
           AND spent_usd + ? <= cap_usd
           AND (cap_calls IS NULL OR call_count + 1 <= cap_calls)`,
        [amountUsd, now, scope, key, amountUsd],
      );
      const budget = await getOne(scope, key);
      if (!budget) throw new Error('budget row vanished');
      return affected(res) === 1 ? { ok: true, budget } : { ok: false, budget };
    },

    async adjust(scope, key, deltaUsd, now) {
      await pool.query(
        'UPDATE budgets SET spent_usd = GREATEST(0, spent_usd + ?), updated_at = ? WHERE scope = ? AND scope_key = ?',
        [deltaUsd, now, scope, key],
      );
    },

    get: getOne,
  };
}
