import type { Pool } from 'mysql2/promise';
import type { Store } from '../types.js';
import { mysqlApprovalStore } from './approvals.js';
import { mysqlBudgetStore } from './budgets.js';
import { mysqlEventStore } from './events.js';
import { mysqlAgentStore, mysqlFlagStore, mysqlToolSnapshotStore } from './misc.js';
import { mysqlRunStore } from './runs.js';
import { mysqlToolCallStore } from './toolCalls.js';

export function createMysqlStore(pool: Pool): Store {
  return {
    events: mysqlEventStore(pool),
    runs: mysqlRunStore(pool),
    toolCalls: mysqlToolCallStore(pool),
    approvals: mysqlApprovalStore(pool),
    budgets: mysqlBudgetStore(pool),
    tools: mysqlToolSnapshotStore(pool),
    agents: mysqlAgentStore(pool),
    flags: mysqlFlagStore(pool),
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
