import type { Budget, BudgetScope } from '@marsad/shared';
import { utcDay } from '../clock.js';
import type { BudgetStore } from '../store/types.js';

export interface BudgetCapsConfig {
  perRunUsd: number;
  perDayUsd: number;
  perDayCalls: number;
}

export interface BudgetReservation {
  runId: string;
  day: string;
  amountUsd: number;
}

export type BudgetReserveOutcome =
  { ok: true; reservation: BudgetReservation } | { ok: false; scope: BudgetScope; budget: Budget };

/**
 * Server-side spend caps for `costly` tools. Reservation happens before the call and is
 * atomic per scope; a failed reservation is reported, never skipped over.
 */
export class BudgetGuard {
  constructor(
    private readonly store: BudgetStore,
    private readonly caps: BudgetCapsConfig,
  ) {}

  async reserve(runId: string, amountUsd: number, now: Date): Promise<BudgetReserveOutcome> {
    const day = utcDay(now);
    const run = await this.store.reserve(
      'run',
      runId,
      amountUsd,
      { capUsd: this.caps.perRunUsd, capCalls: null },
      now,
    );
    if (!run.ok) return { ok: false, scope: 'run', budget: run.budget };
    const dayRes = await this.store.reserve(
      'day',
      day,
      amountUsd,
      { capUsd: this.caps.perDayUsd, capCalls: this.caps.perDayCalls },
      now,
    );
    if (!dayRes.ok) {
      // Give the run scope back what we took; the call is not happening.
      await this.store.adjust('run', runId, -amountUsd, now);
      return { ok: false, scope: 'day', budget: dayRes.budget };
    }
    return { ok: true, reservation: { runId, day, amountUsd } };
  }

  /** Replace the estimate with the actual spend in both scopes. */
  async settle(reservation: BudgetReservation, actualUsd: number, now: Date): Promise<void> {
    const delta = actualUsd - reservation.amountUsd;
    if (delta === 0) return;
    await this.store.adjust('run', reservation.runId, delta, now);
    await this.store.adjust('day', reservation.day, delta, now);
  }
}
