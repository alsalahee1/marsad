import type {
  Agent,
  Approval,
  Budget,
  BudgetScope,
  Event,
  Run,
  RunStatus,
  ToolCall,
  ToolCallStatus,
  ToolDefinition,
} from '@marsad/shared';
import { IdempotencyConflictError } from '../../src/errors.js';
import type { HaltState, RunPatch, Store, ToolCallPatch } from '../../src/store/types.js';

/**
 * In-memory Store with the same guarded-write semantics as the MySQL implementation.
 * Used by the unit suites; the integration suites run the same scenarios against MySQL.
 */
export function createMemoryStore(): Store & { dump(): { events: Event[] } } {
  const events: Event[] = [];
  const runs = new Map<string, Run & { claimedAt: Date | null }>();
  const toolCalls = new Map<string, ToolCall>();
  const approvals = new Map<
    string,
    Approval & { tokenHash: string | null; tokenUsedAt: Date | null }
  >();
  const budgets = new Map<string, Budget>();
  const tools = new Map<string, ToolDefinition & { active: boolean }>();
  const agents = new Map<string, Agent>();
  let halt: HaltState = { halted: false, reason: null, at: null, by: null };
  let nextEventId = 1;
  const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'halted'];

  const applyRunPatch = (run: Run, patch: RunPatch | undefined) => {
    if (!patch) return;
    if (patch.statusReason !== undefined) run.statusReason = patch.statusReason;
    if (patch.blockedOn !== undefined) run.blockedOn = patch.blockedOn;
    if (patch.output !== undefined) run.output = patch.output;
  };

  const transitionRun = (
    run: Run & { claimedAt: Date | null },
    to: RunStatus,
    now: Date,
    patch: RunPatch | undefined,
  ) => {
    run.status = to;
    if (to === 'running') {
      run.claimedAt = now;
      run.startedAt ??= now.toISOString();
      run.statusReason = null;
      run.blockedOn = null;
    } else {
      if (run.claimedAt) run.activeMs += Math.max(0, now.getTime() - run.claimedAt.getTime());
      run.claimedAt = null;
      if (TERMINAL.includes(to)) run.finishedAt = now.toISOString();
      if (to !== 'blocked') run.blockedOn = null;
    }
    applyRunPatch(run, patch);
    run.updatedAt = now.toISOString();
  };

  return {
    dump: () => ({ events: [...events] }),

    events: {
      async insert(input, at) {
        const event = {
          id: String(nextEventId++),
          type: input.type,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          at: at.toISOString(),
          payload: structuredClone(input.payload),
        } as Event;
        events.push(event);
        return event;
      },
      async listAfter(afterId, limit, runId) {
        const after = afterId === null ? -1n : BigInt(afterId);
        return events
          .filter((e) => BigInt(e.id) > after && (runId === undefined || e.runId === runId))
          .slice(0, limit);
      },
      async listBefore(beforeId, limit, runId) {
        const matching = events.filter(
          (e) =>
            (beforeId === null || BigInt(e.id) < BigInt(beforeId)) &&
            (runId === undefined || e.runId === runId),
        );
        return matching.slice(Math.max(0, matching.length - limit));
      },
    },

    runs: {
      async create(input, now) {
        const run: Run & { claimedAt: Date | null } = {
          id: input.id,
          agentId: input.agentId,
          status: 'queued',
          task: input.task,
          stepCount: 0,
          tokensUsed: 0,
          costUsd: 0,
          activeMs: 0,
          statusReason: null,
          blockedOn: null,
          output: null,
          createdAt: now.toISOString(),
          startedAt: null,
          finishedAt: null,
          updatedAt: now.toISOString(),
          claimedAt: null,
        };
        runs.set(run.id, run);
        return structuredClone(run);
      },
      async get(id) {
        const r = runs.get(id);
        if (!r) return null;
        const { claimedAt: _c, ...rest } = r;
        return structuredClone(rest);
      },
      async list(filter) {
        return [...runs.values()]
          .filter((r) => !filter.status || r.status === filter.status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, filter.limit)
          .map(({ claimedAt: _c, ...rest }) => structuredClone(rest));
      },
      async transition(id, from, to, now, patch) {
        const run = runs.get(id);
        if (!run || !from.includes(run.status)) return false;
        transitionRun(run, to, now, patch);
        return true;
      },
      async transitionAll(from, to, now, patch) {
        const ids: string[] = [];
        for (const run of runs.values()) {
          if (from.includes(run.status)) {
            transitionRun(run, to, now, patch);
            ids.push(run.id);
          }
        }
        return ids;
      },
      async recordStep(id, tokens, now) {
        const run = runs.get(id);
        if (!run) return;
        run.stepCount += 1;
        run.tokensUsed += tokens;
        run.updatedAt = now.toISOString();
      },
      async addCost(id, usd, now) {
        const run = runs.get(id);
        if (!run) return;
        run.costUsd += usd;
        run.updatedAt = now.toISOString();
      },
      activeMs(run, claimedAt, now) {
        return run.activeMs + (claimedAt ? Math.max(0, now.getTime() - claimedAt.getTime()) : 0);
      },
      async getClaimedAt(id) {
        return runs.get(id)?.claimedAt ?? null;
      },
    },

    toolCalls: {
      async insert(input, now) {
        for (const tc of toolCalls.values()) {
          if (tc.idempotencyKey === input.idempotencyKey)
            throw new IdempotencyConflictError(input.idempotencyKey);
        }
        const tc: ToolCall = {
          id: input.id,
          runId: input.runId,
          step: input.step,
          tool: input.tool,
          blastRadius: input.blastRadius,
          idempotencyKey: input.idempotencyKey,
          status: input.status,
          input: structuredClone(input.input),
          output: null,
          estimatedCostUsd: input.estimatedCostUsd,
          actualCostUsd: null,
          error: null,
          createdAt: now.toISOString(),
          startedAt: null,
          finishedAt: null,
        };
        toolCalls.set(tc.id, tc);
        return structuredClone(tc);
      },
      async get(id) {
        const tc = toolCalls.get(id);
        return tc ? structuredClone(tc) : null;
      },
      async findByIdempotencyKey(key) {
        for (const tc of toolCalls.values())
          if (tc.idempotencyKey === key) return structuredClone(tc);
        return null;
      },
      async listByRun(runId) {
        return [...toolCalls.values()]
          .filter((tc) => tc.runId === runId)
          .sort((a, b) => a.step - b.step || a.createdAt.localeCompare(b.createdAt))
          .map((tc) => structuredClone(tc));
      },
      async findByRunAndStatus(runId, status) {
        const list = [...toolCalls.values()]
          .filter((tc) => tc.runId === runId && tc.status === status)
          .sort((a, b) => a.step - b.step);
        const first = list[0];
        return first ? structuredClone(first) : null;
      },
      async transition(id, from, to, _now, patch: ToolCallPatch = {}) {
        const tc = toolCalls.get(id);
        if (!tc || !from.includes(tc.status)) return false;
        tc.status = to;
        if (patch.output !== undefined) tc.output = structuredClone(patch.output);
        if (patch.actualCostUsd !== undefined) tc.actualCostUsd = patch.actualCostUsd;
        if (patch.error !== undefined) tc.error = patch.error;
        if (patch.startedAt !== undefined) tc.startedAt = patch.startedAt.toISOString();
        if (patch.finishedAt !== undefined) tc.finishedAt = patch.finishedAt.toISOString();
        return true;
      },
    },

    approvals: {
      async create(input, now) {
        for (const a of approvals.values()) {
          if (a.toolCallId === input.toolCallId)
            throw new Error('approval already exists for tool call');
        }
        const a = {
          id: input.id,
          runId: input.runId,
          toolCallId: input.toolCallId,
          status: 'pending' as const,
          tokenExpiresAt: null,
          decidedAt: null,
          decidedBy: null,
          createdAt: now.toISOString(),
          tokenHash: null,
          tokenUsedAt: null,
        };
        approvals.set(a.id, a);
        const { tokenHash: _h, tokenUsedAt: _u, ...pub } = a;
        return structuredClone(pub);
      },
      async get(id) {
        const a = approvals.get(id);
        if (!a) return null;
        const { tokenHash: _h, tokenUsedAt: _u, ...pub } = a;
        return structuredClone(pub);
      },
      async list(filter) {
        return [...approvals.values()]
          .filter((a) => !filter.status || a.status === filter.status)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, filter.limit)
          .map(({ tokenHash: _h, tokenUsedAt: _u, ...pub }) => structuredClone(pub));
      },
      async setToken(id, tokenHash, expiresAt) {
        const a = approvals.get(id);
        if (a?.status !== 'pending') return false;
        a.tokenHash = tokenHash;
        a.tokenExpiresAt = expiresAt.toISOString();
        a.tokenUsedAt = null;
        return true;
      },
      async consumeToken(id, tokenHash, decision, decidedBy, now) {
        const a = approvals.get(id);
        if (!a) return false;
        if (a.status !== 'pending') return false;
        if (a.tokenHash === null || a.tokenHash !== tokenHash) return false;
        if (a.tokenUsedAt !== null) return false;
        if (a.tokenExpiresAt === null || new Date(a.tokenExpiresAt).getTime() <= now.getTime())
          return false;
        a.status = decision === 'approve' ? 'approved' : 'rejected';
        a.decidedAt = now.toISOString();
        a.decidedBy = decidedBy;
        a.tokenUsedAt = now;
        return true;
      },
    },

    budgets: {
      async reserve(scope, key, amountUsd, caps, now) {
        const k = `${scope}:${key}`;
        const row = budgets.get(k) ?? {
          scope,
          key,
          spentUsd: 0,
          callCount: 0,
          capUsd: caps.capUsd,
          capCalls: caps.capCalls,
          updatedAt: now.toISOString(),
        };
        row.capUsd = caps.capUsd;
        row.capCalls = caps.capCalls;
        budgets.set(k, row);
        const withinUsd = row.spentUsd + amountUsd <= row.capUsd + 1e-9;
        const withinCalls = row.capCalls === null || row.callCount + 1 <= row.capCalls;
        if (withinUsd && withinCalls) {
          row.spentUsd += amountUsd;
          row.callCount += 1;
          row.updatedAt = now.toISOString();
          return { ok: true, budget: structuredClone(row) };
        }
        return { ok: false, budget: structuredClone(row) };
      },
      async adjust(scope, key, deltaUsd, now) {
        const row = budgets.get(`${scope}:${key}`);
        if (!row) return;
        row.spentUsd = Math.max(0, row.spentUsd + deltaUsd);
        row.updatedAt = now.toISOString();
      },
      async get(scope: BudgetScope, key: string) {
        const row = budgets.get(`${scope}:${key}`);
        return row ? structuredClone(row) : null;
      },
    },

    tools: {
      async snapshot(defs) {
        for (const t of tools.values()) t.active = false;
        for (const d of defs) tools.set(d.name, { ...structuredClone(d), active: true });
      },
      async list() {
        return [...tools.values()].map((t) => structuredClone(t));
      },
    },

    agents: {
      async create(input, now) {
        const a: Agent = {
          id: input.id,
          name: input.name,
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: [...input.tools],
          enabled: true,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        agents.set(a.id, a);
        return structuredClone(a);
      },
      async get(id) {
        const a = agents.get(id);
        return a ? structuredClone(a) : null;
      },
      async list() {
        return [...agents.values()].map((a) => structuredClone(a));
      },
    },

    flags: {
      async getHalt() {
        return { ...halt };
      },
      async setHalt(state) {
        halt = { ...state };
      },
    },

    async ping() {
      /* always up */
    },
    async close() {
      /* nothing to release */
    },
  };
}

export type ToolCallStatusName = ToolCallStatus;
