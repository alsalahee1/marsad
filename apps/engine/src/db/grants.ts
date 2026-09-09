import type { Connection, RowDataPacket } from 'mysql2/promise';
import { account, ident } from './sql.js';

export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Exactly what the runtime app user may do, per table. The migration runner grants this and
 * nothing else; the engine verifies its own grants at boot (see `assertAppGrants`).
 *
 * `events` is the point of the whole map: SELECT and INSERT, never UPDATE or DELETE.
 * Nothing in the engine deletes rows, so no table gets DELETE.
 */
export const APP_TABLE_PRIVILEGES = {
  agents: ['SELECT', 'INSERT', 'UPDATE'],
  runs: ['SELECT', 'INSERT', 'UPDATE'],
  events: ['SELECT', 'INSERT'],
  tool_calls: ['SELECT', 'INSERT', 'UPDATE'],
  approvals: ['SELECT', 'INSERT', 'UPDATE'],
  budgets: ['SELECT', 'INSERT', 'UPDATE'],
  tools: ['SELECT', 'INSERT', 'UPDATE'],
  system_flags: ['SELECT', 'INSERT', 'UPDATE'],
  schema_migrations: ['SELECT'],
} as const satisfies Record<string, readonly Privilege[]>;

export type AppTable = keyof typeof APP_TABLE_PRIVILEGES;

export interface AppAccount {
  database: string;
  user: string;
  host: string;
}

/** Runs as the migration user. Idempotent: GRANT adds nothing when the privilege exists. */
export async function applyAppGrants(conn: Connection, acct: AppAccount): Promise<void> {
  const grantee = account(acct.user, acct.host);
  for (const [table, privileges] of Object.entries(APP_TABLE_PRIVILEGES)) {
    const target = `${ident(acct.database)}.${ident(table)}`;
    await conn.query(`GRANT ${privileges.join(', ')} ON ${target} TO ${grantee}`);
  }
}

export interface GrantLine {
  privileges: string[];
  scope: 'global' | 'schema' | 'table' | 'role' | 'other';
  database?: string;
  table?: string;
  raw: string;
}

/** Parse one line of `SHOW GRANTS` output. */
export function parseGrantLine(line: string): GrantLine {
  const raw = line.trim();
  const m = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i.exec(raw);
  if (!m) {
    // `GRANT `role`@`%` TO `user`@`%`` has no ON clause: a role grant.
    return { privileges: [], scope: /^GRANT\s+.+\s+TO\s+/i.test(raw) ? 'role' : 'other', raw };
  }
  const privileges = (m[1] ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  const target = (m[2] ?? '').trim();
  const unq = (s: string) => s.replace(/^`|`$/g, '');
  if (target === '*.*') return { privileges, scope: 'global', raw };
  const parts = target.split('.');
  if (parts.length !== 2) return { privileges, scope: 'other', raw };
  const [db, tbl] = parts as [string, string];
  if (tbl === '*') return { privileges, scope: 'schema', database: unq(db), raw };
  return { privileges, scope: 'table', database: unq(db), table: unq(tbl), raw };
}

/**
 * Check the *current* connection's grants against the map. Fails when the app user holds
 * anything broader than the map allows: any global or schema-wide privilege beyond USAGE, any
 * role, or any table privilege on this database the map does not list. Run at engine boot.
 */
export function checkAppGrants(lines: readonly string[], database: string): string[] {
  const problems: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const line of lines) {
    const g = parseGrantLine(line);
    switch (g.scope) {
      case 'global': {
        const extra = g.privileges.filter((p) => p !== 'USAGE');
        if (extra.length > 0)
          problems.push(`global privileges are not allowed: ${extra.join(', ')}`);
        break;
      }
      case 'schema':
        problems.push(`schema-wide grant is not allowed (${g.raw})`);
        break;
      case 'role':
        problems.push(`roles are not allowed for the app user (${g.raw})`);
        break;
      case 'other':
        problems.push(`unrecognised grant (${g.raw})`);
        break;
      case 'table': {
        // Table grants on another database (for example marsad_test next to marsad in the
        // docker stack) do not weaken this database's invariants; only this one is checked.
        if (g.database !== database) break;
        const table = g.table ?? '';
        const allowed = new Set<string>(
          (APP_TABLE_PRIVILEGES as Record<string, readonly string[]>)[table] ?? [],
        );
        const extra = g.privileges.filter((p) => !allowed.has(p));
        if (extra.length > 0) problems.push(`${table}: not allowed: ${extra.join(', ')}`);
        const set = seen.get(table) ?? new Set<string>();
        for (const p of g.privileges) set.add(p);
        seen.set(table, set);
        break;
      }
    }
  }
  for (const [table, privileges] of Object.entries(APP_TABLE_PRIVILEGES)) {
    const have = seen.get(table) ?? new Set<string>();
    const missing = privileges.filter((p) => !have.has(p));
    if (missing.length > 0)
      problems.push(`${table}: missing ${missing.join(', ')} (run pnpm db:migrate)`);
  }
  return problems;
}

export async function assertAppGrants(conn: Connection, database: string): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>('SHOW GRANTS');
  const lines = rows.map((r) => String(Object.values(r)[0] ?? ''));
  const problems = checkAppGrants(lines, database);
  if (problems.length > 0) {
    throw new Error(
      `app database user has the wrong privileges:\n  - ${problems.join('\n  - ')}\n` +
        'The events table must be append-only at the grant level. Fix the account, do not widen the map.',
    );
  }
}
