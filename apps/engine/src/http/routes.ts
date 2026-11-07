import {
  CreateAgentRequestSchema,
  CreateRunRequestSchema,
  DecideApprovalRequestSchema,
  HaltRequestSchema,
  HaltRunRequestSchema,
  ListApprovalsQuerySchema,
  ListEventsQuerySchema,
  ListRunsQuerySchema,
  LoginRequestSchema,
  TailEventsQuerySchema,
  UpdateAgentRequestSchema,
  decodeRunCursor,
  encodeRunCursor,
  type Agent,
  type AgentDetailResponse,
  type AgentStats,
  type Approval,
  type ApprovalQueueItem,
  type Run,
  type RunDetailResponse,
} from '@marsad/shared';
import { verify as verifyArgon2 } from 'argon2';
import { stringifySetCookie } from 'cookie';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { utcDay } from '../clock.js';
import { AgentNameConflictError, HttpError, notFound } from '../errors.js';
import type { AppDeps } from './app.js';
import { locals, parseOrThrow, requireSession } from './middleware.js';
import { SESSION_COOKIE, issueSession } from './session.js';
import { streamEvents } from './sse.js';

const OPERATOR = 'operator';
const RECENT_RUNS = 20;

function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

function cookieOptions(deps: AppDeps, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: deps.config.isProduction,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/** Midnight UTC of the current day: the window "today" means everywhere in the engine. */
function dayStart(now: Date): Date {
  return new Date(`${utcDay(now)}T00:00:00.000Z`);
}

function emptyStats(agentId: string): AgentStats {
  return { agentId, activeRun: null, runsToday: 0, spentTodayUsd: 0, lastRunAt: null };
}

async function agentDetail(deps: AppDeps, agent: Agent): Promise<AgentDetailResponse> {
  const now = deps.clock();
  const [stats, recentRuns] = await Promise.all([
    deps.store.runs.agentStats(dayStart(now)),
    deps.store.runs.list({ agentId: agent.id, limit: RECENT_RUNS }),
  ]);
  return {
    agent,
    stats: stats.find((s) => s.agentId === agent.id) ?? emptyStats(agent.id),
    recentRuns,
  };
}

async function runDetail(deps: AppDeps, run: Run): Promise<RunDetailResponse> {
  const [agent, toolCalls, approvals, budget] = await Promise.all([
    deps.store.agents.get(run.agentId),
    deps.store.toolCalls.listByRun(run.id),
    deps.store.approvals.listByRun(run.id),
    deps.store.budgets.get('run', run.id),
  ]);
  return { run, agent, toolCalls, approvals, budget };
}

/** Everything the operator needs to decide, or null when the rows behind it are gone. */
async function queueItem(deps: AppDeps, approval: Approval): Promise<ApprovalQueueItem | null> {
  const [toolCall, run] = await Promise.all([
    deps.store.toolCalls.get(approval.toolCallId),
    deps.store.runs.get(approval.runId),
  ]);
  if (!toolCall || !run) return null;
  const agent = await deps.store.agents.get(run.agentId);
  return { approval, toolCall, run, agent };
}

function assertKnownTools(deps: AppDeps, tools: readonly string[]): void {
  const unknown = tools.filter((t) => !deps.registry.has(t));
  if (unknown.length > 0)
    throw new HttpError(400, 'unknown_tool', `unknown tools: ${unknown.join(', ')}`);
}

export function publicRoutes(deps: AppDeps): Router {
  const r = Router();

  r.get('/health', async (_req, res) => {
    try {
      await deps.store.ping();
      await deps.redisPing();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'rate_limited', message: 'too many login attempts; wait 15 minutes' },
      });
    },
  });

  r.post('/auth/login', loginLimiter, async (req, res) => {
    const body = parseOrThrow(LoginRequestSchema, req.body);
    const ip = clientIp(req);
    const ok = await verifyArgon2(deps.config.auth.operatorPasswordHash.reveal(), body.password);
    await deps.bus.insertEvent({ type: 'auth.login', payload: { ok, ip } });
    if (!ok) {
      throw new HttpError(401, 'invalid_credentials', 'invalid password');
    }
    const ttl = deps.config.auth.sessionTtlMs;
    const session = issueSession(deps.config.auth.sessionSecret, ttl, deps.clock());
    res.setHeader(
      'Set-Cookie',
      stringifySetCookie({
        name: SESSION_COOKIE,
        value: session.value,
        ...cookieOptions(deps, ttl),
      }),
    );
    res.json({ ok: true, expiresAt: new Date(session.claims.exp).toISOString() });
  });

  return r;
}

export function protectedRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireSession(deps.config, deps.clock));

  // --- auth ---
  r.get('/auth/session', (_req, res) => {
    const s = locals(res).session;
    res.json({ authenticated: true, expiresAt: s ? new Date(s.exp).toISOString() : null });
  });
  r.post('/auth/logout', (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      stringifySetCookie({ name: SESSION_COOKIE, value: '', ...cookieOptions(deps, 0), maxAge: 0 }),
    );
    res.status(204).end();
  });

  // --- global halt ---
  r.get('/system', async (_req, res) => {
    const s = await deps.halt.state();
    res.json({ halted: s.halted, haltedAt: s.at, reason: s.reason });
  });
  r.post('/halt', async (req, res) => {
    const body = parseOrThrow(HaltRequestSchema, req.body ?? {});
    const result = await deps.halt.halt(body.reason, OPERATOR);
    res.json({ halted: true, ...result });
  });
  r.post('/resume', async (_req, res) => {
    await deps.halt.resume(OPERATOR);
    res.json({ halted: false });
  });

  // --- events ---
  r.get('/events', async (req, res) => {
    const q = parseOrThrow(ListEventsQuerySchema, req.query);
    const events = await deps.store.events.listAfter(q.after ?? null, q.limit, q.runId);
    res.json({ events });
  });
  // The desk's first page: newest rows, ascending, so `?lastEventId=` on the stream continues
  // exactly where this left off. Older history is `?before=<first id>`. `runId` narrows it to
  // one run: that is the run timeline.
  r.get('/events/tail', async (req, res) => {
    const q = parseOrThrow(TailEventsQuerySchema, req.query);
    const events = await deps.store.events.listBefore(q.before ?? null, q.limit, q.runId);
    res.json({ events });
  });
  r.get('/events/stream', (req, res) =>
    streamEvents(req, res, {
      events: deps.store.events,
      bus: deps.bus,
      log: deps.log,
      ...(deps.sseHeartbeatMs !== undefined ? { heartbeatMs: deps.sseHeartbeatMs } : {}),
    }),
  );

  // --- agents (never deleted; `enabled: false` retires one) ---
  r.get('/agents', async (_req, res) => {
    const [agents, stats] = await Promise.all([
      deps.store.agents.list(),
      deps.store.runs.agentStats(dayStart(deps.clock())),
    ]);
    const byAgent = new Map(stats.map((s) => [s.agentId, s]));
    res.json({
      agents: agents.map((agent) => ({
        agent,
        stats: byAgent.get(agent.id) ?? emptyStats(agent.id),
      })),
    });
  });
  r.get('/agents/:id', async (req, res) => {
    const agent = await deps.store.agents.get(req.params.id);
    if (!agent) throw notFound('agent');
    res.json(await agentDetail(deps, agent));
  });
  r.post('/agents', async (req, res) => {
    const body = parseOrThrow(CreateAgentRequestSchema, req.body);
    assertKnownTools(deps, body.tools);
    let agent: Agent;
    try {
      agent = await deps.store.agents.create({ id: deps.ids(), ...body }, deps.clock());
    } catch (err) {
      if (err instanceof AgentNameConflictError)
        throw new HttpError(409, 'name_taken', err.message);
      throw err;
    }
    await deps.bus.insertEvent({
      type: 'agent.created',
      payload: { agentId: agent.id, name: agent.name },
    });
    res.status(201).json(await agentDetail(deps, agent));
  });
  r.patch('/agents/:id', async (req, res) => {
    const patch = parseOrThrow(UpdateAgentRequestSchema, req.body);
    if (patch.tools !== undefined) assertKnownTools(deps, patch.tools);
    let agent: Agent | null;
    try {
      agent = await deps.store.agents.update(req.params.id, patch, deps.clock());
    } catch (err) {
      if (err instanceof AgentNameConflictError)
        throw new HttpError(409, 'name_taken', err.message);
      throw err;
    }
    if (!agent) throw notFound('agent');
    await deps.bus.insertEvent({
      type: 'agent.updated',
      payload: { agentId: agent.id, name: agent.name, changes: Object.keys(patch).sort() },
    });
    res.json(await agentDetail(deps, agent));
  });

  // --- runs ---
  r.get('/runs', async (req, res) => {
    const q = parseOrThrow(ListRunsQuerySchema, req.query);
    const before = q.cursor === undefined ? undefined : decodeRunCursor(q.cursor);
    // One row past the page says whether there is a next page without a second query.
    const rows = await deps.store.runs.list({
      ...(q.status ? { status: q.status } : {}),
      ...(q.agentId ? { agentId: q.agentId } : {}),
      ...(before ? { before } : {}),
      limit: q.limit + 1,
    });
    const runs = rows.slice(0, q.limit);
    const last = runs[runs.length - 1];
    const nextCursor =
      rows.length > q.limit && last
        ? encodeRunCursor({ createdAt: last.createdAt, id: last.id })
        : null;
    res.json({ runs, nextCursor });
  });
  r.get('/runs/:id', async (req, res) => {
    const run = await deps.store.runs.get(req.params.id);
    if (!run) throw notFound('run');
    res.json(await runDetail(deps, run));
  });
  r.post('/runs', async (req, res) => {
    const body = parseOrThrow(CreateRunRequestSchema, req.body);
    const agent = await deps.store.agents.get(body.agentId);
    if (!agent) throw notFound('agent');
    if (!agent.enabled) throw new HttpError(409, 'agent_disabled', 'agent is disabled');
    if (await deps.halt.isHalted())
      throw new HttpError(409, 'system_halted', 'the system is halted; resume it first');
    const run = await deps.store.runs.create(
      { id: deps.ids(), agentId: agent.id, task: body.task },
      deps.clock(),
    );
    await deps.bus.insertEvent({
      type: 'run.created',
      runId: run.id,
      payload: { agentId: agent.id, task: run.task },
    });
    await deps.dispatcher.enqueue(run.id, 'start');
    res.status(201).json(await runDetail(deps, run));
  });
  // One run, not the system. Idempotent: halting a halted run is a 200 with the same row.
  r.post('/runs/:id/halt', async (req, res) => {
    const body = parseOrThrow(HaltRunRequestSchema, req.body ?? {});
    const run = await deps.store.runs.get(req.params.id);
    if (!run) throw notFound('run');
    if (run.status === 'done' || run.status === 'failed')
      throw new HttpError(409, 'run_finished', `run is already ${run.status}`);
    if (run.status !== 'halted') {
      await deps.executor.haltRun(run.id, 'operator', { detail: body.reason, by: OPERATOR });
    }
    const after = await deps.store.runs.get(run.id);
    if (!after) throw notFound('run');
    res.json(await runDetail(deps, after));
  });

  // --- approvals: irreversible calls and budget holds, one queue ---
  r.get('/approvals', async (req, res) => {
    const q = parseOrThrow(ListApprovalsQuerySchema, req.query);
    const approvals = await deps.store.approvals.list({
      ...(q.status ? { status: q.status } : {}),
      limit: q.limit,
    });
    const items: ApprovalQueueItem[] = [];
    for (const approval of approvals) {
      const item = await queueItem(deps, approval);
      if (!item) continue;
      // A pending approval whose run was halted meanwhile is history, not a decision to make.
      if (approval.status === 'pending' && item.run.status !== 'blocked') continue;
      items.push(item);
    }
    res.json({ approvals: items });
  });
  r.post('/approvals/:id/token', async (req, res) => {
    const issued = await deps.approvals.issueToken(req.params.id);
    if (!issued) throw new HttpError(409, 'not_pending', 'approval is not pending');
    res.json({ token: issued.token, expiresAt: issued.expiresAt.toISOString() });
  });
  r.post('/approvals/:id/decide', async (req, res) => {
    const body = parseOrThrow(DecideApprovalRequestSchema, req.body);
    const result = await deps.approvals.decide(req.params.id, body.token, body.decision, OPERATOR);
    if (!result.ok) {
      if (result.reason === 'not_found') throw notFound('approval');
      throw new HttpError(409, result.reason, `approval token rejected: ${result.reason}`);
    }
    res.json({ approval: result.approval, resumed: result.resumed });
  });

  // --- catalog ---
  r.get('/tools', async (_req, res) => {
    res.json({ tools: await deps.store.tools.list() });
  });
  // Read-only: the desk draws meters against these. Nothing here can be changed over HTTP.
  r.get('/limits', (_req, res) => {
    const { ceilings, budget, approvals } = deps.config;
    res.json({
      maxSteps: ceilings.maxSteps,
      maxTokens: ceilings.maxTokens,
      maxWallClockMs: ceilings.maxWallClockMs,
      perRunUsd: budget.perRunUsd,
      perDayUsd: budget.perDayUsd,
      perDayCalls: budget.perDayCalls,
      approvalTokenTtlMs: approvals.tokenTtlMs,
    });
  });
  r.get('/budgets/today', async (_req, res) => {
    const day = utcDay(deps.clock());
    const budget = await deps.store.budgets.get('day', day);
    res.json({
      day,
      caps: {
        usd: deps.config.budget.perDayUsd,
        calls: deps.config.budget.perDayCalls,
        perRunUsd: deps.config.budget.perRunUsd,
      },
      budget,
    });
  });

  return r;
}
