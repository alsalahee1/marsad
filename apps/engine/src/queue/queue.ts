import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Secret } from '../config.js';
import type { RunDispatcher } from '../executor/dispatcher.js';
import type { Executor, RunOutcome } from '../executor/executor.js';
import type { QueueControl } from '../executor/halt.js';
import type { Logger } from '../logger.js';

export const RUN_QUEUE_NAME = 'marsad-runs';
/** Parallel runs per engine process. Every run still checks the halt flag before each step. */
export const WORKER_CONCURRENCY = 4;

export interface RunJobData {
  runId: string;
}

export function createRedis(url: Secret): Redis {
  return new Redis(url.reveal(), {
    // Required by BullMQ: blocking commands must not be retried by the client.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}

/** The single run queue: dispatcher for producers, control surface for the halt switch. */
export class RunQueue implements RunDispatcher, QueueControl {
  readonly queue: Queue<RunJobData, RunOutcome>;

  constructor(connection: Redis) {
    this.queue = new Queue<RunJobData, RunOutcome>(RUN_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 5000 },
        removeOnFail: { count: 5000 },
      },
    });
  }

  async enqueue(runId: string, dedupeKey: string): Promise<void> {
    // BullMQ forbids ':' in custom ids; keys are `${runId}--${intent}`.
    const jobId = `${runId}--${dedupeKey.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    await this.queue.add('run', { runId }, { jobId });
  }

  pause(): Promise<void> {
    return this.queue.pause();
  }

  resume(): Promise<void> {
    return this.queue.resume();
  }

  async drain(): Promise<number> {
    const counts = await this.queue.getJobCounts(
      'wait',
      'waiting',
      'delayed',
      'prioritized',
      'paused',
    );
    const before = Object.values(counts).reduce((a, b) => a + b, 0);
    await this.queue.drain(true);
    return before;
  }

  isPaused(): Promise<boolean> {
    return this.queue.isPaused();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export interface RunWorkerDeps {
  connection: Redis;
  executor: Executor;
  halt: { isHalted(): Promise<boolean> };
  log: Logger;
  concurrency?: number;
}

export function createRunWorker(deps: RunWorkerDeps): Worker<RunJobData, RunOutcome> {
  const { executor, halt, log } = deps;
  const worker = new Worker<RunJobData, RunOutcome>(
    RUN_QUEUE_NAME,
    async (job: Job<RunJobData, RunOutcome>) => {
      // The MySQL flag is the truth; a paused Redis queue is only its mirror.
      if (await halt.isHalted()) {
        return executor.haltRun(job.data.runId, 'system.halt', {
          detail: 'job picked up while halted',
        });
      }
      return executor.execute(job.data.runId);
    },
    {
      connection: deps.connection,
      concurrency: deps.concurrency ?? WORKER_CONCURRENCY,
      autorun: true,
    },
  );
  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id, runId: job?.data.runId }, 'run job failed');
  });
  worker.on('error', (err) => {
    log.error({ err }, 'worker error');
  });
  return worker;
}
