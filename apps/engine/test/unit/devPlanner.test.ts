import { describe, expect, it } from 'vitest';
import { DevPlanner, parseDevTask } from '../../src/executor/devPlanner.js';
import { registerDevTools } from '../../src/tools/dev/index.js';
import { buildHarness } from '../support/fixtures.js';
import { createMemoryStore } from '../support/memoryStore.js';

describe('dev planner: task parsing', () => {
  it('maps demo keywords, explicit plans and free text', () => {
    expect(parseDevTask('demo:happy').steps).toHaveLength(2);
    expect(parseDevTask('demo:ceiling').ending).toBe('loop');
    expect(parseDevTask('DEMO:Failure').ending).toBe('fail');
    expect(parseDevTask('demo:nope').error).toMatch(/unknown demo plan "nope"/);
    const plan = parseDevTask(
      'plan:[{"tool":"echo","input":{"message":"x"}},{"tool":"demo.pay","input":{"usd":1},"tokens":3}]',
    );
    expect(plan.steps.map((s) => s.tool)).toEqual(['echo', 'demo.pay']);
    expect(plan.steps[0]?.tokens).toBe(10);
    expect(plan.steps[1]?.tokens).toBe(3);
    expect(parseDevTask('plan:{not').error).toMatch(/not valid JSON/);
    expect(parseDevTask('plan:[{"input":1}]').error).toMatch(/does not match/);
    expect(parseDevTask('say hello')).toEqual({
      name: 'echo',
      steps: [{ tool: 'echo', input: { message: 'say hello' }, tokens: 10 }],
      ending: 'final',
    });
  });
});

describe('dev planner: every run state through the executor', () => {
  const TOOLS = ['echo', 'demo.pay', 'demo.wipe', 'demo.fail'];

  async function harness(env: Record<string, string | undefined> = {}) {
    const h = await buildHarness(createMemoryStore(), { planner: new DevPlanner(), env });
    registerDevTools(h.registry);
    return h;
  }

  it('demo:happy ends done and reports the plan in the output', async () => {
    const h = await harness();
    const runId = await h.createRun(await h.createAgent(TOOLS), 'demo:happy');
    expect(await h.executor.execute(runId)).toEqual({ status: 'done' });
    const run = await h.store.runs.get(runId);
    expect(run?.output).toEqual({ plan: 'happy', completedSteps: 2 });
    expect(h.counts.echo).toBe(2);
  });

  it('demo:approval waits for the operator and finishes once approved', async () => {
    const h = await harness();
    const runId = await h.createRun(await h.createAgent(TOOLS), 'demo:approval');
    expect(await h.executor.execute(runId)).toEqual({ status: 'blocked', reason: 'approval' });
    const [approval] = await h.store.approvals.list({ status: 'pending', limit: 1 });
    if (!approval) throw new Error('no approval');
    expect(approval.kind).toBe('irreversible');
    const issued = await h.approvals.issueToken(approval.id);
    if (!issued) throw new Error('no token');
    expect((await h.approvals.decide(approval.id, issued.token, 'approve', 'op')).ok).toBe(true);
    expect(await h.executor.execute(runId)).toEqual({ status: 'done' });
    const calls = await h.store.toolCalls.listByRun(runId);
    expect(calls.map((c) => `${c.tool}:${c.status}`)).toEqual([
      'echo:executed',
      'demo.wipe:executed',
      'echo:executed',
    ]);
    expect((await h.store.runs.get(runId))?.output).toEqual({
      plan: 'approval',
      completedSteps: 3,
    });
  });

  it('demo:budget stops on a budget hold after one small spend', async () => {
    const h = await harness();
    const runId = await h.createRun(await h.createAgent(TOOLS), 'demo:budget');
    expect(await h.executor.execute(runId)).toEqual({ status: 'blocked', reason: 'budget' });
    const [hold] = await h.store.approvals.list({ status: 'pending', limit: 1 });
    expect(hold?.kind).toBe('budget');
    expect((await h.store.budgets.get('run', runId))?.spentUsd).toBeCloseTo(0.01, 6);
  });

  it('demo:failure fails the run by design', async () => {
    const h = await harness();
    const runId = await h.createRun(await h.createAgent(TOOLS), 'demo:failure');
    expect((await h.executor.execute(runId)).status).toBe('failed');
    expect((await h.store.runs.get(runId))?.statusReason).toMatch(/fails here, by design/);
    expect(h.counts.echo).toBe(1);
  });

  it('demo:ceiling runs until RUN_MAX_STEPS halts it', async () => {
    const h = await harness({ RUN_MAX_STEPS: '4' });
    const runId = await h.createRun(await h.createAgent(TOOLS), 'demo:ceiling');
    expect(await h.executor.execute(runId)).toEqual({ status: 'halted', reason: 'ceiling.steps' });
    expect(h.counts.echo).toBe(4);
  });

  it('a malformed plan fails the run with the parse error, before any tool runs', async () => {
    const h = await harness();
    const runId = await h.createRun(await h.createAgent(TOOLS), 'plan:{');
    expect((await h.executor.execute(runId)).status).toBe('failed');
    expect((await h.store.runs.get(runId))?.statusReason).toMatch(/not valid JSON/);
    expect(await h.store.toolCalls.listByRun(runId)).toEqual([]);
  });
});
