import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/store/types.js';
import { buildHarness, call, type Harness } from './fixtures.js';

/**
 * Behavioural suites shared by the unit tests (memory store) and the MySQL integration tests.
 * `makeStore` must return a clean store for every test.
 */
export function executorSuite(makeStore: () => Promise<Store>): void {
  describe('executor: ceilings, budgets, approvals, idempotency', () => {
    let store: Store;
    beforeEach(async () => {
      store = await makeStore();
    });

    it('runs a reversible tool and finishes the run as done', async () => {
      const h = await buildHarness(store, { script: [call('echo', { message: 'hi' })] });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      const outcome = await h.executor.execute(runId);
      expect(outcome.status).toBe('done');
      expect(h.counts.echo).toBe(1);
      const run = await store.runs.get(runId);
      expect(run?.status).toBe('done');
      expect(run?.stepCount).toBe(2);
      const calls = await store.toolCalls.listByRun(runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.status).toBe('executed');
      expect(calls[0]?.output).toEqual({ message: 'hi' });
      expect(await h.eventTypes()).toEqual([
        'run.started',
        'run.step',
        'tool.requested',
        'tool.completed',
        'run.step',
        'run.done',
      ]);
    });

    it('costly call within the caps executes and is charged to run and day budgets', async () => {
      const h = await buildHarness(store, { script: [call('pay', { usd: 0.4 })] });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect((await h.executor.execute(runId)).status).toBe('done');
      expect(h.counts.pay).toBe(1);
      expect((await store.budgets.get('run', runId))?.spentUsd).toBeCloseTo(0.4, 6);
      expect((await store.budgets.get('day', '2026-09-09'))?.spentUsd).toBeCloseTo(0.4, 6);
      expect((await store.runs.get(runId))?.costUsd).toBeCloseTo(0.4, 6);
    });

    it('costly cap exceeded => run is blocked, tool never runs, nothing is skipped', async () => {
      // BUDGET_PER_RUN_USD is 1.00 in the test env: 0.7 fits, the next 0.7 does not.
      const h = await buildHarness(store, {
        script: [
          call('pay', { usd: 0.7 }),
          call('pay', { usd: 0.7 }),
          call('echo', { message: 'never' }),
        ],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      const outcome = await h.executor.execute(runId);
      expect(outcome).toEqual({ status: 'blocked', reason: 'budget' });
      expect(h.counts.pay).toBe(1);
      expect(h.counts.echo).toBe(0);
      const run = await store.runs.get(runId);
      expect(run?.status).toBe('blocked');
      expect(run?.blockedOn).toEqual({ kind: 'budget', id: runId });
      const calls = await store.toolCalls.listByRun(runId);
      expect(calls.map((c) => c.status)).toEqual(['executed', 'blocked']);
      const types = await h.eventTypes();
      expect(types).toContain('budget.exceeded');
      expect(types[types.length - 1]).toBe('run.blocked');
      const budget = await store.budgets.get('run', runId);
      expect(budget?.spentUsd).toBeCloseTo(0.7, 6);
    });

    it('per-day call cap exceeded => blocked on the day scope and the run reservation is rolled back', async () => {
      const h = await buildHarness(store, {
        env: { BUDGET_PER_DAY_CALLS: '1', BUDGET_PER_DAY_USD: '100', BUDGET_PER_RUN_USD: '100' },
        script: [call('pay', { usd: 0.1 }), call('pay', { usd: 0.1 })],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect((await h.executor.execute(runId)).status).toBe('blocked');
      expect(h.counts.pay).toBe(1);
      const run = await store.runs.get(runId);
      expect(run?.blockedOn?.kind).toBe('budget');
      expect(run?.blockedOn?.id).toBe('2026-09-09');
      expect((await store.budgets.get('run', runId))?.spentUsd).toBeCloseTo(0.1, 6);
      expect((await store.budgets.get('day', '2026-09-09'))?.callCount).toBe(1);
    });

    it('irreversible call always creates an approval and blocks the run; the tool does not run', async () => {
      const h = await buildHarness(store, { script: [call('wipe', { target: 'prod' })] });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      const outcome = await h.executor.execute(runId);
      expect(outcome).toEqual({ status: 'blocked', reason: 'approval' });
      expect(h.counts.wipe).toBe(0);
      const pending = await store.approvals.list({ status: 'pending', limit: 10 });
      expect(pending).toHaveLength(1);
      const calls = await store.toolCalls.listByRun(runId);
      expect(calls[0]?.status).toBe('awaiting_approval');
      expect(pending[0]?.toolCallId).toBe(calls[0]?.id);
      const run = await store.runs.get(runId);
      expect(run?.status).toBe('blocked');
      expect(run?.blockedOn).toEqual({ kind: 'approval', id: pending[0]?.id });
      expect(await h.eventTypes()).toEqual([
        'run.started',
        'run.step',
        'tool.requested',
        'approval.requested',
        'run.blocked',
      ]);
    });

    it('approve => the call executes exactly once on resume; reject => it never executes', async () => {
      const h = await buildHarness(store, {
        script: [call('wipe', { target: 'a' }), call('wipe', { target: 'b' })],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      await h.executor.execute(runId);
      let [approval] = await store.approvals.list({ status: 'pending', limit: 10 });
      if (!approval) throw new Error('no approval');

      const issued = await h.approvals.issueToken(approval.id);
      if (!issued) throw new Error('no token');
      const decided = await h.approvals.decide(approval.id, issued.token, 'approve', 'operator');
      expect(decided.ok).toBe(true);
      expect((await store.runs.get(runId))?.status).toBe('queued');
      expect(h.queue.enqueued.map((e) => e.runId)).toEqual([runId]);

      // Worker picks the run up again: the approved call runs once, then the second wipe blocks.
      expect((await h.executor.execute(runId)).status).toBe('blocked');
      expect(h.counts.wipe).toBe(1);
      [approval] = await store.approvals.list({ status: 'pending', limit: 10 });
      if (!approval) throw new Error('no second approval');
      const issued2 = await h.approvals.issueToken(approval.id);
      if (!issued2) throw new Error('no token');
      expect((await h.approvals.decide(approval.id, issued2.token, 'reject', 'operator')).ok).toBe(
        true,
      );
      expect((await h.executor.execute(runId)).status).toBe('done');
      expect(h.counts.wipe).toBe(1);
      const calls = await store.toolCalls.listByRun(runId);
      expect(calls.map((c) => c.status)).toEqual(['executed', 'rejected']);
    });

    it('halts with ceiling.steps when RUN_MAX_STEPS is reached', async () => {
      const h = await buildHarness(store, {
        env: { RUN_MAX_STEPS: '2' },
        script: [
          call('echo', { message: '1' }),
          call('echo', { message: '2' }),
          call('echo', { message: '3' }),
        ],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect(await h.executor.execute(runId)).toEqual({
        status: 'halted',
        reason: 'ceiling.steps',
      });
      expect(h.counts.echo).toBe(2);
      const run = await store.runs.get(runId);
      expect(run?.status).toBe('halted');
      expect(run?.statusReason).toBe('ceiling.steps');
      const events = await store.events.listAfter(null, 100);
      const halted = events.find((e) => e.type === 'run.halted');
      expect(halted?.payload).toEqual({ reason: 'ceiling.steps', limit: 2, value: 2 });
    });

    it('halts with ceiling.tokens when RUN_MAX_TOKENS is reached', async () => {
      const h = await buildHarness(store, {
        env: { RUN_MAX_TOKENS: '15' },
        script: [call('echo', { message: '1' }), call('echo', { message: '2' })],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect(await h.executor.execute(runId)).toEqual({
        status: 'halted',
        reason: 'ceiling.tokens',
      });
      expect(h.counts.echo).toBe(2);
    });

    it('halts with ceiling.wall_clock when active time exceeds RUN_MAX_WALL_CLOCK_MS', async () => {
      const h = await buildHarness(store, { env: { RUN_MAX_WALL_CLOCK_MS: '5000' } });
      // Every planner call moves the clock 3s forward: the second gate check sees 6s > 5s.
      h.planner.next = async () => {
        h.clock.advance(3000);
        return call('echo', { message: 'tick' });
      };
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect(await h.executor.execute(runId)).toEqual({
        status: 'halted',
        reason: 'ceiling.wall_clock',
      });
      expect(h.counts.echo).toBe(2);
      expect((await store.runs.get(runId))?.activeMs).toBeGreaterThanOrEqual(6000);
    });

    it('global halt flag stops a run before its next step and marks it halted', async () => {
      const h = await buildHarness(store);
      h.planner.next = async () => {
        await h.store.flags.setHalt(
          { halted: true, reason: 'test', at: null, by: 'test' },
          h.clock.clock(),
        );
        return call('echo', { message: 'last' });
      };
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect(await h.executor.execute(runId)).toEqual({ status: 'halted', reason: 'system.halt' });
      expect(h.counts.echo).toBe(1);
      expect((await store.runs.get(runId))?.status).toBe('halted');
    });

    it('does not start a queued run while halted', async () => {
      const h = await buildHarness(store, { script: [call('echo', { message: 'x' })] });
      await h.store.flags.setHalt(
        { halted: true, reason: 'test', at: null, by: 'test' },
        h.clock.clock(),
      );
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect((await h.executor.execute(runId)).status).toBe('halted');
      expect(h.counts.echo).toBe(0);
      expect(h.planner.contexts).toHaveLength(0);
    });

    it('retry with the same idempotency key never re-executes a persisted call', async () => {
      const h = await buildHarness(store, {
        script: [call('echo', { message: 'once' }, { idempotencyKey: 'explicit-key-0001' })],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      // Simulate a previous attempt that inserted the row and died mid-execution.
      await store.toolCalls.insert(
        {
          id: h.ids(),
          runId,
          step: 1,
          tool: 'echo',
          blastRadius: 'reversible',
          idempotencyKey: 'explicit-key-0001',
          input: { message: 'once' },
          estimatedCostUsd: 0,
          status: 'executing',
        },
        h.clock.clock(),
      );
      expect((await h.executor.execute(runId)).status).toBe('done');
      expect(h.counts.echo).toBe(0);
      const calls = await store.toolCalls.listByRun(runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.status).toBe('failed');
      expect(calls[0]?.error).toMatch(/not re-executed/);
    });

    it('a failing tool is recorded and the run continues', async () => {
      const h = await buildHarness(store, {
        script: [call('boom', {}), call('echo', { message: 'after' })],
      });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      expect((await h.executor.execute(runId)).status).toBe('done');
      const calls = await store.toolCalls.listByRun(runId);
      expect(calls.map((c) => c.status)).toEqual(['failed', 'executed']);
      expect(calls[0]?.error).toBe('kaboom');
    });

    it('a tool the agent may not use is refused without a tool_calls row', async () => {
      const h = await buildHarness(store, { script: [call('wipe', { target: 'x' })] });
      const agent = await h.createAgent(['echo']);
      const runId = await h.createRun(agent);
      expect((await h.executor.execute(runId)).status).toBe('done');
      expect(await store.toolCalls.listByRun(runId)).toHaveLength(0);
      expect(await h.eventTypes()).toContain('tool.failed');
    });

    it('a claimed run cannot be claimed twice', async () => {
      const h = await buildHarness(store, { script: [call('echo', { message: 'x' })] });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      await store.runs.transition(runId, ['queued'], 'running', h.clock.clock());
      const outcome = await h.executor.execute(runId);
      expect(outcome.status).toBe('running');
      expect(outcome.reason).toMatch(/not claimable/);
      expect(h.counts.echo).toBe(0);
    });
  });
}

export function approvalSuite(makeStore: () => Promise<Store>): void {
  describe('approval tokens', () => {
    let store: Store;
    let h: Harness;
    let approvalId: string;

    beforeEach(async () => {
      store = await makeStore();
      h = await buildHarness(store, { script: [call('wipe', { target: 'a' })] });
      const agent = await h.createAgent();
      const runId = await h.createRun(agent);
      await h.executor.execute(runId);
      const [approval] = await store.approvals.list({ status: 'pending', limit: 1 });
      if (!approval) throw new Error('no approval');
      approvalId = approval.id;
    });

    it('a token cannot be used twice', async () => {
      const issued = await h.approvals.issueToken(approvalId);
      if (!issued) throw new Error('no token');
      expect((await h.approvals.decide(approvalId, issued.token, 'approve', 'op')).ok).toBe(true);
      const again = await h.approvals.decide(approvalId, issued.token, 'approve', 'op');
      expect(again).toEqual({ ok: false, reason: 'already_decided' });
      expect((await store.approvals.get(approvalId))?.status).toBe('approved');
      expect(h.queue.enqueued).toHaveLength(1);
    });

    it('a token cannot be used after its TTL', async () => {
      const issued = await h.approvals.issueToken(approvalId);
      if (!issued) throw new Error('no token');
      h.clock.advance(h.config.approvals.tokenTtlMs + 1);
      expect(await h.approvals.decide(approvalId, issued.token, 'approve', 'op')).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect((await store.approvals.get(approvalId))?.status).toBe('pending');
      expect(h.queue.enqueued).toHaveLength(0);
    });

    it('a wrong or foreign token is rejected and nothing changes', async () => {
      await h.approvals.issueToken(approvalId);
      expect(await h.approvals.decide(approvalId, 'A'.repeat(43), 'approve', 'op')).toEqual({
        ok: false,
        reason: 'invalid_token',
      });
      expect((await store.approvals.get(approvalId))?.status).toBe('pending');
    });

    it('a token is bound to the approval it was issued for', async () => {
      // Second run with its own approval.
      const h2script = [call('wipe', { target: 'b' })];
      h.planner = Object.assign(h.planner, { script: h2script });
      const agent = await h.createAgent();
      const runId2 = await h.createRun(agent);
      h.planner.next = async () =>
        h2script.shift() ?? { kind: 'final', output: null, tokensUsed: 0 };
      await h.executor.execute(runId2);
      const pending = await store.approvals.list({ status: 'pending', limit: 10 });
      const other = pending.find((a) => a.id !== approvalId);
      if (!other) throw new Error('no second approval');

      const issued = await h.approvals.issueToken(other.id);
      if (!issued) throw new Error('no token');
      expect(await h.approvals.decide(approvalId, issued.token, 'approve', 'op')).toEqual({
        ok: false,
        reason: 'no_token',
      });
      expect((await store.approvals.get(approvalId))?.status).toBe('pending');
      expect((await store.approvals.get(other.id))?.status).toBe('pending');
    });

    it('issuing a new token invalidates the previous one', async () => {
      const first = await h.approvals.issueToken(approvalId);
      const second = await h.approvals.issueToken(approvalId);
      if (!first || !second) throw new Error('no token');
      expect(await h.approvals.decide(approvalId, first.token, 'approve', 'op')).toEqual({
        ok: false,
        reason: 'invalid_token',
      });
      expect((await h.approvals.decide(approvalId, second.token, 'approve', 'op')).ok).toBe(true);
    });

    it('no token can be issued once decided', async () => {
      const issued = await h.approvals.issueToken(approvalId);
      if (!issued) throw new Error('no token');
      await h.approvals.decide(approvalId, issued.token, 'reject', 'op');
      expect(await h.approvals.issueToken(approvalId)).toBeNull();
    });
  });
}
