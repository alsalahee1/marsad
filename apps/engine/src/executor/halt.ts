import type { Clock } from '../clock.js';
import type { EventBus } from '../events/bus.js';
import type { Logger } from '../logger.js';
import type { HaltState, Store } from '../store/types.js';

/** What the halt switch needs from the queue. Implemented over BullMQ; faked in tests. */
export interface QueueControl {
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Remove every waiting/delayed job. Returns how many were removed. */
  drain(): Promise<number>;
  isPaused(): Promise<boolean>;
}

export interface HaltControllerDeps {
  store: Store;
  bus: EventBus;
  queue: QueueControl;
  clock: Clock;
  log: Logger;
}

/**
 * The global halt. The flag lives in MySQL (system_flags.halt) so it survives a restart and a
 * Redis flush; Redis only mirrors it as a paused queue. Every worker reads the flag before
 * every step through `isHalted()` — there is no cached copy.
 */
export class HaltController {
  constructor(private readonly deps: HaltControllerDeps) {}

  async state(): Promise<HaltState> {
    return this.deps.store.flags.getHalt();
  }

  async isHalted(): Promise<boolean> {
    return (await this.deps.store.flags.getHalt()).halted;
  }

  async halt(reason: string, by: string): Promise<{ drainedJobs: number; haltedRuns: string[] }> {
    const { store, bus, queue, clock, log } = this.deps;
    const now = clock();
    // 1. Persist first. From here on every worker stops at its next step check, whatever else fails.
    await store.flags.setHalt({ halted: true, reason, at: now.toISOString(), by }, now);
    // 2. Stop the queue from handing out jobs, then throw away what is waiting.
    await queue.pause();
    const drainedJobs = await queue.drain();
    // 3. Queued runs have no worker to notice the flag: mark them halted here.
    const haltedRuns = await store.runs.transitionAll(['queued'], 'halted', now, {
      statusReason: 'system.halt',
    });
    for (const runId of haltedRuns) {
      await bus.insertEvent({
        type: 'run.halted',
        runId,
        payload: { reason: 'system.halt', detail: reason },
      });
    }
    await bus.insertEvent({
      type: 'system.halted',
      payload: { reason, by, drainedJobs, haltedRuns },
    });
    log.warn({ reason, by, drainedJobs, haltedRuns: haltedRuns.length }, 'global halt engaged');
    return { drainedJobs, haltedRuns };
  }

  async resume(by: string): Promise<void> {
    const { store, bus, queue, clock, log } = this.deps;
    const now = clock();
    await store.flags.setHalt({ halted: false, reason: null, at: null, by }, now);
    await queue.resume();
    await bus.insertEvent({ type: 'system.resumed', payload: { by } });
    log.warn({ by }, 'global halt released');
  }

  /** Make Redis agree with MySQL after a restart. */
  async syncOnBoot(): Promise<void> {
    const { queue, log } = this.deps;
    const halted = await this.isHalted();
    const paused = await queue.isPaused();
    if (halted && !paused) {
      await queue.pause();
      log.warn('halt flag is set in MySQL: queue paused on boot');
    } else if (!halted && paused) {
      await queue.resume();
      log.info('queue was paused in Redis but no halt is set: queue resumed');
    }
  }
}
