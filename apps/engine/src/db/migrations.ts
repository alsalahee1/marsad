import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { applyAppGrants, type AppAccount } from './grants.js';
import { splitSqlStatements } from './sql.js';

/** `apps/engine/migrations`, resolved relative to this file so it works from src/ and dist/. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function readMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const m = FILE_PATTERN.exec(entry);
    if (!m) {
      if (entry.endsWith('.sql'))
        throw new Error(`migration file name not in NNNN_name.sql form: ${entry}`);
      continue;
    }
    const sql = await readFile(path.join(dir, entry), 'utf8');
    files.push({
      version: Number(m[1]),
      name: m[2] ?? '',
      file: entry,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i += 1) {
    const prev = files[i - 1];
    const cur = files[i];
    if (cur && prev?.version === cur.version) {
      throw new Error(`duplicate migration version ${cur.version}: ${prev.file}, ${cur.file}`);
    }
  }
  return files;
}

interface AppliedRow extends RowDataPacket {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrateOptions {
  conn: Connection;
  appAccount: AppAccount;
  dir?: string;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: number;
}

/**
 * Apply pending migrations in version order, record each in schema_migrations, then apply the
 * app user's table grants. Must run as the migration user (DDL + GRANT OPTION).
 *
 * MySQL DDL auto-commits, so a file is not atomic; a failed statement leaves the file
 * unrecorded and the error names the statement so it can be fixed and re-run.
 */
export async function runMigrations(opts: MigrateOptions): Promise<MigrateResult> {
  const { conn, appAccount } = opts;
  const log = opts.log ?? (() => undefined);
  const files = await readMigrations(opts.dir);

  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INT UNSIGNED NOT NULL,
       name       VARCHAR(255) NOT NULL,
       checksum   CHAR(64)     NOT NULL,
       applied_at DATETIME(3)  NOT NULL,
       PRIMARY KEY (version)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  );

  const [lockRows] = await conn.query<RowDataPacket[]>(
    "SELECT GET_LOCK('marsad_migrate', 30) AS ok",
  );
  if (Number(lockRows[0]?.['ok']) !== 1) throw new Error('could not acquire migration lock');

  try {
    const [appliedRows] = await conn.query<AppliedRow[]>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    const applied = new Map(appliedRows.map((r) => [r.version, r]));
    const result: MigrateResult = { applied: [], skipped: 0 };

    for (const file of files) {
      const prior = applied.get(file.version);
      if (prior) {
        if (prior.checksum !== file.checksum) {
          throw new Error(
            `migration ${file.file} was applied with a different checksum; never edit an applied migration, add a new one`,
          );
        }
        result.skipped += 1;
        continue;
      }
      const statements = splitSqlStatements(file.sql);
      log(`applying ${file.file} (${statements.length} statements)`);
      for (const [index, statement] of statements.entries()) {
        try {
          await conn.query(statement);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`${file.file} statement ${index + 1} failed: ${msg}\n${statement}`, {
            cause: err,
          });
        }
      }
      await conn.query(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [file.version, file.name, file.checksum, new Date()],
      );
      result.applied.push(file.file);
    }

    log(`granting app privileges to ${appAccount.user}@${appAccount.host}`);
    await applyAppGrants(conn, appAccount);
    return result;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('marsad_migrate')");
  }
}

/** Versions present on disk but not recorded in schema_migrations. Used by the engine at boot. */
export async function pendingMigrations(
  conn: Connection,
  dir = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const files = await readMigrations(dir);
  const [rows] = await conn.query<AppliedRow[]>(
    'SELECT version, name, checksum FROM schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.version));
  return files.filter((f) => !applied.has(f.version)).map((f) => f.file);
}
