import {
  CreateAgentRequestSchema,
  CreateRunRequestSchema,
  DecideApprovalRequestSchema,
  HaltRequestSchema,
  ListEventsQuerySchema,
  ListRunsQuerySchema,
  LoginRequestSchema,
  TailEventsQuerySchema,
} from '@marsad/shared';
import { verify as verifyArgon2 } from 'argon2';
import { stringifySetCookie } from 'cookie';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { utcDay } from '../clock.js';
import { HttpError, notFound } from '../errors.js';
import type { AppDeps } from './app.js';
import { locals, parseOrThrow, requireSession } from './middleware.js';
import { SESSION_COOKIE, issueSession } from './session.js';
import { streamEvents } from './sse.js';

const OPERATOR = 'operator';

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
  // exactly where this left off. Older history is `?before=<first id>`.
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

  // --- agents ---
  r.get('/agents', async (_req, res) => {
    res.json({ agents: await deps.store.agents.list() });
  });
  r.post('/agents', async (req, res) => {
    const body = parseOrThrow(CreateAgentRequestSchema, req.body);
    const unknown = body.tools.filter((t) => !deps.registry.has(t));
    if (unknown.length > 0)
      throw new HttpError(400, 'unknown_tool', `unknown tools: ${unknown.join(', ')}`);
    const agent = await deps.store.agents.create({ id: deps.ids(), ...body }, deps.clock());
    await deps.bus.insertEvent({
      type: 'agent.created',
      payload: { agentId: agent.id, name: agent.name },
    });
    res.status(201).json({ agent });
  });

  // --- runs ---
  r.get('/runs', async (req, res) => {
    const q = parseOrThrow(ListRunsQuerySchema, req.query);
    res.json({
      runs: await deps.store.runs.list({
        ...(q.status ? { status: q.status } : {}),
        limit: q.limit,
      }),
    });
  });
  r.get('/runs/:id', async (req, res) => {
    const id = req.params.id;
    const run = await deps.store.runs.get(id);
    if (!run) throw notFound('run');
    const toolCalls = await deps.store.toolCalls.listByRun(id);
    res.json({ run, toolCalls });
  });
  r.post('/runs', async (req, res) => {
    const body = parseOrThrow(CreateRunRequestSchema, req.body);
    const agent = await deps.store.agents.get(body.agentId);
    if (!agent) throw notFound('agent');
    if (!agent.enabled) throw new HttpError(409, 'agent_disabled', 'agent is disabled');
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
    res.status(201).json({ run });
  });

  // --- approvals ---
  r.get('/approvals', async (req, res) => {
    const status = req.query['status'];
    const approvals =
      status === 'pending' || status === 'approved' || status === 'rejected'
        ? await deps.store.approvals.list({ status, limit: 200 })
        : await deps.store.approvals.list({ limit: 200 });
    res.json({ approvals });
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
