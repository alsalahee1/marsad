import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import type { Secret } from '../config.js';

export interface MysqlTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password: Secret;
}

/**
 * Connection pool for the runtime app user. Settings that matter for correctness:
 * - timezone 'Z': every DATETIME is written and read as UTC.
 * - bigNumberStrings: events.id is a BIGINT and travels as a decimal string.
 * - FOUND_ROWS: affectedRows counts matched rows, so guarded UPDATEs are reliable.
 * - multipleStatements stays off; only the migration runner sends multi-statement files.
 */
export function createPool(target: MysqlTarget, connectionLimit = 10): Pool {
  const pool = mysql.createPool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password.reveal(),
    waitForConnections: true,
    connectionLimit,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: true,
    multipleStatements: false,
    flags: ['+FOUND_ROWS'],
    charset: 'utf8mb4_0900_ai_ci',
  });
  pool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return pool;
}

export async function createMigrationConnection(target: MysqlTarget) {
  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password.reveal(),
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4_0900_ai_ci',
  });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}

export type { Pool, PoolConnection };
