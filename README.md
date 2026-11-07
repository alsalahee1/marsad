# MARSAD

Agent operations desk: a single-operator control room for autonomous agents doing real work on
real systems. Read `CLAUDE.md` first — its security invariants are the spec, and this codebase is
their enforcement.

## Layout

```
packages/shared   domain contracts (zod schemas, RunStatus, BlastRadius, Event union, SSE envelope)
apps/engine       Express 5 API, MySQL event log, BullMQ worker, tool registry, executor, agent loop
apps/desk         React + Vite + Tailwind v4 desk; apps/desk/nginx is its production server config
docker/           MySQL account init: init/ (dev credentials), init-prod/ (passwords from .env)
deploy/           host Nginx vhost example for the VPS
docker-compose.yml        local MySQL + Redis (+ engine)     docker-compose.prod.yml  the VPS stack
.github/workflows/ci.yml  lint, typecheck, tests against MySQL + Redis, build, images to GHCR
```

Node 22, pnpm 10 (pinned in `package.json#packageManager`), TypeScript strict with
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.

## Quick start

```sh
corepack enable && pnpm install
cp .env.example .env               # fill in MYSQL_*, SESSION_SECRET, OPERATOR_PASSWORD_HASH
pnpm --filter @marsad/engine hash-password   # prints OPERATOR_PASSWORD_HASH for .env

docker compose up -d mysql redis   # or point .env at your own MySQL 8 + Redis 7
pnpm db:migrate                    # schema, triggers, and the app user's table grants
pnpm dev                           # engine on :8080, desk on http://localhost:5173, shared in watch mode
```

Checks, all from the root: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

Run the database and queue integration suites against real services:

```sh
MYSQL_HOST=127.0.0.1 REDIS_URL=redis://127.0.0.1:6379 pnpm test
```

Without `MYSQL_HOST` / `REDIS_URL` those suites are skipped and say so. Credentials default to
the docker-compose accounts (`docker/mysql/init/01-users.sql`); override with `MYSQL_*` vars.
The MySQL suite drops and recreates `MYSQL_DATABASE` (default `marsad_test`) — never point it
at the live database.

## Database accounts

Two MySQL accounts, on purpose (see `docker/mysql/init/01-users.sql` for the exact statements):

| account          | used by                | privileges                                                         |
| ---------------- | ---------------------- | ------------------------------------------------------------------ |
| `marsad_migrate` | `pnpm db:migrate` only | `ALL ON marsad.* WITH GRANT OPTION` + `SET_USER_ID` (for triggers) |
| `marsad_app`     | the engine at runtime  | table-level only, from `apps/engine/src/db/grants.ts`              |

The runtime account gets `SELECT, INSERT` on `events` and never `UPDATE` or `DELETE`, nothing
schema-wide, and no roles. The engine verifies its own grants at boot with `SHOW GRANTS` and
refuses to start if the account is broader than the map. Migration `0002` adds `BEFORE UPDATE`
and `BEFORE DELETE` triggers that `SIGNAL SQLSTATE '45000'` as the second line of defence, so
even the migration user cannot rewrite history.

On a VPS with MySQL 8.0, create the accounts with the init file's statements and real
passwords. On MySQL 8.4 replace `GRANT SET_USER_ID` with `GRANT SET_ANY_DEFINER`. Binary logging
is what makes that extra privilege necessary for `CREATE TRIGGER`; never grant `SUPER`.

## Engine

### Boot order (`apps/engine/src/main.ts`)

1. Parse every key of `.env.example` with zod; a missing or malformed key names itself and the
   process exits. Secrets are wrapped in `Secret` and print as `[redacted]` everywhere.
2. Connect as the app user, refuse to start on pending migrations or over-broad grants.
3. Create the event bus. `insertEvent()` is the only way anything emits: INSERT first, then
   publish to live SSE subscribers. The table is the truth; nothing in memory is authoritative.
4. Register tools. A tool without a valid `blastRadius` (or a `costly` tool without
   `estimateCostUsd`) throws and boot fails. The registry is snapshotted into `tools`.
5. Redis, the run queue, the halt controller (`syncOnBoot` makes Redis agree with the MySQL
   flag), the planner (`AnthropicPlanner` when `ANTHROPIC_API_KEY` is set, otherwise
   `UnconfiguredPlanner` in production and `DevPlanner` elsewhere), the executor, the worker.
6. HTTP: helmet, exact-origin CORS with credentials, 256 kB JSON limit, session middleware.

### Executor (`apps/engine/src/executor/executor.ts`)

Before every step, in code: global halt flag (read from MySQL each time), `RUN_MAX_STEPS`,
`RUN_MAX_TOKENS`, `RUN_MAX_WALL_CLOCK_MS` (active time only; time spent blocked does not count).
Exceeded ⇒ run `halted` with a `run.halted` event naming the ceiling.

Per tool call: the call is persisted in `tool_calls` with a UNIQUE `idempotency_key` before
anything runs. Then by blast radius:

- `reversible` executes.
- `costly` reserves the estimate atomically against the per-run and per-day caps first;
  exceeded ⇒ run `blocked`, `budget.exceeded` + `run.blocked` events. Never skipped.
- `irreversible` creates an `approvals` row and the run is `blocked` until the operator
  decides. No config, flag, or env var is consulted on that path.

A retrying worker that finds an existing row for the same key never re-executes it.

### Agent loop (`apps/engine/src/executor/anthropicPlanner.ts`)

The loop is written by hand on the Messages API; there is no agent framework and no tool runner.
It boots when `ANTHROPIC_API_KEY` is set. Without the key, production boots `UnconfiguredPlanner`
(every run fails at step 1 with a clear reason) and development boots the demo planner below.

Each step is one non-streaming request and one decision; the executor owns the loop and every
limit. The request is: a fixed preamble plus the agent's `systemPrompt` as the system blocks
(cache breakpoint on the last one, so the stable prefix is read from cache on every later step),
the registry's tool definitions (`inputSchema` as written, minus the `$schema` marker),
`tool_choice: auto` with parallel tool use disabled, and the run's conversation. Models that take
adaptive thinking (Claude 4.6 and later, matched by id prefix) get `thinking: { type: "adaptive" }`
and, when `AGENT_EFFORT` is set, `output_config.effort`; older ids get neither.

**The conversation is the log.** Nothing is kept in memory between steps. Every request is rebuilt
from the run's `tool_calls` rows: the assistant turn the model wrote (thinking and `tool_use`
blocks, stored verbatim in `tool_calls.model_turn`, migration `0004`) followed by a `tool_result`
built from the row's outcome: the output for `executed`, the error for `failed`, and an
`is_error` result saying the operator rejected the call for `rejected`. A run resumed after an
approval, a restart or a redeploy therefore sends exactly what the log says happened, and replayed
thinking stays valid (preserved thinking requires the producing turn unchanged).

The response maps to one of three decisions:

| Response                        | Decision                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| a `tool_use` block              | `tool_call` with `idempotencyKey = tool_use.id`, so a retrying worker finds the same row |
| text only (`end_turn`)          | `final`; `run.output` is `{ text }`, plus `truncated: true` if `max_tokens` cut it       |
| `stop_reason: refusal`          | `fail` with the refusal category; the run ends `failed`, no fallback model               |
| `model_context_window_exceeded` | `fail`; raise the task's scope or the ceilings, not the prompt                           |
| `tool_use` cut by `max_tokens`  | `fail`; a truncated tool input is never executed                                         |

There is deliberately no retry on refusals, no fallback model and no prompt-side nudging: the
operator sees `run.failed` with the reason and decides. Transport errors (rate limits, 5xx) are
retried by the SDK's own two retries and then fail the step like any other exception.

**Model and spend.** `agents.model` is sent as-is; the literal `default` resolves to `AGENT_MODEL`.
Every response's token usage is counted against `RUN_MAX_TOKENS`, and its price is recorded on
the run (`run.step` carries `costUsd` and `model`; `runs.cost_usd` accumulates it) using a built-in
USD-per-million-tokens table for current Claude ids, extended or overridden by
`AGENT_MODEL_PRICING`. Model spend is recorded, not reserved: the `costly` caps govern tool spend,
and the token ceiling bounds model spend per run. An unknown model id logs one warning and
records tokens without a price. The built-in table is a snapshot of list prices; verify it
against the pricing page when you adopt a new id, and note that the Haiku 5.5 long-prompt tier
above 100K input tokens is not modelled.

### Approvals

One queue, two kinds of decision (`approvals.kind`, migration `0003`):

- `irreversible` — a tool with that blast radius. Approve ⇒ the call runs once on resume.
- `budget` — a `costly` call that would pass `BUDGET_PER_RUN_USD`, `BUDGET_PER_DAY_USD` or
  `BUDGET_PER_DAY_CALLS`. The run pauses (`blocked`), never skips. Approve ⇒ that one call runs
  past the cap and its spend is recorded in the ledger, so the next over-cap call stops again.
  The cap itself never moves, and there is no flag that bypasses either path.

Reject ⇒ the call is `rejected` and the run continues with that fact in its history. In both
cases `run.blockedOn.id` is the approval that resolves the block.

`POST /approvals/:id/token` mints a 256-bit token for a pending approval (only the SHA-256 hash
is stored, TTL `APPROVAL_TOKEN_TTL_MS`). `POST /approvals/:id/decide { token, decision }`
consumes it in one guarded UPDATE: pending, hash matches, unused, unexpired. A decision on an
approval whose run was halted meanwhile is refused (`run_not_blocked`) and the queue hides it.

### Single-run halt

`POST /runs/:id/halt` moves one `queued`, `running` or `blocked` run to `halted` with reason
`operator` (event `run.halted` carries `by` and `detail`). A running worker notices at its next
step gate. Idempotent: halting a halted run returns the same row; a `done` or `failed` run is a 409. The global switch below is for everything at once.

### Global halt

`POST /halt` writes `system_flags.halt` in MySQL first, then pauses the queue, drains waiting
jobs, marks queued runs `halted`, and writes `system.halted`. Workers check the flag before every
step, so a halt survives a restart and a Redis flush. `POST /resume` clears it.
Runs that were halted stay halted (terminal); re-create them when ready.

### HTTP surface

| route                                                     | auth    | purpose                                                                                                   |
| --------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `GET /health`                                             | none    | MySQL + Redis reachable ⇒ `{ ok: true }`, else 503                                                        |
| `POST /auth/login`                                        | none    | argon2id check, 5 attempts / 15 min / IP                                                                  |
| `GET /auth/session`, `POST /auth/logout`                  | session | session status / clear cookie                                                                             |
| `GET /system`, `POST /halt`, `POST /resume`               | session | global halt                                                                                               |
| `GET /events?after=&limit=&runId=`                        | session | event rows after a cursor                                                                                 |
| `GET /events/tail?before=&limit=&runId=`                  | session | newest rows, ascending; the desk's first page                                                             |
| `GET /events/stream`                                      | session | SSE; `Last-Event-ID` (or `?lastEventId=`) replays                                                         |
| `GET /agents`                                             | session | roster: every agent with `AgentStats` (active run, runs and spend today)                                  |
| `POST /agents`, `GET /agents/:id`, `PATCH /agents/:id`    | session | create / detail with recent runs / update or retire (`enabled: false`); never deleted                     |
| `GET /runs?status=&agentId=&cursor=&limit=`               | session | newest first, keyset pages; `nextCursor` is null on the last page                                         |
| `POST /runs`, `GET /runs/:id`                             | session | enqueue (409 while halted or agent disabled) / run + agent + tool calls + approvals + budget              |
| `POST /runs/:id/halt`                                     | session | halt one run (idempotent)                                                                                 |
| `GET /approvals?status=&limit=`                           | session | queue items: `{ approval, toolCall, run, agent }`; pending ones whose run is no longer blocked are hidden |
| `POST /approvals/:id/token`, `POST /approvals/:id/decide` | session | single-use token, then the decision                                                                       |
| `GET /tools`, `GET /budgets/today`, `GET /limits`         | session | registry snapshot, today's spend vs caps, the enforced ceilings and caps (read-only)                      |

Every response body has a zod schema in `@marsad/shared` (`AgentRosterResponseSchema`,
`RunPageResponseSchema`, `RunDetailResponseSchema`, `ApprovalQueueResponseSchema`, ...); the
desk validates with them at the boundary. The run timeline is `GET /events/tail?runId=`.

The session is an httpOnly, `SameSite=Strict`, secure-in-production cookie signed with
`SESSION_SECRET` (stateless HMAC; rotating the secret logs everyone out). Errors are
`{ error: { code, message, issues? } }`. No response and no log line ever carries a credential.

## Desk

`apps/desk` is the control room: React 19 + Vite 8 + Tailwind v4, TypeScript strict with
`moduleResolution: bundler`, consuming `@marsad/shared` from source (a Vite alias plus matching
tsconfig `paths`, so the desk never waits on a `tsc -b` of the shared package). It is wired into
the root `dev`, `build`, `typecheck`, `lint` and `test` scripts.

What exists today:

- **Auth gate.** `GET /auth/session` on load; `POST /auth/login` with the password; every fetch
  with `credentials: 'include'`. A 401 from any later request, or the session's own expiry,
  drops back to the login form. The desk holds no secret and never reads the cookie.
- **Shell** per CLAUDE.md §5. Desktop: icon rail (56px, expands to 240px) and a 12-column panel
  grid; wide (1440+): plus a 380px inspector; tablet: icon-only rail and list-detail views;
  fold: single column under a top nav; phone: bottom tab bar with exactly Desk, Agents,
  Approvals, Log and Settings, plus a sticky "Halt all" (`POST /halt`) in the thumb zone with
  safe-area insets and 44px targets. "Halt all" is one tap from every layout; once halted the
  same control reads "Resume" (`POST /resume`).
- **Event log.** First page from `GET /events/tail`, then one `EventSource` on
  `/events/stream?lastEventId=<last id>` with `withCredentials`. Every frame goes through
  `EventSchema`; a frame that fails is dropped and counted, never rendered with a guessed
  shape. The list is virtualised (fixed-height rows), has a follow-tail toggle, and pages history
  backwards with `?before=`. The browser's own retries send `Last-Event-ID`; when it gives up the
  desk checks the session and reopens from the last id it holds, with exponential backoff.
- The global-halt flag on screen is a projection of `system.halted` / `system.resumed` rows;
  `GET /system` only fills the gap when no such row is inside the buffer's window.
- **Desk home.** Four tiles answer the four questions first: agents running, spent today against
  the day cap (a meter), decisions waiting, and what broke in the last 24 hours (failed runs and
  ceiling halts, each a link to the run). The system panel and the log sit under them.
- **Agents.** The roster (`GET /agents`) as a virtualised table from fold up and as cards on the
  phone; state is the only hue, every figure is tabular. Create and edit agents (the tool picker
  shows each tool's blast radius as a stripe and a word), retire with `enabled: false`, start a
  run from the detail. Tablet and desktop pair list and detail, fold stacks them, wide puts the
  detail in the inspector, phone opens a full-screen sheet.
- **Approvals.** One queue for irreversible calls and budget holds, oldest first, with the risk
  stripe per kind. Deciding mints a single-use token and spends it (`decideApproval`); approving
  an irreversible call takes two clicks, "allow once" on a budget hold takes one. Phone rows
  swipe: toward the end uncovers Reject, toward the start uncovers Approve, and the uncovered
  button acts. The pending count is the badge on the rail and tab bar.
- **Run detail.** Opens from anywhere (`?run=<id>`): state chip, usage against every ceiling
  and the per-run cap as meters (`GET /limits`), the decision it is waiting on with its actions,
  the tool calls, the timeline from `GET /events/tail?runId=`, and a single-run halt. Phone and
  fold use a full-screen sheet, tablet and desktop a dialog, wide the inspector.
- **Command palette** (⌘K / Ctrl+K, tablet and up): destinations, halt/resume, agents, pending
  decisions and recent runs, filtered as you type.
- Every read model is a `useLiveQuery`: fetched from the engine, re-fetched when a relevant event
  arrives on the stream. There is no second copy of the state machine in the browser.
- Settings add a writing-direction switch; `html[dir="rtl"]` moves the desk to the Arabic face.

Theme: `marsad-theme.css` is imported right after `@import "tailwindcss"`; the desk's own layer
(`desk.css`) uses its tokens only — no hex anywhere. All numbers render in the tabular mono
face. The 600ms flash on a changed value is the only non-user-triggered motion, and
`prefers-reduced-motion` collapses it.

### Desk configuration

One build-time variable, `VITE_API_BASE` (see `apps/desk/.env.example`): where the engine is.
Defaults to `http://localhost:8080` in `pnpm dev` and to `/api` in a production build.

Two constraints follow from the session cookie being `SameSite=Strict`:

- In development the desk and the engine must be _same-site_: open the desk at
  `http://localhost:5173` and point it at `http://localhost:8080`, never at `127.0.0.1` (a
  different site — the cookie would not be sent). `CORS_ORIGINS` in `.env` must list the exact
  Vite origin; Vite is pinned to port 5173 with `strictPort` so that origin cannot drift.
- In production the desk container's Nginx (`apps/desk/nginx/default.conf.template`) serves
  the bundle and proxies `/api/` to the engine on the same origin, stripping the prefix, with
  buffering off for `/api/events/stream` and `index.html` for SPA routes. See "Deployment".

Not in the desk yet: the six-series chart (desktop only by design) and the agent loop itself,
which lives in the engine (see "Extension points").

To render every screen at 375, 600, 768, 1024 and 1440px in light, dark and RTL against a
running engine (`apps/desk/e2e/screenshots.mjs`, Chromium via Playwright, not part of
`pnpm test`):

```sh
OPERATOR_PASSWORD='...' PLAYWRIGHT=/path/to/node_modules/playwright \
  node apps/desk/e2e/screenshots.mjs apps/desk/e2e/screenshots
```

## Deployment

Target: one VPS that already runs Nginx for other sites. MARSAD runs as four containers from
`docker-compose.prod.yml` (MySQL 8, Redis 7, engine, desk). The desk container is Nginx serving
the built bundle and proxying `/api/` to the engine; it is the only published port, bound to
`127.0.0.1:8088`. The host Nginx terminates TLS and proxies to it
(`deploy/nginx/marsad.vps.conf.example`). Nothing else is reachable from outside.

### Images

Both images are multi-stage, run as non-root, and carry no secrets or environment-specific
values. CI (`.github/workflows/ci.yml`) builds and publishes them to GHCR on every push to
`main` and on `v*` tags: `ghcr.io/alsalahee1/marsad-engine` and
`ghcr.io/alsalahee1/marsad-desk`, tagged `latest`, `sha-<short>` and the version.

- `apps/engine/Dockerfile` — install → build → prod-deps → runtime (`node`, production
  dependencies only, `/health` healthcheck). Also the `migrate` service's image.
- `apps/desk/Dockerfile` — install → build → `nginxinc/nginx-unprivileged` (uid 101, port 8080).
  `apps/desk/nginx/default.conf.template` is rendered at container start with `ENGINE_UPSTREAM`
  (default `engine:8080`) resolved per request, so an engine restart never strands Nginx. It
  strips the `/api/` prefix, turns buffering off for `/api/events/stream` with a one-hour read
  timeout (the engine heartbeats), serves hashed assets as immutable and the shell as
  `no-cache`, falls back to `index.html` for SPA routes, answers `/healthz` itself, and sets a
  same-origin `Content-Security-Policy` (`script-src 'self'`, `frame-ancestors 'none'`).

### First deploy

Prerequisites on the VPS: Docker Engine with the compose plugin, Nginx, certbot, a DNS name
pointing at the host. If the repository is private, `docker login ghcr.io` with a token that has
`read:packages`, or build on the VPS instead of pulling.

```sh
git clone https://github.com/alsalahee1/marsad.git && cd marsad
cp .env.example .env
```

Fill in `.env`. Everything under the engine section is read by the engine; the block under
`# --- Deployment:` is read by compose only. In particular:

| key                                        | value                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `NODE_ENV`                                 | `production`                                                         |
| `CORS_ORIGINS`                             | the public origin, e.g. `https://marsad.example.com`                 |
| `MYSQL_PASSWORD`, `MYSQL_MIGRATE_PASSWORD` | new random passwords; the first boot creates both accounts with them |
| `MYSQL_ROOT_PASSWORD`                      | a third one, for the container's root                                |
| `SESSION_SECRET`                           | 32+ random characters                                                |
| `OPERATOR_PASSWORD_HASH`                   | the line printed by `pnpm --filter @marsad/engine hash-password`     |
| `ANTHROPIC_API_KEY`, `AGENT_MODEL`         | the key; the model used when an agent says `default`                 |

Wrap any value that contains `$` in single quotes (the hash always does); compose expands
`$NAME` inside `.env` otherwise and the hash arrives mangled. `MYSQL_HOST`, `REDIS_URL`, `PORT`
and `TRUST_PROXY` are overridden by the compose file for the containers (`mysql`, `redis`,
`8080`, `uniquelocal`) — leave the engine defaults for local use.

```sh
docker compose -f docker-compose.prod.yml pull      # or: build
docker compose -f docker-compose.prod.yml up -d     # mysql, redis → migrate (one-shot) → engine → desk
docker compose -f docker-compose.prod.yml ps        # all healthy, migrate exited 0
curl -s http://127.0.0.1:8088/api/health            # {"ok":true}
```

The first MySQL start runs `docker/mysql/init-prod/01-users.sh`, which creates the two accounts
with the passwords from `.env` (nothing is written to disk; the development compose file uses
the fixed dev credentials from `docker/mysql/init/01-users.sql` instead). `migrate` applies the
schema, the append-only triggers and the app user's table grants, then exits; the engine waits
for it and refuses to start on pending migrations or over-broad grants.

Then the host Nginx:

```sh
sudo cp deploy/nginx/marsad.vps.conf.example /etc/nginx/sites-available/marsad
sudo sed -i 's/marsad.example.com/marsad.YOURDOMAIN/g' /etc/nginx/sites-available/marsad
sudo ln -s /etc/nginx/sites-available/marsad /etc/nginx/sites-enabled/marsad
sudo certbot --nginx -d marsad.YOURDOMAIN
sudo nginx -t && sudo systemctl reload nginx
```

The example proxies everything to `127.0.0.1:8088`, with a separate `location` for the event
stream (`proxy_buffering off`, long read timeout) and HSTS. For a single operator, uncomment
the `allow` / `deny all` lines with your addresses: the login form then never faces the
internet, and the engine's 5-per-15-minutes login limit is the second line, not the first.

### Verifying a deployment

`apps/desk/e2e/smoke.mjs` drives the production bundle through the real proxy chain in a
headless Chromium: one API login, then it loads the desk and fails on any console error, CSP
violation, failed request, or a live stream that does not connect. Run it from any machine with
Playwright's Chromium:

```sh
BASE_URL=https://marsad.example.com OPERATOR_PASSWORD='...' \
  PLAYWRIGHT=/path/to/node_modules/playwright node apps/desk/e2e/smoke.mjs
```

### Updating

```sh
git pull
docker compose -f docker-compose.prod.yml pull      # or: build
docker compose -f docker-compose.prod.yml up -d     # re-runs migrate, recreates what changed
```

Pin a version instead of `latest` with `MARSAD_IMAGE_TAG=sha-<short>` (or `v1.2.3`) in `.env`;
rolling back is setting it to the previous tag and running `up -d` again. Migrations are
forward-only: do not roll back past a release that added one.

### Operating

```sh
docker compose -f docker-compose.prod.yml logs -f engine            # JSON lines, pino
docker compose -f docker-compose.prod.yml exec -T mysql \
  mysqldump --single-transaction --triggers -uroot -p"$MYSQL_ROOT_PASSWORD" marsad \
  | gzip > marsad-$(date +%F).sql.gz                                # backup (keep off the host too)
docker compose -f docker-compose.prod.yml down                      # stop; volumes stay
```

Restore by piping a dump into `mysql` the same way, with the stack stopped except `mysql`. The
events table is append-only, so the database only grows; size it and prune by archiving whole
periods, never by deleting rows in place. Redis holds only the queue and the halt flag mirror;
losing it loses queued (not running) runs, which stay `queued` in MySQL and can be re-created.

### Not done from here

This repository can be built, tested and its images published without a VPS; the deployment
itself has to be run on the host. What is not automated: creating `.env` on the VPS, the DNS
record, the certbot run, the `ghcr.io` login for a private package, and off-host backups.

## Development planner and demo tools

Outside production (`NODE_ENV` other than `production`) the engine boots with `DevPlanner`
(`apps/engine/src/executor/devPlanner.ts`) and registers three demo tools: `demo.pay` (costly,
spends what it is told), `demo.wipe` (irreversible, always needs approval) and `demo.fail`
(always throws). A run's task text selects a fixed script, so every run state can be produced
on a laptop without a model: `demo:happy`, `demo:approval`, `demo:budget`, `demo:ceiling`,
`demo:failure`, or `plan:[{"tool":"echo","input":{"message":"hi"}}, ...]`; any other text is
echoed once. The executor enforces every limit around these exactly as it does for a real
planner. A production build never registers the demo tools and refuses to run anything until a
real planner is configured.

## Extension points

- **Agent loop**: `Planner` (`apps/engine/src/executor/planner.ts`) is the seam. The shipped
  `AnthropicPlanner` makes one decision per step from the log; another provider or a different
  prompting strategy is a second implementation chosen in `main.ts`. The planner only decides;
  the executor enforces, so a new planner inherits every limit, approval and budget unchanged.
- **Tools**: `defineTool({...})` in `apps/engine/src/tools/builtin/` and register it in
  `registerBuiltinTools`. Declare `blastRadius`; costly tools declare `estimateCostUsd`.
- **Desk**: consume `@marsad/shared` (`EventSchema` narrows every SSE frame; request schemas
  double as form validation) and the routes above. See the last section of the session report
  for the handshake.
