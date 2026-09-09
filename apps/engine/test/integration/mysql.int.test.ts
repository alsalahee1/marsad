/**
 * Runs only when MYSQL_HOST is set (see vitest.config.ts for the credential defaults that
 * match docker/mysql/init/01-users.sql). Everything here talks to a real MySQL 8.
 */
import { randomUUID } from 'node:crypto';
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Secret } from '../../src/config.js';
import { APP_TABLE_PRIVILEGES, assertAppGrants } from '../../src/db/grants.js';
import { pendingMigrations, readMigrations, runMigrations } from '../../src/db/migrations.js';
import { createMigrationConnection, createPool } from '../../src/db/pool.js';
import { IdempotencyConflictError } from '../../src/errors.js';
import { createMysqlStore } from '../../src/store/mysql/index.js';
import type { Store } from '../../src/store/types.js';
import { approvalSuite, executorSuite } from '../support/suites.js';

const env = process.env;
const enabled = Boolean(env['MYSQL_HOST']);

const target = {
  host: env['MYSQL_HOST'] ?? '127.0.0.1',
  port: Number(env['MYSQL_PORT'] ?? 3306),
  database: env['MYSQL_DATABASE'] ?? 'marsad_test',
};
const appAccount = {
  user: env['MYSQL_USER'] ?? 'marsad_app',
  password: env['MYSQL_PASSWORD'] ?? '',
  host: env['MYSQL_APP_USER_HOST'] ?? '%',
};
const migrateAccount = {
  user: env['MYSQL_MIGRATE_USER'] ?? 'marsad_migrate',
  password: env['MYSQL_MIGRATE_PASSWORD'] ?? '',
};

type MysqlError = Error & { errno?: number; code?: string; sqlState?: string };

async function expectSqlError(promise: Promise<unknown>): Promise<MysqlError> {
  try {
    await promise;
  } catch (err) {
    return err as MysqlError;
  }
  throw new Error('expected the statement to fail');
}

describe.runIf(enabled)('mysql integration', () => {
  let migrate: Connection;
  let appPool: Pool;
  let store: Store;

  const truncateAll = async () => {
    await migrate.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of Object.keys(APP_TABLE_PRIVILEGES)) {
      if (table === 'schema_migrations') continue;
      await migrate.query(`TRUNCATE TABLE \`${table}\``);
    }
    await migrate.query('SET FOREIGN_KEY_CHECKS = 1');
  };

  beforeAll(async () => {
    const admin = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: migrateAccount.user,
      password: migrateAccount.password,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${target.database}\``);
    await admin.query(
      `CREATE DATABASE \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await admin.end();

    migrate = await createMigrationConnection({
      ...target,
      user: migrateAccount.user,
      password: new Secret(migrateAccount.password),
    });
    const result = await runMigrations({
      conn: migrate,
      appAccount: { database: target.database, user: appAccount.user, host: appAccount.host },
    });
    expect(result.applied.length).toBeGreaterThanOrEqual(2);

    appPool = createPool(
      { ...target, user: appAccount.user, password: new Secret(appAccount.password) },
      4,
    );
    store = createMysqlStore(appPool);
  });

  afterAll(async () => {
    await appPool.end();
    await migrate.end();
  });

  describe('migration runner', () => {
    it('is idempotent and reports nothing pending', async () => {
      const again = await runMigrations({
        conn: migrate,
        appAccount: { database: target.database, user: appAccount.user, host: appAccount.host },
      });
      expect(again.applied).toEqual([]);
      expect(again.skipped).toBe((await readMigrations()).length);
      const conn = await appPool.getConnection();
      try {
        expect(await pendingMigrations(conn)).toEqual([]);
      } finally {
        conn.release();
      }
    });

    it('refuses to continue when an applied migration was edited', async () => {
      await migrate.query(
        `UPDATE schema_migrations SET checksum = REPEAT('0', 64) WHERE version = 1`,
      );
      await expect(
        runMigrations({
          conn: migrate,
          appAccount: { database: target.database, user: appAccount.user, host: appAccount.host },
        }),
      ).rejects.toThrow(/different checksum/);
      const [files] = [await readMigrations()];
      await migrate.query(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`, [
        files[0]?.checksum,
      ]);
    });

    it('runs.status is an ENUM of exactly the six states', async () => {
      const [rows] = await migrate.query<RowDataPacket[]>(
        `SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'runs' AND COLUMN_NAME = 'status'`,
        [target.database],
      );
      expect(rows[0]?.['COLUMN_TYPE']).toBe(
        "enum('queued','running','blocked','done','failed','halted')",
      );
    });
  });

  describe('app user grants', () => {
    it('are exactly the map: SELECT+INSERT on events, nothing schema-wide, no roles', async () => {
      const conn = await appPool.getConnection();
      try {
        await expect(assertAppGrants(conn, target.database)).resolves.toBeUndefined();
        const [rows] = await conn.query<RowDataPacket[]>('SHOW GRANTS');
        const lines = rows.map((r) => String(Object.values(r)[0]));
        const events = lines.find((l) => l.includes('`events`'));
        expect(events).toMatch(/^GRANT SELECT, INSERT ON `\w+`\.`events` TO/);
        expect(lines.some((l) => /\bDELETE\b/.test(l))).toBe(false);
      } finally {
        conn.release();
      }
    });
  });

  describe('events is append-only', () => {
    let eventId: string;
    beforeEach(async () => {
      await truncateAll();
      const ev = await store.events.insert(
        { type: 'system.resumed', payload: { by: 'test' } },
        new Date(),
      );
      eventId = ev.id;
    });

    it('app user: UPDATE and DELETE are denied at the grant level (ER_TABLEACCESS_DENIED_ERROR)', async () => {
      const upd = await expectSqlError(
        appPool.query('UPDATE events SET type = ? WHERE id = ?', ['system.halted', eventId]),
      );
      expect(upd.errno).toBe(1142);
      expect(upd.code).toBe('ER_TABLEACCESS_DENIED_ERROR');
      const del = await expectSqlError(appPool.query('DELETE FROM events WHERE id = ?', [eventId]));
      expect(del.errno).toBe(1142);
      const trunc = await expectSqlError(appPool.query('TRUNCATE TABLE events'));
      expect(trunc.errno).toBe(1142);
      const [rows] = await appPool.query<RowDataPacket[]>('SELECT type FROM events WHERE id = ?', [
        eventId,
      ]);
      expect(rows[0]?.['type']).toBe('system.resumed');
    });

    it('migration user (full DML rights): UPDATE and DELETE are rejected by the triggers (SQLSTATE 45000)', async () => {
      const upd = await expectSqlError(
        migrate.query('UPDATE events SET type = ? WHERE id = ?', ['system.halted', eventId]),
      );
      expect(upd.sqlState).toBe('45000');
      expect(upd.message).toMatch(/append-only: UPDATE rejected/);
      const del = await expectSqlError(migrate.query('DELETE FROM events WHERE id = ?', [eventId]));
      expect(del.sqlState).toBe('45000');
      expect(del.message).toMatch(/append-only: DELETE rejected/);
      const [rows] = await migrate.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM events');
      expect(Number(rows[0]?.['n'])).toBe(1);
    });

    it('ids are monotonic decimal strings and replay after a cursor is exact', async () => {
      const a = await store.events.insert(
        { type: 'system.resumed', payload: { by: 'a' } },
        new Date(),
      );
      const b = await store.events.insert(
        { type: 'system.resumed', payload: { by: 'b' } },
        new Date(),
      );
      expect(BigInt(b.id)).toBe(BigInt(a.id) + 1n);
      const after = await store.events.listAfter(a.id, 10);
      expect(after.map((e) => e.id)).toEqual([b.id]);
      expect(after[0]?.at).toMatch(/Z$/);
    });
  });

  describe('tool_calls idempotency', () => {
    beforeEach(truncateAll);

    it('a second insert with the same idempotency key is refused by the UNIQUE index', async () => {
      const agent = await store.agents.create(
        { id: randomUUID(), name: 'a', model: 'm', systemPrompt: '', tools: [] },
        new Date(),
      );
      const run = await store.runs.create(
        { id: randomUUID(), agentId: agent.id, task: 't' },
        new Date(),
      );
      const base = {
        runId: run.id,
        step: 1,
        tool: 'echo',
        blastRadius: 'reversible' as const,
        idempotencyKey: 'k'.repeat(16),
        input: {},
        estimatedCostUsd: 0,
        status: 'pending' as const,
      };
      await store.toolCalls.insert({ id: randomUUID(), ...base }, new Date());
      await expect(
        store.toolCalls.insert({ id: randomUUID(), ...base }, new Date()),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      const raw = await expectSqlError(
        appPool.query(
          `INSERT INTO tool_calls (id, run_id, step, tool, blast_radius, idempotency_key, status, input, created_at, updated_at)
           VALUES (?, ?, 2, 'echo', 'reversible', ?, 'pending', '{}', NOW(3), NOW(3))`,
          [randomUUID(), run.id, 'k'.repeat(16)],
        ),
      );
      expect(raw.code).toBe('ER_DUP_ENTRY');
    });

    it('runs.status rejects a seventh value', async () => {
      const agent = await store.agents.create(
        { id: randomUUID(), name: 'b', model: 'm', systemPrompt: '', tools: [] },
        new Date(),
      );
      const err = await expectSqlError(
        appPool.query(
          `INSERT INTO runs (id, agent_id, status, task, created_at, updated_at) VALUES (?, ?, 'paused', 't', NOW(3), NOW(3))`,
          [randomUUID(), agent.id],
        ),
      );
      expect(err.errno).toBe(1265);
    });
  });

  describe('behavioural suites on MySQL', () => {
    executorSuite(async () => {
      await truncateAll();
      return store;
    });
    approvalSuite(async () => {
      await truncateAll();
      return store;
    });
  });
});

describe.skipIf(enabled)('mysql integration', () => {
  it.skip('skipped: MYSQL_HOST is not set', () => undefined);
});
