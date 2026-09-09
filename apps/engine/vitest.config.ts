import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration suites gate themselves on MYSQL_HOST / REDIS_URL. When MYSQL_HOST is set and the
// rest is not, fall back to the docker-compose dev credentials (docker/mysql/init/01-users.sql).
const mysqlDefaults: Record<string, string> = process.env['MYSQL_HOST']
  ? {
      MYSQL_PORT: '3306',
      MYSQL_DATABASE: 'marsad_test',
      MYSQL_USER: 'marsad_app',
      MYSQL_PASSWORD: 'marsad_app_dev',
      MYSQL_MIGRATE_USER: 'marsad_migrate',
      MYSQL_MIGRATE_PASSWORD: 'marsad_migrate_dev',
      MYSQL_APP_USER_HOST: '%',
    }
  : {};

export default defineConfig({
  resolve: {
    // Tests resolve the shared package from source so they never depend on a prior build.
    alias: {
      '@marsad/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    env: { ...mysqlDefaults },
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Integration suites share one MySQL database; keep them from interleaving.
    fileParallelism: false,
  },
});
