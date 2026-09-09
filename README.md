# MARSAD

Agent operations desk: a single-operator control room for autonomous agents doing real work on
real systems. Read `CLAUDE.md` first — its security invariants are the spec, and this codebase is
their enforcement.

## Layout

```
packages/shared   domain contracts (zod schemas, RunStatus, BlastRadius, Event union, SSE envelope)
apps/engine       Express 5 API, MySQL event log, BullMQ worker, tool registry + executor
apps/desk         React + Vite desk (next session; only the theme exists today)
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
pnpm dev                           # engine on http://127.0.0.1:8080 (+ shared in watch mode)
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
