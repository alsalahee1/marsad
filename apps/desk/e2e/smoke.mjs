// Deployment smoke check: drives the production bundle through the real proxy chain with a
// headless Chromium. Logs in once over the API (the login route is rate-limited), injects the
// session cookie, loads the desk, and fails on any console error, CSP violation, failed request,
// or a live stream that does not connect. Not part of `pnpm test`.
//
//   BASE_URL=https://marsad.example.com OPERATOR_PASSWORD='...' \
//     PLAYWRIGHT=/path/to/node_modules/playwright node apps/desk/e2e/smoke.mjs
//
// BASE_URL defaults to the local desk container (http://127.0.0.1:8088).
import { createRequire } from 'node:module';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '');
const PASSWORD = process.env.OPERATOR_PASSWORD;
const PLAYWRIGHT = process.env.PLAYWRIGHT ?? 'playwright';
if (!PASSWORD) {
  console.error('OPERATOR_PASSWORD is required');
  process.exit(2);
}

const { chromium } = createRequire(import.meta.url)(PLAYWRIGHT);

let login;
try {
  login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
} catch (err) {
  console.error(`FAIL ${BASE}: cannot reach the desk (${err.cause?.message ?? err.message})`);
  process.exit(1);
}
if (!login.ok) {
  console.error(`FAIL ${BASE}: login responded ${login.status}`);
  process.exit(1);
}
const [pair] = login.headers.get('set-cookie').split(';');
const eq = pair.indexOf('=');
const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) =>
  problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`),
);
const responses = [];
page.on('response', (r) => responses.push({ status: r.status(), url: r.url() }));
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
  });
});

await page.context().addCookies([{ ...cookie, url: BASE, httpOnly: true, sameSite: 'Strict' }]);
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 15_000 });
await page.waitForTimeout(3_000);

const stream = responses.find((r) => r.url.includes('/api/events/stream'));
if (!stream) problems.push('no request to /api/events/stream');
else if (stream.status !== 200) problems.push(`stream responded ${stream.status}`);
for (const r of responses) {
  if (r.url.includes('/api/') && r.status >= 400) problems.push(`${r.status} ${r.url}`);
}
const headers = (await page.goto(`${BASE}/`)).headers();
if (!headers['content-security-policy']) problems.push('no Content-Security-Policy header on /');
await browser.close();

if (problems.length > 0) {
  console.error('FAIL');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log(`OK ${BASE}: desk rendered, stream connected, CSP present, no console errors`);
