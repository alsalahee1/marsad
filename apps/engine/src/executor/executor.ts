import type { Agent, JsonValue, RunStatus, ToolCall, ToolDefinition } from '@marsad/shared';
import type { Clock } from '../clock.js';
import { IdempotencyConflictError, errorMessage } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';
import type { BudgetGuard, BudgetReservation } from './budget.js';
import { deriveIdempotencyKey } from './idempotency.js';
import type { Planner, StepDecision } from './planner.js';

export interface RunCeilings {
  maxSteps: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export interface ExecutorDeps {
  store: Store;
  bus: EventBus;
  registry: ToolRegistry;
  planner: Planner;
  budget: BudgetGuard;
  halt: { isHalted(): Promise<boolean> };
  ceilings: RunCeilings;
  clock: Clock;
  ids: () => string;
  log: Logger;
}

export interface RunOutcome {
  status: RunStatus;
  reason?: string;
}

interface RunContext {
  runId: string;
  agent: Agent;
  signal: AbortSignal;
  log: Logger;
}

/** `null` means "keep looping"; an outcome means the run left `running`. */
type StepOutcome = RunOutcome | null;

/**
 * Tool dispatch loop. Everything the planner proposes passes through here, and every limit is
 * checked here in code, before the tool runs:
 *
 * - global halt flag and the three per-run ceilings, before every step;
 * - budget reservation before every `costly` call (exceeded => run `blocked`);
 * - an approval row before every `irreversible` call (always => run `blocked`);
 * - a persisted tool_calls row with a unique idempotency key before any execution.
 */
export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(runId: string): Promise<RunOutcome> {
    const { store, bus, clock, log } = this.deps;
    const initial = await store.runs.get(runId);
    if (!initial) throw new Error(`run ${runId} not found`);

    if (await this.deps.halt.isHalted()) {
      return this.haltRun(runId, 'system.halt', {});
    }

    const now = clock();
    const claimed = await store.runs.transition(runId, ['queued'], 'running', now);
    if (!claimed) {
      const current = await store.runs.get(runId);
      return { status: current?.status ?? 'failed', reason: 'run was not claimable' };
    }
    await bus.insertEvent({
      type: 'run.started',
      runId,
      payload: { resumed: initial.startedAt !== null },
    });

    const agent = await store.agents.get(initial.agentId);
    if (!agent) return this.failRun(runId, `agent ${initial.agentId} not found`);

    const controller = new AbortController();
    const remainingMs = Math.max(0, this.deps.ceilings.maxWallClockMs - initial.activeMs);
    const deadline = setTimeout(() => {
      controller.abort(new Error('wall-clock ceiling reached'));
    }, remainingMs);
    const ctx: RunContext = { runId, agent, signal: controller.signal, log: log.child({ runId }) };

    try {
      const approved = await store.toolCalls.findByRunAndStatus(runId, 'approved');
      if (approved) {
        const outcome = await this.executeCall(ctx, approved, undefined);
        if (outcome) return outcome;
      }
      for (;;) {
        const gate = await this.gate(ctx);
        if (gate) return gate;
        const outcome = await this.step(ctx);
        if (outcome) return outcome;
      }
    } catch (err) {
      ctx.log.error({ err }, 'executor crashed; failing run');
      return await this.failRun(runId, `executor error: ${errorMessage(err)}`);
    } finally {
      clearTimeout(deadline);
      if (!controller.signal.aborted) controller.abort(new Error('run left the executor'));
    }
  }

  /** Halt flag and ceilings. Runs before every step, reading fresh state each time. */
  private async gate(ctx: RunContext): Promise<StepOutcome> {
    const { store, ceilings, clock, halt } = this.deps;
    if (await halt.isHalted()) return this.haltRun(ctx.runId, 'system.halt', {});

    const run = await store.runs.get(ctx.runId);
    if (!run) throw new Error(`run ${ctx.runId} vanished`);
    if (run.status !== 'running')
      return { status: run.status, reason: 'run changed state outside the executor' };

    if (run.stepCount >= ceilings.maxSteps) {
      return this.haltRun(ctx.runId, 'ceiling.steps', {
        limit: ceilings.maxSteps,
        value: run.stepCount,
      });
    }
    if (run.tokensUsed >= ceilings.maxTokens) {
      return this.haltRun(ctx.runId, 'ceiling.tokens', {
        limit: ceilings.maxTokens,
        value: run.tokensUsed,
      });
    }
    const claimedAt = await store.runs.getClaimedAt(ctx.runId);
    const activeMs = store.runs.activeMs(run, claimedAt, clock());
    if (activeMs >= ceilings.maxWallClockMs) {
      return this.haltRun(ctx.runId, 'ceiling.wall_clock', {
        limit: ceilings.maxWallClockMs,
        value: activeMs,
      });
    }
    return null;
  }

  private async step(ctx: RunContext): Promise<StepOutcome> {
    const { store, bus, planner, clock } = this.deps;
    const run = await store.runs.get(ctx.runId);
    if (!run) throw new Error(`run ${ctx.runId} vanished`);
    const toolCalls = await store.toolCalls.listByRun(ctx.runId);
    const tools = this.allowedTools(ctx.agent);

    let decision: StepDecision;
    try {
      decision = await planner.next({
        run,
        agent: ctx.agent,
        toolCalls,
        tools,
        signal: ctx.signal,
      });
    } catch (err) {
      return this.failRun(ctx.runId, `planner error: ${errorMessage(err)}`);
    }

    const step = run.stepCount + 1;
    await store.runs.recordStep(ctx.runId, decision.tokensUsed, clock());
    await bus.insertEvent({
      type: 'run.step',
      runId: ctx.runId,
      payload: {
        step,
        decision: decision.kind,
        tokensUsed: decision.tokensUsed,
        ...(decision.kind === 'tool_call' ? { tool: decision.tool } : {}),
      },
    });

    switch (decision.kind) {
      case 'final': {
        const now = clock();
        const ok = await store.runs.transition(ctx.runId, ['running'], 'done', now, {
          output: decision.output,
          statusReason: null,
        });
        if (!ok) return { status: 'failed', reason: 'could not mark run done' };
        await bus.insertEvent({
          type: 'run.done',
          runId: ctx.runId,
          payload: { output: decision.output, steps: step },
        });
        return { status: 'done' };
      }
      case 'fail':
        return this.failRun(ctx.runId, decision.error);
      case 'tool_call':
        return this.dispatch(ctx, step, decision);
    }
  }

  private async dispatch(
    ctx: RunContext,
    step: number,
    decision: Extract<StepDecision, { kind: 'tool_call' }>,
  ): Promise<StepOutcome> {
    const { store, bus, registry, clock, ids } = this.deps;
    const tool = registry.get(decision.tool);
    if (!tool || !ctx.agent.tools.includes(tool.name)) {
      await bus.insertEvent({
        type: 'tool.failed',
        runId: ctx.runId,
        payload: {
          tool: decision.tool,
          step,
          error: tool ? 'tool not allowed for this agent' : 'unknown tool',
        },
      });
      return null;
    }
    const parsed = tool.input.safeParse(decision.input);
    if (!parsed.success) {
      await bus.insertEvent({
        type: 'tool.failed',
        runId: ctx.runId,
        payload: {
          tool: tool.name,
          step,
          error: `invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        },
      });
      return null;
    }
    const input = parsed.data as JsonValue;
    const idempotencyKey =
      decision.idempotencyKey ?? deriveIdempotencyKey(ctx.runId, step, tool.name, input);

    const existing = await store.toolCalls.findByIdempotencyKey(idempotencyKey);
    if (existing) return this.resumeExisting(ctx, existing);

    const toolEstimate = tool.estimateCostUsd ? tool.estimateCostUsd(input) : 0;
    const estimatedCostUsd = Math.max(toolEstimate, decision.estimatedCostUsd ?? 0);
    const now = clock();
    let toolCall: ToolCall;
    try {
      toolCall = await store.toolCalls.insert(
        {
          id: ids(),
          runId: ctx.runId,
          step,
          tool: tool.name,
          blastRadius: tool.blastRadius,
          idempotencyKey,
          input,
          estimatedCostUsd,
          status: 'pending',
        },
        now,
      );
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        const raced = await store.toolCalls.findByIdempotencyKey(idempotencyKey);
        if (raced) return this.resumeExisting(ctx, raced);
      }
      throw err;
    }
    await bus.insertEvent({
      type: 'tool.requested',
      runId: ctx.runId,
      payload: {
        toolCallId: toolCall.id,
        tool: tool.name,
        blastRadius: tool.blastRadius,
        step,
        input,
        idempotencyKey,
        estimatedCostUsd,
      },
    });

    switch (tool.blastRadius) {
      case 'reversible':
        return this.executeCall(ctx, toolCall, undefined);

      case 'costly': {
        const reserve = await this.deps.budget.reserve(ctx.runId, estimatedCostUsd, now);
        if (!reserve.ok) {
          const detail = `budget cap exceeded: ${reserve.scope} (${reserve.budget.key})`;
          await store.toolCalls.transition(toolCall.id, ['pending'], 'blocked', now, {
            error: detail,
          });
          await store.runs.transition(ctx.runId, ['running'], 'blocked', now, {
            statusReason: detail,
            blockedOn: { kind: 'budget', id: reserve.budget.key },
          });
          await bus.insertEvent({
            type: 'budget.exceeded',
            runId: ctx.runId,
            payload: {
              scope: reserve.budget.scope,
              key: reserve.budget.key,
              capUsd: reserve.budget.capUsd,
              spentUsd: reserve.budget.spentUsd,
              capCalls: reserve.budget.capCalls,
              callCount: reserve.budget.callCount,
              attemptedUsd: estimatedCostUsd,
              toolCallId: toolCall.id,
            },
          });
          await bus.insertEvent({
            type: 'run.blocked',
            runId: ctx.runId,
            payload: {
              reason: 'budget',
              toolCallId: toolCall.id,
              budget: {
                scope: reserve.budget.scope,
                key: reserve.budget.key,
                capUsd: reserve.budget.capUsd,
                spentUsd: reserve.budget.spentUsd,
                capCalls: reserve.budget.capCalls,
                callCount: reserve.budget.callCount,
              },
            },
          });
          return { status: 'blocked', reason: 'budget' };
        }
        return this.executeCall(ctx, toolCall, reserve.reservation);
      }

      case 'irreversible': {
        // No configuration is consulted here. Irreversible means the operator decides, every time.
        const approval = await store.approvals.create(
          { id: ids(), runId: ctx.runId, toolCallId: toolCall.id },
          now,
        );
        await store.toolCalls.transition(toolCall.id, ['pending'], 'awaiting_approval', now);
        await store.runs.transition(ctx.runId, ['running'], 'blocked', now, {
          statusReason: 'awaiting operator approval',
          blockedOn: { kind: 'approval', id: approval.id },
        });
        await bus.insertEvent({
          type: 'approval.requested',
          runId: ctx.runId,
          payload: {
            approvalId: approval.id,
            toolCallId: toolCall.id,
            tool: tool.name,
            step,
            input,
          },
        });
        await bus.insertEvent({
          type: 'run.blocked',
          runId: ctx.runId,
          payload: { reason: 'approval', approvalId: approval.id, toolCallId: toolCall.id },
        });
        return { status: 'blocked', reason: 'approval' };
      }
    }
  }

  /** A tool_calls row with this idempotency key already exists: a retry, never a re-execution. */
  private async resumeExisting(ctx: RunContext, existing: ToolCall): Promise<StepOutcome> {
    const { store, bus, clock } = this.deps;
    switch (existing.status) {
      case 'executed':
      case 'failed':
      case 'rejected':
        return null;
      case 'approved':
        return this.executeCall(ctx, existing, undefined);
      case 'awaiting_approval': {
        const approvals = await store.approvals.list({ status: 'pending', limit: 1000 });
        const approval = approvals.find((a) => a.toolCallId === existing.id);
        await store.runs.transition(ctx.runId, ['running'], 'blocked', clock(), {
          statusReason: 'awaiting operator approval',
          blockedOn: { kind: 'approval', id: approval?.id ?? null },
        });
        return { status: 'blocked', reason: 'approval' };
      }
      case 'blocked':
        await store.runs.transition(ctx.runId, ['running'], 'blocked', clock(), {
          statusReason: existing.error ?? 'budget cap exceeded',
          blockedOn: { kind: 'budget', id: null },
        });
        return { status: 'blocked', reason: 'budget' };
      case 'pending':
      case 'executing': {
        const now = clock();
        const detail =
          'interrupted: a previous attempt did not complete and the call was not re-executed';
        await store.toolCalls.transition(existing.id, ['pending', 'executing'], 'failed', now, {
          error: detail,
          finishedAt: now,
        });
        await bus.insertEvent({
          type: 'tool.failed',
          runId: ctx.runId,
          payload: {
            toolCallId: existing.id,
            tool: existing.tool,
            step: existing.step,
            error: detail,
          },
        });
        return null;
      }
    }
  }

  /** Runs a persisted tool call exactly once. */
  private async executeCall(
    ctx: RunContext,
    toolCall: ToolCall,
    reservation: BudgetReservation | undefined,
  ): Promise<StepOutcome> {
    const { store, bus, registry, clock, budget } = this.deps;
    const tool: RegisteredTool | undefined = registry.get(toolCall.tool);
    const now = clock();
    if (!tool) {
      await store.toolCalls.transition(toolCall.id, ['pending', 'approved'], 'failed', now, {
        error: 'tool no longer registered',
        finishedAt: now,
      });
      await bus.insertEvent({
        type: 'tool.failed',
        runId: ctx.runId,
        payload: {
          toolCallId: toolCall.id,
          tool: toolCall.tool,
          step: toolCall.step,
          error: 'tool no longer registered',
        },
      });
      return null;
    }
    const claimed = await store.toolCalls.transition(
      toolCall.id,
      ['pending', 'approved'],
      'executing',
      now,
      { startedAt: now },
    );
    if (!claimed) return null;

    const startedAt = clock();
    try {
      const result = await tool.execute(toolCall.input, {
        runId: ctx.runId,
        agentId: ctx.agent.id,
        step: toolCall.step,
        toolCallId: toolCall.id,
        idempotencyKey: toolCall.idempotencyKey,
        signal: ctx.signal,
        log: ctx.log.child({ toolCallId: toolCall.id, tool: tool.name }),
      });
      const finishedAt = clock();
      const actualCostUsd =
        result.costUsd ?? (tool.blastRadius === 'costly' ? toolCall.estimatedCostUsd : 0);
      await store.toolCalls.transition(toolCall.id, ['executing'], 'executed', finishedAt, {
        output: result.output,
        actualCostUsd,
        finishedAt,
      });
      if (actualCostUsd > 0) await store.runs.addCost(ctx.runId, actualCostUsd, finishedAt);
      if (reservation) await budget.settle(reservation, actualCostUsd, finishedAt);
      await bus.insertEvent({
        type: 'tool.completed',
        runId: ctx.runId,
        payload: {
          toolCallId: toolCall.id,
          tool: tool.name,
          output: result.output,
          actualCostUsd,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        },
      });
      return null;
    } catch (err) {
      // The reservation stays spent: a failed costly call may still have cost money.
      const finishedAt = clock();
      const error = errorMessage(err);
      await store.toolCalls.transition(toolCall.id, ['executing'], 'failed', finishedAt, {
        error,
        finishedAt,
      });
      await bus.insertEvent({
        type: 'tool.failed',
        runId: ctx.runId,
        payload: { toolCallId: toolCall.id, tool: tool.name, step: toolCall.step, error },
      });
      return null;
    }
  }

  private allowedTools(agent: Agent): ToolDefinition[] {
    const all = this.deps.registry.definitions();
    const allowed = new Set(agent.tools);
    return all.filter((t) => allowed.has(t.name));
  }

  async haltRun(
    runId: string,
    reason: 'ceiling.steps' | 'ceiling.tokens' | 'ceiling.wall_clock' | 'system.halt' | 'operator',
    extra: { limit?: number; value?: number; detail?: string },
  ): Promise<RunOutcome> {
    const { store, bus, clock } = this.deps;
    const ok = await store.runs.transition(
      runId,
      ['queued', 'running', 'blocked'],
      'halted',
      clock(),
      {
        statusReason: reason,
        blockedOn: null,
      },
    );
    if (ok) {
      await bus.insertEvent({ type: 'run.halted', runId, payload: { reason, ...extra } });
    }
    return { status: 'halted', reason };
  }

  private async failRun(runId: string, error: string): Promise<RunOutcome> {
    const { store, bus, clock } = this.deps;
    const run = await store.runs.get(runId);
    const ok = await store.runs.transition(runId, ['running'], 'failed', clock(), {
      statusReason: error.slice(0, 255),
    });
    if (ok) {
      await bus.insertEvent({
        type: 'run.failed',
        runId,
        payload: { error, steps: run?.stepCount ?? 0 },
      });
    }
    return { status: 'failed', reason: error };
  }
}
