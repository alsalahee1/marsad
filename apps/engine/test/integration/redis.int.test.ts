/**
 * Runs only when REDIS_URL is set. Real BullMQ over a real Redis, in-memory MySQL stand-in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Worker } from 'bullmq';
import { Secret } from '../../src/config.js';
import { HaltController } from '../../src/executor/halt.js';
import { RunQueue, createRedis, createRunWorker } from '../../src/queue/queue.js';
import { buildHarness, call, silentLogger, type Harness } from '../support/fixtures.js';
import { createMemoryStore } from '../support/memoryStore.js';

const redisUrl = process.env['REDIS_URL'];
const enabled = Boolean(redisUrl);

describe.runIf(enabled)('redis / bullmq integration', () => {
  let redis: ReturnType<typeof createRedis>;
  let queue: RunQueue;
  let worker: Worker | undefined;
  let h: Harness;
  let halt: HaltController;

  beforeEach(async () => {
    redis = createRedis(new Secret(redisUrl ?? ''));
    queue = new RunQueue(redis);
    await queue.queue.obliterate({ force: true });
    h = await buildHarness(createMemoryStore(), {
      script: [call('echo', { message: 'via redis' })],
    });
    halt = new HaltController({
      store: h.store,
      bus: h.bus,
      queue,
      clock: h.clock.clock,
      log: silentLogger,
    });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  });

  const waitForJob = (w: Worker, timeoutMs = 10_000) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('job did not complete in time'));
      }, timeoutMs);
      w.once('completed', (_job, result) => {
        clearTimeout(timer);
        resolve(result);
      });
      w.once('failed', (_job, err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  it('a worker picks a queued run up and the executor finishes it', async () => {
    worker = createRunWorker({
      connection: redis,
      executor: h.executor,
      halt,
      log: silentLogger,
      concurrency: 1,
    });
    const done = waitForJob(worker);
    const agent = await h.createAgent();
    const runId = await h.createRun(agent);
    await queue.enqueue(runId, 'start');
    await expect(done).resolves.toEqual({ status: 'done' });
    expect(h.counts.echo).toBe(1);
    expect((await h.store.runs.get(runId))?.status).toBe('done');
  });

  it('enqueue is de-duplicated by run + intent', async () => {
    const agent = await h.createAgent();
    const runId = await h.createRun(agent);
    await queue.enqueue(runId, 'start');
    await queue.enqueue(runId, 'start');
    await queue.enqueue(runId, 'approval-1');
    const counts = await queue.queue.getJobCounts('waiting');
    expect(counts['waiting']).toBe(2);
  });

  it('halt persists the flag, pauses the queue, drains waiting jobs, halts queued runs; resume undoes the pause', async () => {
    const agent = await h.createAgent();
    const runIds = [await h.createRun(agent), await h.createRun(agent), await h.createRun(agent)];
    for (const id of runIds) await queue.enqueue(id, 'start');
    expect((await queue.queue.getJobCounts('waiting'))['waiting']).toBe(3);

    const result = await halt.halt('drill', 'operator');
    expect(result.drainedJobs).toBe(3);
    expect(result.haltedRuns.sort()).toEqual([...runIds].sort());
    expect(await queue.isPaused()).toBe(true);
    expect(await queue.queue.getJobCounts('waiting', 'paused')).toMatchObject({
      waiting: 0,
      paused: 0,
    });
    expect(await h.store.flags.getHalt()).toMatchObject({
      halted: true,
      reason: 'drill',
      by: 'operator',
    });
    for (const id of runIds) expect((await h.store.runs.get(id))?.status).toBe('halted');
    const types = await h.eventTypes();
    expect(types.filter((t) => t === 'run.halted')).toHaveLength(3);
    expect(types.at(-1)).toBe('system.halted');

    await halt.resume('operator');
    expect(await queue.isPaused()).toBe(false);
    expect((await h.store.flags.getHalt()).halted).toBe(false);
  });

  it('the halt survives a restart: a fresh controller re-pauses the queue from the MySQL flag, and a worker refuses jobs', async () => {
    await h.store.flags.setHalt(
      { halted: true, reason: 'before restart', at: null, by: 'operator' },
      h.clock.clock(),
    );
    // "Restart": Redis lost the pause (fresh queue), MySQL still has the flag.
    expect(await queue.isPaused()).toBe(false);
    const rebooted = new HaltController({
      store: h.store,
      bus: h.bus,
      queue,
      clock: h.clock.clock,
      log: silentLogger,
    });
    await rebooted.syncOnBoot();
    expect(await queue.isPaused()).toBe(true);

    // Even if a job slips through to a worker, the worker checks the flag first.
    worker = createRunWorker({
      connection: redis,
      executor: h.executor,
      halt: rebooted,
      log: silentLogger,
      concurrency: 1,
    });
    const done = waitForJob(worker);
    const agent = await h.createAgent();
    const runId = await h.createRun(agent);
    await queue.resume(); // let the job flow so the worker-side check is what stops it
    await queue.enqueue(runId, 'start');
    await expect(done).resolves.toEqual({ status: 'halted', reason: 'system.halt' });
    expect(h.counts.echo).toBe(0);
    expect((await h.store.runs.get(runId))?.status).toBe('halted');
  });
});

describe.skipIf(enabled)('redis / bullmq integration', () => {
  it.skip('skipped: REDIS_URL is not set', () => undefined);
});
