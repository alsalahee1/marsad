import type { Agent, BlastRadius } from '@marsad/shared';
import type { Pool } from 'mysql2/promise';
import type { AgentStore, FlagStore, HaltState, ToolSnapshotStore } from '../types.js';
import { iso, json, num, str, toJson, type Row } from './rows.js';

export function mysqlToolSnapshotStore(pool: Pool): ToolSnapshotStore {
  return {
    async snapshot(tools, now) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('UPDATE tools SET active = 0, snapshotted_at = ? WHERE active = 1', [now]);
        for (const t of tools) {
          await conn.query(
            `INSERT INTO tools (name, description, blast_radius, input_schema, version, active, snapshotted_at)
             VALUES (?, ?, ?, ?, ?, 1, ?) AS new
             ON DUPLICATE KEY UPDATE description = new.description, blast_radius = new.blast_radius,
               input_schema = new.input_schema, version = new.version, active = 1, snapshotted_at = new.snapshotted_at`,
            [t.name, t.description, t.blastRadius, toJson(t.inputSchema), t.version, now],
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    },

    async list() {
      const [rows] = await pool.query<Row[]>(
        'SELECT name, description, blast_radius, input_schema, version, active FROM tools ORDER BY name',
      );
      return rows.map((r) => ({
        name: str(r['name']),
        description: str(r['description']),
        blastRadius: str(r['blast_radius']) as BlastRadius,
        inputSchema: json(r['input_schema']),
        version: str(r['version']),
        active: num(r['active']) === 1,
      }));
    },
  };
}

function toAgent(row: Row): Agent {
  return {
    id: str(row['id']),
    name: str(row['name']),
    model: str(row['model']),
    systemPrompt: str(row['system_prompt']),
    tools: json(row['tools']) as string[],
    enabled: num(row['enabled']) === 1,
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  };
}

const AGENT_COLUMNS = 'id, name, model, system_prompt, tools, enabled, created_at, updated_at';

export function mysqlAgentStore(pool: Pool): AgentStore {
  async function getOne(id: string): Promise<Agent | null> {
    const [rows] = await pool.query<Row[]>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`, [
      id,
    ]);
    const row = rows[0];
    return row ? toAgent(row) : null;
  }
  return {
    async create(input, now) {
      await pool.query(
        `INSERT INTO agents (id, name, model, system_prompt, tools, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [input.id, input.name, input.model, input.systemPrompt, toJson(input.tools), now, now],
      );
      const a = await getOne(input.id);
      if (!a) throw new Error('agent vanished after insert');
      return a;
    },
    get: getOne,
    async list() {
      const [rows] = await pool.query<Row[]>(
        `SELECT ${AGENT_COLUMNS} FROM agents ORDER BY created_at ASC`,
      );
      return rows.map(toAgent);
    },
  };
}

const HALT_KEY = 'halt';
const NOT_HALTED: HaltState = { halted: false, reason: null, at: null, by: null };

export function mysqlFlagStore(pool: Pool): FlagStore {
  return {
    async getHalt() {
      const [rows] = await pool.query<Row[]>('SELECT value FROM system_flags WHERE name = ?', [
        HALT_KEY,
      ]);
      const row = rows[0];
      if (!row) return NOT_HALTED;
      const v = json(row['value']) as Partial<HaltState> | null;
      return {
        halted: v?.halted === true,
        reason: typeof v?.reason === 'string' ? v.reason : null,
        at: typeof v?.at === 'string' ? v.at : null,
        by: typeof v?.by === 'string' ? v.by : null,
      };
    },
    async setHalt(state, now) {
      await pool.query(
        `INSERT INTO system_flags (name, value, updated_at) VALUES (?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at`,
        [HALT_KEY, toJson(state), now],
      );
    },
  };
}
