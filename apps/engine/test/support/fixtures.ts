import { randomUUID } from 'node:crypto';
import type { JsonValue } from '@marsad/shared';
import { pino } from 'pino';
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config.js';
import { createEventBus, type EventBus } from '../../src/events/bus.js';
import { ApprovalService } from '../../src/executor/approvals.js';
import { BudgetGuard } from '../../src/executor/budget.js';
import type { RunDispatcher } from '../../src/executor/dispatcher.js';
import { Executor } from '../../src/executor/executor.js';
import { HaltController, type QueueControl } from '../../src/executor/halt.js';
import type { Planner, PlannerContext, StepDecision } from '../../src/executor/planner.js';
import type { Store } from '../../src/store/types.js';
import { defineTool, ToolRegistry } from '../../src/tools/registry.js';

/** A complete, valid environment. Tests override single keys to provoke failures. */
export function testEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    PORT: '8080',
    CORS_ORIGINS: 'http://localhost:5173',
    TRUST_PROXY: 'false',
    LOG_LEVEL: 'fatal',
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: '3306',
    MYSQL_DATABASE: 'marsad_test',
    MYSQL_USER: 'marsad_app',
    MYSQL_PASSWORD: 'marsad_app_dev',
    MYSQL_APP_USER_HOST: '%',
    MYSQL_MIGRATE_USER: 'marsad_migrate',
    MYSQL_MIGRATE_PASSWORD: 'marsad_migrate_dev',
    REDIS_URL: 'redis://127.0.0.1:6379',
    SESSION_SECRET: 'test-session-secret-that-is-at-least-32-chars-long',
    SESSION_TTL_MS: '3600000',
    // argon2id hash of "correct horse battery staple" (m=65536,t=3,p=1). Test-only.
    OPERATOR_PASSWORD_HASH: TEST_PASSWORD_HASH,
    RUN_MAX_STEPS: '10',
    RUN_MAX_TOKENS: '10000',
    RUN_MAX_WALL_CLOCK_MS: '60000',
    BUDGET_PER_RUN_USD: '1.00',
    BUDGET_PER_DAY_USD: '5.00',
    BUDGET_PER_DAY_CALLS: '100',
    APPROVAL_TOKEN_TTL_MS: '600000',
    ANTHROPIC_API_KEY: '',
    AGENT_MODEL: '',
    ...overrides,
  };
}

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$aBtUQLcCQ1YXT4O2y+InzA$HNJ8hjHgOcfJUN0nGHsaCk83KNUkOpteYhAfD5NTX4g';

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig(testEnv(overrides));
}

export const silentLogger = pino({ level: 'silent' });

/** Controllable clock: `advance(ms)` moves time forward deterministically. */
export function fakeClock(start = new Date('2026-09-09T10:00:00.000Z')) {
  let now = start.getTime();
  const clock = () => new Date(now);
  return {
    clock,
    advance(ms: number) {
      now += ms;
    },
    set(date: Date) {
      now = date.getTime();
    },
  };
}

/** Feeds the executor a fixed list of decisions, then `final`. Records every context it saw. */
export class ScriptedPlanner implements Planner {
  readonly contexts: PlannerContext[] = [];
  constructor(private readonly script: StepDecision[]) {}

  async next(ctx: PlannerContext): Promise<StepDecision> {
    this.contexts.push(ctx);
    return this.script.shift() ?? { kind: 'final', output: { done: true }, tokensUsed: 1 };
  }
}

export const call = (
  tool: string,
  input: JsonValue,
  extra: Partial<Extract<StepDecision, { kind: 'tool_call' }>> = {},
): StepDecision => ({
  kind: 'tool_call',
  tool,
  input,
  tokensUsed: 10,
  ...extra,
});

export class FakeQueue implements QueueControl, RunDispatcher {
  paused = false;
  waiting: { runId: string; dedupeKey: string }[] = [];
  enqueued: { runId: string; dedupeKey: string }[] = [];

  async enqueue(runId: string, dedupeKey: string) {
    this.enqueued.push({ runId, dedupeKey });
    this.waiting.push({ runId, dedupeKey });
  }
  async pause() {
    this.paused = true;
  }
  async resume() {
    this.paused = false;
  }
  async drain() {
    const n = this.waiting.length;
    this.waiting = [];
    return n;
  }
  async isPaused() {
    return this.paused;
  }
}

/** Test tools covering the three blast radii, each counting its executions. */
export function testTools() {
  const counts = { echo: 0, pay: 0, wipe: 0, boom: 0 };
  const registry = new ToolRegistry();
  registry.register(
    defineTool({
      name: 'echo',
      description: 'reversible echo',
      blastRadius: 'reversible',
      input: z.object({ message: z.string() }),
      execute: async (input) => {
        counts.echo += 1;
        return { output: { message: input.message } };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'pay',
      description: 'costly: spends money',
      blastRadius: 'costly',
      input: z.object({ usd: z.number().nonnegative() }),
      estimateCostUsd: (input) => input.usd,
      execute: async (input) => {
        counts.pay += 1;
        return { output: { paid: input.usd }, costUsd: input.usd };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'wipe',
      description: 'irreversible: deletes things',
      blastRadius: 'irreversible',
      input: z.object({ target: z.string() }),
      execute: async (input) => {
        counts.wipe += 1;
        return { output: { wiped: input.target } };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'boom',
      description: 'reversible: always throws',
      blastRadius: 'reversible',
      input: z.object({}),
      execute: async () => {
        counts.boom += 1;
        throw new Error('kaboom');
      },
    }),
  );
  return { registry, counts };
}

export interface Harness {
  config: Config;
  store: Store;
  bus: EventBus;
  registry: ToolRegistry;
  counts: ReturnType<typeof testTools>['counts'];
  queue: FakeQueue;
  halt: HaltController;
  executor: Executor;
  approvals: ApprovalService;
  planner: ScriptedPlanner;
  clock: ReturnType<typeof fakeClock>;
  ids: () => string;
  createAgent(tools?: string[]): Promise<string>;
  createRun(agentId: string, task?: string): Promise<string>;
  eventTypes(): Promise<string[]>;
}

export interface HarnessOptions {
  script?: StepDecision[];
  env?: Record<string, string | undefined>;
  planner?: Planner;
}

/** Wires every engine component over a store, with a scripted planner and a fake queue. */
export async function buildHarness(store: Store, opts: HarnessOptions = {}): Promise<Harness> {
  const config = testConfig(opts.env);
  const clock = fakeClock();
  const bus = createEventBus(store.events, clock.clock, silentLogger);
  const { registry, counts } = testTools();
  const queue = new FakeQueue();
  const halt = new HaltController({ store, bus, queue, clock: clock.clock, log: silentLogger });
  const planner = new ScriptedPlanner(opts.script ?? []);
  const ids = () => randomUUID();
  const executor = new Executor({
    store,
    bus,
    registry,
    planner: opts.planner ?? planner,
    budget: new BudgetGuard(store.budgets, config.budget),
    halt,
    ceilings: config.ceilings,
    clock: clock.clock,
    ids,
    log: silentLogger,
  });
  const approvals = new ApprovalService({
    store,
    bus,
    dispatcher: queue,
    tokenTtlMs: config.approvals.tokenTtlMs,
    clock: clock.clock,
  });
  await store.tools.snapshot(registry.definitions(), clock.clock());
  return {
    config,
    store,
    bus,
    registry,
    counts,
    queue,
    halt,
    executor,
    approvals,
    planner,
    clock,
    ids,
    async createAgent(tools = ['echo', 'pay', 'wipe', 'boom']) {
      const agent = await store.agents.create(
        {
          id: ids(),
          name: `agent-${randomUUID().slice(0, 8)}`,
          model: 'test-model',
          systemPrompt: '',
          tools,
        },
        clock.clock(),
      );
      return agent.id;
    },
    async createRun(agentId, task = 'do the thing') {
      const run = await store.runs.create({ id: ids(), agentId, task }, clock.clock());
      return run.id;
    },
    async eventTypes() {
      const events = await store.events.listAfter(null, 10_000);
      return events.map((e) => e.type);
    },
  };
}
