import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { SESSION_COOKIE } from '../../src/http/session.js';
import { buildHarness, TEST_PASSWORD, type Harness } from '../support/fixtures.js';
import { createMemoryStore } from '../support/memoryStore.js';

async function appWith(
  env: Record<string, string | undefined> = {},
): Promise<{ app: Express; h: Harness }> {
  const store = createMemoryStore();
  const h = await buildHarness(store, { env });
  const app = createApp({
    config: h.config,
    store,
    bus: h.bus,
    halt: h.halt,
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
