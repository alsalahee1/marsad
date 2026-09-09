// CLI: `pnpm db:migrate`. Connects as the migration user and applies pending migrations.
import { loadConfig } from '../config.js';
import { loadDotenv } from '../env.js';
import { createMigrationConnection } from './pool.js';
import { runMigrations } from './migrations.js';

loadDotenv();

const config = loadConfig(process.env);
const conn = await createMigrationConnection({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  user: config.mysql.migrateUser,
  password: config.mysql.migratePassword,
});

try {
  const result = await runMigrations({
    conn,
    appAccount: {
      database: config.mysql.database,
      user: config.mysql.user,
      host: config.mysql.appUserHost,
    },
    log: (msg) => {
      console.log(`[migrate] ${msg}`);
    },
  });
  console.log(
    `[migrate] done: ${result.applied.length} applied, ${result.skipped} already applied` +
      (result.applied.length ? ` (${result.applied.join(', ')})` : ''),
  );
} finally {
  await conn.end();
}
