#!/usr/bin/env node
/**
 * Renders every desk screen at the five CLAUDE.md breakpoints (375, 600, 768, 1024, 1440),
 * light and dark, plus two RTL passes, against a running engine (`pnpm dev`) with the demo
 * agents seeded. Not part of `pnpm test`: it needs Chromium and live services.
 *
 *   PLAYWRIGHT=/path/to/node_modules/playwright node apps/desk/e2e/screenshots.mjs out-dir
 *
 * Playwright is resolved from $PLAYWRIGHT or the global install, so the repo does not carry
 * a browser-sized dependency for a verification script.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');

const OUT = process.argv[2] ?? 'e2e/screenshots';
const DESK = process.env.DESK_URL ?? 'http://localhost:5173';
const ENGINE = process.env.ENGINE_URL ?? 'http://127.0.0.1:8080';
const PASSWORD = process.env.OPERATOR_PASSWORD;
if (!PASSWORD) throw new Error('set OPERATOR_PASSWORD (never commit it)');

const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  fold: { width: 600, height: 900 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1024, height: 768 },
  wide: { width: 1440, height: 900 },
};

// One API login for every context: the login route is rate-limited to 5 attempts per 15 min.
async function session() {
  const login = await fetch(`${ENGINE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const value = cookie.split('=').slice(1).join('=');
  const get = async (p) => (await fetch(`${ENGINE}${p}`, { headers: { cookie } })).json();
  const agents = (await get('/agents')).agents;
  const approvals = (await get('/approvals?status=pending')).approvals;
  const runs = (await get('/runs?limit=20')).runs;
  return {
    value,
    agentId: agents[0]?.agent.id,
    approvalId: approvals[0]?.approval.id,
    runId: (runs.find((r) => r.status === 'blocked') ?? runs[0])?.id,
  };
}

async function shoot(browser, name, viewport, colorScheme, dir, routes, s, errors) {
  const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
  await context.addCookies([
    {
      name: 'marsad_session',
      value: s.value,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  if (dir === 'rtl') {
    await context.addInitScript(() => {
      localStorage.setItem(
        'marsad.desk.prefs',
        JSON.stringify({ theme: 'system', density: 'compact', dir: 'rtl', railExpanded: false }),
      );
    });
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`);
  });
  for (const [label, path, text] of routes) {
    await page.goto(`${DESK}${path}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    if (text) {
      await page
        .getByText(text, { exact: false })
        .first()
        .waitFor({ timeout: 8000 })
        .catch(() => errors.push(`${name}/${label}: did not see "${text}"`));
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}-${label}.png` });
  }
  await context.close();
}

const s = await session();
const routes = [
  ['desk', '/', 'Spent today'],
  ['agents', s.agentId ? `/agents?agent=${s.agentId}` : '/agents', 'Agents'],
  ['approvals', s.approvalId ? `/approvals?approval=${s.approvalId}` : '/approvals', 'Approvals'],
  ['run', s.runId ? `/log?run=${s.runId}` : '/log', 'Event log'],
  ['log', '/log', 'Event log'],
  ['settings', '/settings', 'Direction'],
];
const errors = [];
const browser = await chromium.launch();
for (const [vp, size] of Object.entries(VIEWPORTS))
  await shoot(browser, `${vp}-light`, size, 'light', 'ltr', routes, s, errors);
await shoot(browser, 'desktop-dark', VIEWPORTS.desktop, 'dark', 'ltr', routes, s, errors);
await shoot(browser, 'phone-dark', VIEWPORTS.phone, 'dark', 'ltr', routes, s, errors);
await shoot(browser, 'phone-rtl', VIEWPORTS.phone, 'light', 'rtl', routes.slice(0, 3), s, errors);
await shoot(browser, 'wide-rtl', VIEWPORTS.wide, 'light', 'rtl', routes.slice(0, 3), s, errors);
await browser.close();
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no page errors');
process.exit(errors.length ? 1 : 0);
