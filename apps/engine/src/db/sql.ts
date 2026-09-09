/**
 * Split a migration file into statements on top-level semicolons. Understands single and
 * double quoted strings, backtick identifiers, `--` and `#` line comments, and block comments.
 * Compound bodies (BEGIN ... END) are deliberately unsupported: every trigger in this repo is
 * a single statement, so no DELIMITER dance is needed.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      current += '\n';
      continue;
    }
    if (ch === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      current += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      current += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        const c = sql[j];
        if (c === '\\' && quote !== '`') {
          j += 2;
          continue;
        }
        if (c === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Quote a MySQL identifier. */
export function ident(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `\`${name}\``;
}

/** Quote a MySQL account as 'user'@'host'. */
export function account(user: string, host: string): string {
  const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `${q(user)}@${q(host)}`;
}
