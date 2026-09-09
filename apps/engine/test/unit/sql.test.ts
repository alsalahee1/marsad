import { describe, expect, it } from 'vitest';
import { APP_TABLE_PRIVILEGES, checkAppGrants, parseGrantLine } from '../../src/db/grants.js';
import { readMigrations } from '../../src/db/migrations.js';
import { account, ident, splitSqlStatements } from '../../src/db/sql.js';

describe('sql statement splitter', () => {
  it('splits on top-level semicolons and strips comments', () => {
    const sql = `
      -- leading comment; with a semicolon
      CREATE TABLE a (id INT); # trailing
      /* block; comment */
      INSERT INTO a VALUES ('x;y', "p;q", 'it''s');
      CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no; never';
    `;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe('CREATE TABLE a (id INT)');
    expect(statements[1]).toContain(`'x;y', "p;q", 'it''s'`);
    expect(statements[2]).toMatch(/^CREATE TRIGGER t/);
    expect(statements[2]).toContain(`MESSAGE_TEXT = 'no; never'`);
  });

  it('quotes identifiers and accounts safely', () => {
    expect(ident('events')).toBe('`events`');
    expect(() => ident('ev`ents')).toThrow();
    expect(account("o'brien", '%')).toBe(`'o\\'brien'@'%'`);
  });

  it('the shipped migrations parse into statements and every base table is in the grant map', async () => {
    const files = await readMigrations();
    expect(files.map((f) => f.version)).toEqual([1, 2]);
    const created = new Set<string>();
    for (const f of files) {
      for (const s of splitSqlStatements(f.sql)) {
        const m = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s);
        if (m?.[1]) created.add(m[1]);
      }
    }
    for (const table of created) expect(Object.keys(APP_TABLE_PRIVILEGES)).toContain(table);
    expect(APP_TABLE_PRIVILEGES.events).toEqual(['SELECT', 'INSERT']);
  });
});

describe('grant verification', () => {
  const ok = [
    'GRANT USAGE ON *.* TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`agents` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`runs` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT ON `marsad`.`events` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`tool_calls` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`approvals` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`budgets` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`tools` TO `marsad_app`@`%`',
    'GRANT SELECT, INSERT, UPDATE ON `marsad`.`system_flags` TO `marsad_app`@`%`',
    'GRANT SELECT ON `marsad`.`schema_migrations` TO `marsad_app`@`%`',
  ];

  it('parses SHOW GRANTS lines', () => {
    expect(parseGrantLine(ok[0] ?? '')).toMatchObject({ scope: 'global', privileges: ['USAGE'] });
    expect(parseGrantLine(ok[3] ?? '')).toMatchObject({
      scope: 'table',
      database: 'marsad',
      table: 'events',
      privileges: ['SELECT', 'INSERT'],
    });
    expect(parseGrantLine('GRANT ALL PRIVILEGES ON `marsad`.* TO `x`@`%`')).toMatchObject({
      scope: 'schema',
    });
    expect(parseGrantLine('GRANT `admin_role`@`%` TO `x`@`%`')).toMatchObject({ scope: 'role' });
  });

  it('accepts the exact map and rejects anything broader', () => {
    expect(checkAppGrants(ok, 'marsad')).toEqual([]);
    expect(
      checkAppGrants(
        [...ok, 'GRANT UPDATE, DELETE ON `marsad`.`events` TO `marsad_app`@`%`'],
        'marsad',
      ),
    ).toEqual(['events: not allowed: UPDATE, DELETE']);
    expect(
      checkAppGrants(
        [...ok, 'GRANT ALL PRIVILEGES ON `marsad`.* TO `marsad_app`@`%`'],
        'marsad',
      )[0],
    ).toMatch(/schema-wide/);
    expect(checkAppGrants([...ok, 'GRANT SUPER ON *.* TO `marsad_app`@`%`'], 'marsad')[0]).toMatch(
      /global privileges/,
    );
    expect(
      checkAppGrants(
        [...ok, 'GRANT SELECT, INSERT, UPDATE ON `marsad_test`.`events` TO `marsad_app`@`%`'],
        'marsad',
      ),
    ).toEqual([]);
    expect(checkAppGrants(ok.slice(0, 3), 'marsad')).toContain(
      'events: missing SELECT, INSERT (run pnpm db:migrate)',
    );
  });
});
