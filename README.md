# MARSAD

Agent operations desk: a single-operator control room for autonomous agents doing real work on
real systems. Read `CLAUDE.md` first — its security invariants are the spec, and this codebase is
their enforcement.

## Layout

```
packages/shared   domain contracts (zod schemas, RunStatus, BlastRadius, Event union, SSE envelope)
apps/engine       Express 5 API, MySQL event log, BullMQ worker, tool registry + executor
apps/desk         React + Vite + Tailwind v4 desk: auth gate, shell, live event log
docker/           MySQL init SQL (both DB accounts)
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
   flag), the executor, the worker.
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

### Approvals

`POST /approvals/:id/token` mints a 256-bit token for a pending approval (only the SHA-256 hash
is stored, TTL `APPROVAL_TOKEN_TTL_MS`). `POST /approvals/:id/decide { token, decision }`
consumes it in one guarded UPDATE: pending, hash matches, unused, unexpired. Approve ⇒ the tool
call becomes `approved`, the run re-queues and the worker executes it exactly once. Reject ⇒
the call is `rejected` and the run continues with that fact in its history.

### Global halt

`POST /halt` writes `system_flags.halt` in MySQL first, then pauses the queue, drains waiting
jobs, marks queued runs `halted`, and writes `system.halted`. Workers check the flag before every
step, so a halt survives a restart and a Redis flush. `POST /resume` clears it.
Runs that were halted stay halted (terminal); re-create them when ready.

### HTTP surface

| route                                                                       | auth    | purpose                                            |
| --------------------------------------------------------------------------- | ------- | -------------------------------------------------- |
| `GET /health`                                                               | none    | MySQL + Redis reachable ⇒ `{ ok: true }`, else 503 |
| `POST /auth/login`                                                          | none    | argon2id check, 5 attempts / 15 min / IP           |
| `GET /auth/session`, `POST /auth/logout`                                    | session | session status / clear cookie                      |
| `GET /system`, `POST /halt`, `POST /resume`                                 | session | global halt                                        |
| `GET /events?after=&limit=&runId=`                                          | session | event rows after a cursor                          |
| `GET /events/tail?before=&limit=&runId=`                                    | session | newest rows, ascending; the desk's first page      |
| `GET /events/stream`                                                        | session | SSE; `Last-Event-ID` (or `?lastEventId=`) replays  |
| `GET/POST /agents`                                                          | session | agents                                             |
| `GET/POST /runs`, `GET /runs/:id`                                           | session | runs; POST enqueues                                |
| `GET /approvals`, `POST /approvals/:id/token`, `POST /approvals/:id/decide` | session | approval queue                                     |
| `GET /tools`, `GET /budgets/today`                                          | session | registry snapshot, today's spend vs caps           |

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
- In production serve the built `apps/desk/dist` from Nginx and proxy `/api/` to the engine on
  the same origin, stripping the prefix (`location /api/ { proxy_pass http://127.0.0.1:8080/; }`
  with `proxy_buffering off` for `/api/events/stream`), and `try_files $uri /index.html` for the
  SPA routes. Set the usual headers there (`Content-Security-Policy`, `frame-ancestors 'none'`).

Not in this slice: the agent roster, the approval queue, budgets, the command palette, and the
agent loop itself. Those views are routed stubs; everything they need is already in the stream.

## Docker

`apps/engine/Dockerfile` is multi-stage (deps → build → prod-deps → runtime), runs as `node`,
ships production dependencies only, and exposes a `/health` healthcheck. `docker-compose.yml`
brings up MySQL 8.0 (with the init SQL), Redis 7, the engine, and a one-shot `migrate` service
(`docker compose run --rm migrate`).

## Extension points

- **Agent loop**: implement `Planner` (`apps/engine/src/executor/planner.ts`) and pass it to
  the `Executor` in `main.ts` instead of `UnconfiguredPlanner`. The planner only decides; the
  executor enforces. `ANTHROPIC_API_KEY` / `AGENT_MODEL` are parsed and available on
  `config.model`.
- **Tools**: `defineTool({...})` in `apps/engine/src/tools/builtin/` and register it in
  `registerBuiltinTools`. Declare `blastRadius`; costly tools declare `estimateCostUsd`.
- **Desk**: consume `@marsad/shared` (`EventSchema` narrows every SSE frame; request schemas
  double as form validation) and the routes above. See the last section of the session report
  for the handshake.
