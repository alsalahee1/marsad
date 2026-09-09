import { randomUUID } from 'node:crypto';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { assertAppGrants } from './db/grants.js';
import { pendingMigrations } from './db/migrations.js';
import { createPool } from './db/pool.js';
import { createEventBus } from './events/bus.js';
import { ApprovalService } from './executor/approvals.js';
import { BudgetGuard } from './executor/budget.js';
import { Executor } from './executor/executor.js';
import { HaltController } from './executor/halt.js';
import { UnconfiguredPlanner } from './executor/planner.js';
import { createApp } from './http/app.js';
import { loadDotenv } from './env.js';
import { createLogger } from './logger.js';
import { RunQueue, createRedis, createRunWorker } from './queue/queue.js';
import { createMysqlStore } from './store/mysql/index.js';
import { registerBuiltinTools } from './tools/builtin/index.js';
import { ToolRegistry } from './tools/registry.js';

loadDotenv();

const config = loadConfig(process.env);
const log = createLogger(config.logLevel);
const clock = systemClock;
const ids = () => randomUUID();

// 1. Database: app user, migrations applied, grants exactly as mapped.
const pool = createPool(config.mysql);
const store = createMysqlStore(pool);
await store.ping();
{
  const conn = await pool.getConnection();
  try {
    const pending = await pendingMigrations(conn);
    if (pending.length > 0)
      throw new Error(`pending migrations: ${pending.join(', ')} — run pnpm db:migrate`);
    await assertAppGrants(conn, config.mysql.database);
  } finally {
    conn.release();
  }
}

// 2. Event log is the foundation; everything below emits through it.
const bus = createEventBus(store.events, clock, log);

// 3. Tool registry: a tool without a blast radius throws here and the process never listens.
const registry = new ToolRegistry();
registerBuiltinTools(registry);
await store.tools.snapshot(registry.definitions(), clock());
await bus.insertEvent({
  type: 'tools.snapshotted',
  payload: { tools: registry.list().map((t) => ({ name: t.name, blastRadius: t.blastRadius })) },
});

// 4. Queue, halt switch, executor, worker.
const redis = createRedis(config.redisUrl);
const queue = new RunQueue(redis);
const halt = new HaltController({ store, bus, queue, clock, log });
await halt.syncOnBoot();

const executor = new Executor({
  store,
  bus,
  registry,
  planner: new UnconfiguredPlanner(),
  budget: new BudgetGuard(store.budgets, config.budget),
  halt,
  ceilings: config.ceilings,
  clock,
  ids,
  log,
});
const worker = createRunWorker({ connection: redis, executor, halt, log });
const approvals = new ApprovalService({
  store,
  bus,
  dispatcher: queue,
  tokenTtlMs: config.approvals.tokenTtlMs,
  clock,
});

// 5. HTTP.
const app = createApp({
  config,
  store,
  bus,
  halt,
  approvals,
  dispatcher: queue,
  registry,
  log,
  clock,
  ids,
  redisPing: async () => {
    await redis.ping();
  },
});
const server = app.listen(config.port, () => {
  log.info(
    { port: config.port, env: config.env, tools: registry.list().length },
    'engine listening',
  );
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => process.exit(1), 30_000);
  forceExit.unref();
  server.close();
  await worker.close();
  await queue.close();
  await redis.quit();
  await store.close();
  log.info('bye');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
