import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request, { type Response as SupertestResponse } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepDecision } from '../../src/executor/planner.js';
import { createApp } from '../../src/http/app.js';
import { SESSION_COOKIE } from '../../src/http/session.js';
import { buildHarness, call, TEST_PASSWORD, type Harness } from '../support/fixtures.js';
import { createMemoryStore } from '../support/memoryStore.js';

async function appWith(
  env: Record<string, string | undefined> = {},
  script: StepDecision[] = [],
): Promise<{ app: Express; h: Harness }> {
  const store = createMemoryStore();
  const h = await buildHarness(store, { env, script });
  const app = createApp({
    config: h.config,
    store,
    bus: h.bus,
    halt: h.halt,
    executor: h.executor,
    approvals: h.approvals,
    dispatcher: h.queue,
    registry: h.registry,
    log: (await import('../support/fixtures.js')).silentLogger,
    clock: h.clock.clock,
    ids: () => randomUUID(),
    redisPing: async () => undefined,
    sseHeartbeatMs: 50,
  });
  return { app, h };
}

async function login(app: Express): Promise<string> {
  const res = await request(app).post('/auth/login').send({ password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie']?.[0];
  if (!cookie) throw new Error('no cookie');
  return cookie.split(';')[0] ?? '';
}

describe('auth', () => {
  it('login sets an httpOnly sameSite=strict cookie and records the attempt', async () => {
    const { app, h } = await appWith();
    const res = await request(app).post('/auth/login').send({ password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Secure/); // NODE_ENV=test
    expect(await h.eventTypes()).toEqual(['auth.login']);
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD);
  });

  it('marks the cookie Secure in production', async () => {
    const { app } = await appWith({ NODE_ENV: 'production' });
    const res = await request(app).post('/auth/login').send({ password: TEST_PASSWORD });
    expect(res.headers['set-cookie']?.[0]).toMatch(/Secure/);
  });

  it('rejects a wrong password with 401 and no cookie', async () => {
    const { app } = await appWith();
    const res = await request(app).post('/auth/login').send({ password: 'nope-nope-nope' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toEqual({
      error: { code: 'invalid_credentials', message: 'invalid password' },
    });
  });

  it('rate-limits login to 5 attempts per window', async () => {
    const { app } = await appWith();
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/auth/login').send({ password: 'wrong-wrong-wrong' });
      expect(res.status).toBe(401);
    }
    const res = await request(app).post('/auth/login').send({ password: TEST_PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
  });

  it('every other route requires the session; health does not', async () => {
    const { app } = await appWith();
    expect((await request(app).get('/health')).status).toBe(200);
    for (const path of [
      '/runs',
      '/agents',
      '/approvals',
      '/events',
      '/events/stream',
      '/system',
      '/tools',
      '/limits',
      '/auth/session',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    expect((await request(app).post('/halt').send({})).status).toBe(401);
    expect((await request(app).post('/resume').send({})).status).toBe(401);
    const cookie = await login(app);
    expect((await request(app).get('/auth/session').set('Cookie', cookie)).body.authenticated).toBe(
      true,
    );
    const tampered = `${cookie}x`;
    expect((await request(app).get('/auth/session').set('Cookie', tampered)).status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const { app } = await appWith();
    const cookie = await login(app);
    const res = await request(app).post('/auth/logout').set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']?.[0]).toMatch(/Max-Age=0/);
  });
});

describe('hardening', () => {
  it('sends CORS headers only for a listed origin, with credentials, never *', async () => {
    const { app } = await appWith();
    const allowed = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await request(app).get('/health').set('Origin', 'http://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets helmet headers and hides x-powered-by', async () => {
    const { app } = await appWith();
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('rejects bodies over 256kb and invalid JSON', async () => {
    const { app } = await appWith();
    const cookie = await login(app);
    const big = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: 'x'.repeat(300 * 1024) }));
    expect(big.status).toBe(413);
    const bad = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send('{nope');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
  });

  it('validation errors name the field', async () => {
    const { app } = await appWith();
    const cookie = await login(app);
    const res = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: 'not-a-uuid', task: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      'agentId',
      'task',
    ]);
  });
});

describe('halt and resume', () => {
  it('POST /halt persists the flag, pauses and drains the queue, halts queued runs, and logs system.halted', async () => {
    const { app, h } = await appWith();
    const cookie = await login(app);
    const agent = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', model: 'm', tools: ['echo'] });
    expect(agent.status).toBe(201);
    const run = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: agent.body.agent.id, task: 'go' });
    expect(run.status).toBe(201);
    expect(h.queue.waiting).toHaveLength(1);

    const halt = await request(app).post('/halt').set('Cookie', cookie).send({ reason: 'smoke' });
    expect(halt.status).toBe(200);
    expect(halt.body).toEqual({ halted: true, drainedJobs: 1, haltedRuns: [run.body.run.id] });
    expect(h.queue.paused).toBe(true);
    expect(h.queue.waiting).toHaveLength(0);
    expect(await h.halt.isHalted()).toBe(true);
    expect((await h.store.runs.get(run.body.run.id))?.status).toBe('halted');
    const system = await request(app).get('/system').set('Cookie', cookie);
    expect(system.body).toMatchObject({ halted: true, reason: 'smoke' });
    const types = await h.eventTypes();
    expect(types).toContain('system.halted');
    expect(types.indexOf('run.halted')).toBeLessThan(types.indexOf('system.halted'));

    const resume = await request(app).post('/resume').set('Cookie', cookie);
    expect(resume.status).toBe(200);
    expect(h.queue.paused).toBe(false);
    expect(await h.halt.isHalted()).toBe(false);
    expect((await h.eventTypes()).at(-1)).toBe('system.resumed');
  });
});

describe('agents', () => {
  it('creates with stats, refuses a taken name and unknown tools, patches, and retires', async () => {
    const { app, h } = await appWith();
    const cookie = await login(app);
    const created = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'ops', model: 'm', tools: ['echo'] });
    expect(created.status).toBe(201);
    const id: string = created.body.agent.id;
    expect(created.body.stats).toEqual({
      agentId: id,
      activeRun: null,
      runsToday: 0,
      spentTodayUsd: 0,
      lastRunAt: null,
    });
    expect(created.body.recentRuns).toEqual([]);

    const dup = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'ops', model: 'm' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('name_taken');

    const unknownTool = await request(app)
      .patch(`/agents/${id}`)
      .set('Cookie', cookie)
      .send({ tools: ['nope'] });
    expect(unknownTool.status).toBe(400);
    expect(unknownTool.body.error.code).toBe('unknown_tool');
    const empty = await request(app).patch(`/agents/${id}`).set('Cookie', cookie).send({});
    expect(empty.status).toBe(400);
    const missing = await request(app)
      .patch('/agents/00000000-0000-4000-8000-000000000000')
      .set('Cookie', cookie)
      .send({ enabled: false });
    expect(missing.status).toBe(404);

    const patched = await request(app)
      .patch(`/agents/${id}`)
      .set('Cookie', cookie)
      .send({ enabled: false, tools: ['echo', 'pay'] });
    expect(patched.status).toBe(200);
    expect(patched.body.agent.enabled).toBe(false);
    expect(patched.body.agent.tools).toEqual(['echo', 'pay']);

    const list = await request(app).get('/agents').set('Cookie', cookie);
    expect(list.body.agents).toHaveLength(1);
    expect(list.body.agents[0].agent.enabled).toBe(false);
    expect(list.body.agents[0].stats.agentId).toBe(id);

    const run = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: id, task: 'go' });
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe('agent_disabled');

    const events = await h.store.events.listAfter(null, 100);
    const updated = events.find((e) => e.type === 'agent.updated');
    expect(updated?.payload).toEqual({ agentId: id, name: 'ops', changes: ['enabled', 'tools'] });
  });
});

describe('runs', () => {
  it('pages newest first with a cursor and filters by agent', async () => {
    const { app, h } = await appWith();
    const cookie = await login(app);
    const agent = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', model: 'm', tools: ['echo'] });
    const other = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'b', model: 'm', tools: ['echo'] });
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(1000);
      const res = await request(app)
        .post('/runs')
        .set('Cookie', cookie)
        .send({ agentId: agent.body.agent.id, task: `task ${i}` });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ toolCalls: [], approvals: [], budget: null });
      created.push(res.body.run.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const url = `/runs?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      // Annotated to break the inference cycle url -> cursor -> page -> url.
      const page: SupertestResponse = await request(app).get(url).set('Cookie', cookie);
      expect(page.status).toBe(200);
      seen.push(...page.body.runs.map((r: { id: string }) => r.id));
      cursor = page.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([...created].reverse());
    const none = await request(app)
      .get(`/runs?agentId=${other.body.agent.id}`)
      .set('Cookie', cookie);
    expect(none.body).toEqual({ runs: [], nextCursor: null });
    const bad = await request(app).get('/runs?cursor=garbage').set('Cookie', cookie);
    expect(bad.status).toBe(400);

    const roster = await request(app).get('/agents').set('Cookie', cookie);
    const row = roster.body.agents.find(
      (r: { agent: { id: string } }) => r.agent.id === agent.body.agent.id,
    );
    expect(row.stats.runsToday).toBe(5);
    expect(row.stats.activeRun).toEqual({ id: created[4], status: 'queued' });
  });

  it('halts one run idempotently and refuses a finished one', async () => {
    const { app, h } = await appWith({}, [call('echo', { message: 'x' })]);
    const cookie = await login(app);
    const agent = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', model: 'm', tools: ['echo'] });
    const queued = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: agent.body.agent.id, task: 'wait' });
    const runId: string = queued.body.run.id;

    const halted = await request(app)
      .post(`/runs/${runId}/halt`)
      .set('Cookie', cookie)
      .send({ reason: 'oops' });
    expect(halted.status).toBe(200);
    expect(halted.body.run).toMatchObject({
      id: runId,
      status: 'halted',
      statusReason: 'operator',
    });
    const again = await request(app).post(`/runs/${runId}/halt`).set('Cookie', cookie).send({});
    expect(again.status).toBe(200);
    expect(again.body.run.status).toBe('halted');
    const haltEvents = (await h.store.events.listAfter(null, 100)).filter(
      (e) => e.type === 'run.halted',
    );
    expect(haltEvents).toHaveLength(1);
    expect(haltEvents[0]?.payload).toEqual({ reason: 'operator', by: 'operator', detail: 'oops' });

    const second = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: agent.body.agent.id, task: 'finish' });
    expect((await h.executor.execute(second.body.run.id)).status).toBe('done');
    const finished = await request(app)
      .post(`/runs/${second.body.run.id}/halt`)
      .set('Cookie', cookie)
      .send({});
    expect(finished.status).toBe(409);
    expect(finished.body.error.code).toBe('run_finished');
    expect(
      (
        await request(app)
          .post('/runs/00000000-0000-4000-8000-000000000000/halt')
          .set('Cookie', cookie)
          .send({})
      ).status,
    ).toBe(404);
  });

  it('refuses to start a run while the system is halted', async () => {
    const { app } = await appWith();
    const cookie = await login(app);
    const agent = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'a', model: 'm', tools: ['echo'] });
    await request(app).post('/halt').set('Cookie', cookie).send({});
    const res = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: agent.body.agent.id, task: 'go' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('system_halted');
  });
});

describe('limits', () => {
  it('exposes the enforced ceilings and caps read-only', async () => {
    const { app } = await appWith();
    const cookie = await login(app);
    const res = await request(app).get('/limits').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      maxSteps: 10,
      maxTokens: 10_000,
      maxWallClockMs: 60_000,
      perRunUsd: 1,
      perDayUsd: 5,
      perDayCalls: 100,
      approvalTokenTtlMs: 600_000,
    });
    expect((await request(app).post('/limits').set('Cookie', cookie).send({})).status).toBe(404);
  });
});

describe('approval queue', () => {
  it('lists a budget hold with its call, run and agent, then decides it', async () => {
    const { app, h } = await appWith({}, [
      call('pay', { usd: 0.7 }),
      call('pay', { usd: 0.7 }),
      call('echo', { message: 'end' }),
    ]);
    const cookie = await login(app);
    const agent = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'spender', model: 'm', tools: ['echo', 'pay'] });
    const created = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: agent.body.agent.id, task: 'spend' });
    const runId: string = created.body.run.id;
    expect(await h.executor.execute(runId)).toEqual({ status: 'blocked', reason: 'budget' });

    const queue = await request(app).get('/approvals?status=pending').set('Cookie', cookie);
    expect(queue.status).toBe(200);
    expect(queue.body.approvals).toHaveLength(1);
    const item = queue.body.approvals[0];
    expect(item.approval).toMatchObject({ kind: 'budget', status: 'pending', runId });
    expect(item.toolCall).toMatchObject({ tool: 'pay', status: 'blocked', estimatedCostUsd: 0.7 });
    expect(item.run).toMatchObject({
      id: runId,
      status: 'blocked',
      blockedOn: { kind: 'budget', id: item.approval.id },
    });
    expect(item.agent).toMatchObject({ id: agent.body.agent.id, name: 'spender' });

    const detail = await request(app).get(`/runs/${runId}`).set('Cookie', cookie);
    expect(detail.body.approvals).toHaveLength(1);
    expect(detail.body.budget).toMatchObject({ scope: 'run', key: runId });
    expect(detail.body.agent.name).toBe('spender');

    const token = await request(app)
      .post(`/approvals/${item.approval.id}/token`)
      .set('Cookie', cookie);
    expect(token.status).toBe(200);
    const decided = await request(app)
      .post(`/approvals/${item.approval.id}/decide`)
      .set('Cookie', cookie)
      .send({ token: token.body.token, decision: 'approve' });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({
      approval: { status: 'approved', kind: 'budget' },
      resumed: true,
    });
    expect(
      (await request(app).get('/approvals?status=pending').set('Cookie', cookie)).body.approvals,
    ).toEqual([]);
    const all = await request(app).get('/approvals').set('Cookie', cookie);
    expect(all.body.approvals).toHaveLength(1);
  });

  it('hides a pending approval whose run was halted and refuses to decide it', async () => {
    const { app, h } = await appWith({}, [call('wipe', { target: 'prod' })]);
    const cookie = await login(app);
    const agent = await request(app)
      .post('/agents')
      .set('Cookie', cookie)
      .send({ name: 'wiper', model: 'm', tools: ['wipe'] });
    const created = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .send({ agentId: agent.body.agent.id, task: 'wipe it' });
    const runId: string = created.body.run.id;
    expect(await h.executor.execute(runId)).toEqual({ status: 'blocked', reason: 'approval' });
    const before = await request(app).get('/approvals?status=pending').set('Cookie', cookie);
    expect(before.body.approvals).toHaveLength(1);
    expect(before.body.approvals[0].approval.kind).toBe('irreversible');
    const approvalId: string = before.body.approvals[0].approval.id;
    const token = await request(app).post(`/approvals/${approvalId}/token`).set('Cookie', cookie);

    expect(
      (await request(app).post(`/runs/${runId}/halt`).set('Cookie', cookie).send({})).status,
    ).toBe(200);
    expect(
      (await request(app).get('/approvals?status=pending').set('Cookie', cookie)).body.approvals,
    ).toEqual([]);
    const decided = await request(app)
      .post(`/approvals/${approvalId}/decide`)
      .set('Cookie', cookie)
      .send({ token: token.body.token, decision: 'approve' });
    expect(decided.status).toBe(409);
    expect(decided.body.error.code).toBe('run_not_blocked');
    expect(h.counts.wipe).toBe(0);
  });
});

describe('events', () => {
  let server: http.Server;
  let baseUrl: string;
  let cookie: string;
  let h: Harness;

  beforeEach(async () => {
    const built = await appWith();
    h = built.h;
    cookie = await login(built.app);
    server = http.createServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  function openStream(headers: Record<string, string>): Promise<{
    res: http.IncomingMessage;
    read: (until: (text: string) => boolean) => Promise<string>;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/events/stream`,
        { headers: { Cookie: cookie, ...headers } },
        (res) => {
          let text = '';
          const waiters: { until: (t: string) => boolean; resolve: (t: string) => void }[] = [];
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
            for (const w of [...waiters]) {
              if (w.until(text)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(text);
              }
            }
          });
          resolve({
            res,
            read: (until) =>
              new Promise((r) => {
                if (until(text)) r(text);
                else waiters.push({ until, resolve: r });
              }),
          });
        },
      );
      req.on('error', reject);
    });
  }

  it('GET /events lists rows after a cursor', async () => {
    const a = await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'a' } });
    await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'b' } });
    const res = await fetch(`${baseUrl}/events?after=${a.id}`, { headers: { Cookie: cookie } });
    const body = (await res.json()) as { events: { id: string; payload: { by: string } }[] };
    expect(body.events.map((e) => e.payload.by)).toEqual(['b']);
  });

  it('GET /events/tail returns the newest rows ascending and pages backwards with before', async () => {
    const ids: string[] = [];
    for (const by of ['a', 'b', 'c', 'd']) {
      ids.push((await h.bus.insertEvent({ type: 'system.resumed', payload: { by } })).id);
    }
    const headers = { Cookie: cookie };
    const tail = (await (await fetch(`${baseUrl}/events/tail?limit=2`, { headers })).json()) as {
      events: { id: string; payload: { by: string } }[];
    };
    expect(tail.events.map((e) => e.payload.by)).toEqual(['c', 'd']);
    const earlier = (await (
      await fetch(`${baseUrl}/events/tail?limit=2&before=${ids[2]}`, { headers })
    ).json()) as { events: { id: string }[] };
    expect(earlier.events.map((e) => e.id)).toEqual([ids[0], ids[1]]);
    const bad = await fetch(`${baseUrl}/events/tail?before=abc`, { headers });
    expect(bad.status).toBe(400);
    expect((await request(server).get('/events/tail')).status).toBe(401);
  });

  it('streams with SSE headers, replays after Last-Event-ID, then goes live without gaps or duplicates', async () => {
    const first = await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'one' } });
    const second = await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'two' } });
    const third = await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'three' } });

    const { res, read } = await openStream({ 'Last-Event-ID': first.id });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headers['cache-control']).toMatch(/no-cache/);

    await read((t) => t.includes('"by":"three"'));
    const fourth = await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'four' } });
    const text = await read((t) => t.includes('"by":"four"') && t.includes(': hb'));
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]);
    expect(ids).toEqual([second.id, third.id, fourth.id]);
    expect(text).not.toContain('"by":"one"');
    expect(text).toMatch(/^event: system\.resumed$/m);
    expect(text).toContain('retry: 3000');
    res.destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.bus.listenerCount).toBe(0);
  });

  it('without Last-Event-ID it streams live only', async () => {
    await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'old' } });
    const { res, read } = await openStream({});
    await h.bus.insertEvent({ type: 'system.resumed', payload: { by: 'new' } });
    const text = await read((t) => t.includes('"by":"new"'));
    expect(text).not.toContain('"by":"old"');
    res.destroy();
  });
});
