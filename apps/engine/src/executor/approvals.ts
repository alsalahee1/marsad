import { randomBytes } from 'node:crypto';
import type { Approval, ApprovalDecision } from '@marsad/shared';
import type { Clock } from '../clock.js';
import type { EventBus } from '../events/bus.js';
import type { Store } from '../store/types.js';
import type { RunDispatcher } from './dispatcher.js';
import { sha256Hex } from './idempotency.js';

export interface ApprovalServiceDeps {
  store: Store;
  bus: EventBus;
  dispatcher: RunDispatcher;
  tokenTtlMs: number;
  clock: Clock;
}

export type DecideResult =
  | { ok: true; approval: Approval; decision: ApprovalDecision; resumed: boolean }
  | {
      ok: false;
      reason: 'not_found' | 'already_decided' | 'no_token' | 'expired' | 'invalid_token';
    };

/**
 * Approval tokens: 256 random bits, handed out once, stored only as a SHA-256 hash, valid for
 * `tokenTtlMs`, consumable exactly once, and bound to the approval (and therefore to exactly one
 * tool call) they were issued for. Issuing a new token invalidates the previous one.
 */
export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  async issueToken(approvalId: string): Promise<{ token: string; expiresAt: Date } | null> {
    const { store, bus, clock, tokenTtlMs } = this.deps;
    const approval = await store.approvals.get(approvalId);
    if (approval?.status !== 'pending') return null;
    const token = randomBytes(32).toString('base64url');
    const now = clock();
    const expiresAt = new Date(now.getTime() + tokenTtlMs);
    const stored = await store.approvals.setToken(approvalId, sha256Hex(token), expiresAt, now);
    if (!stored) return null;
    await bus.insertEvent({
      type: 'approval.token_issued',
      runId: approval.runId,
      payload: { approvalId, expiresAt: expiresAt.toISOString() },
    });
    return { token, expiresAt };
  }

  async decide(
    approvalId: string,
    token: string,
    decision: ApprovalDecision,
    decidedBy: string,
  ): Promise<DecideResult> {
    const { store, bus, clock, dispatcher } = this.deps;
    const before = await store.approvals.get(approvalId);
    if (!before) return { ok: false, reason: 'not_found' };

    const now = clock();
    const consumed = await store.approvals.consumeToken(
      approvalId,
      sha256Hex(token),
      decision,
      decidedBy,
      now,
    );
    if (!consumed) {
      if (before.status !== 'pending') return { ok: false, reason: 'already_decided' };
      if (before.tokenExpiresAt === null) return { ok: false, reason: 'no_token' };
      if (new Date(before.tokenExpiresAt).getTime() <= now.getTime())
        return { ok: false, reason: 'expired' };
      return { ok: false, reason: 'invalid_token' };
    }

    const toolCallStatus = decision === 'approve' ? 'approved' : 'rejected';
    await store.toolCalls.transition(
      before.toolCallId,
      ['awaiting_approval'],
      toolCallStatus,
      now,
      {
        ...(decision === 'reject' ? { error: 'rejected by operator', finishedAt: now } : {}),
      },
    );
    await bus.insertEvent({
      type: 'approval.decided',
      runId: before.runId,
      payload: { approvalId, toolCallId: before.toolCallId, decision, decidedBy },
    });

    const resumed = await store.runs.transition(before.runId, ['blocked'], 'queued', now, {
      statusReason: null,
      blockedOn: null,
    });
    if (resumed) {
      await bus.insertEvent({
        type: 'run.resumed',
        runId: before.runId,
        payload: { via: 'approval', approvalId },
      });
      await dispatcher.enqueue(before.runId, `approval:${approvalId}`);
    }

    const approval = (await store.approvals.get(approvalId)) ?? before;
    return { ok: true, approval, decision, resumed };
  }
}
