-- MARSAD schema, version 1.
-- Conventions: UTC everywhere (DATETIME(3), values written by the engine), app-generated UUIDv4
-- ids in CHAR(36), JSON columns for structured payloads. events.id is the only auto-increment:
-- it is the SSE replay cursor and must be monotonic.
-- One statement per trigger body; the runner splits on top-level semicolons (no DELIMITER).

CREATE TABLE IF NOT EXISTS agents (
  id            CHAR(36)     NOT NULL,
  name          VARCHAR(120) NOT NULL,
  model         VARCHAR(120) NOT NULL,
  system_prompt MEDIUMTEXT   NOT NULL,
  tools         JSON         NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL,
  updated_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agents_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS runs (
  id              CHAR(36)        NOT NULL,
  agent_id        CHAR(36)        NOT NULL,
  status          ENUM('queued','running','blocked','done','failed','halted') NOT NULL DEFAULT 'queued',
  task            TEXT            NOT NULL,
  step_count      INT UNSIGNED    NOT NULL DEFAULT 0,
  tokens_used     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cost_usd        DECIMAL(12,6)   NOT NULL DEFAULT 0,
  active_ms       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at      DATETIME(3)     NULL,
  status_reason   VARCHAR(255)    NULL,
  blocked_on_kind ENUM('approval','budget') NULL,
  blocked_on_id   VARCHAR(64)     NULL,
  output          JSON            NULL,
  created_at      DATETIME(3)     NOT NULL,
  started_at      DATETIME(3)     NULL,
  finished_at     DATETIME(3)     NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_runs_status_created (status, created_at),
  KEY idx_runs_agent_created (agent_id, created_at),
  CONSTRAINT fk_runs_agent FOREIGN KEY (agent_id) REFERENCES agents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only. Enforced by grants (app user: SELECT, INSERT) and by the triggers in 0002.
CREATE TABLE IF NOT EXISTS events (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type    VARCHAR(64)     NOT NULL,
  run_id  CHAR(36)        NULL,
  payload JSON            NOT NULL,
  at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_events_run (run_id, id),
  KEY idx_events_type (type, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tool_calls (
  id                 CHAR(36)      NOT NULL,
  run_id             CHAR(36)      NOT NULL,
  step               INT UNSIGNED  NOT NULL,
  tool               VARCHAR(120)  NOT NULL,
  blast_radius       ENUM('reversible','costly','irreversible') NOT NULL,
  idempotency_key    VARCHAR(128)  NOT NULL,
  status             ENUM('pending','awaiting_approval','approved','rejected','blocked','executing','executed','failed') NOT NULL DEFAULT 'pending',
  input              JSON          NOT NULL,
  output             JSON          NULL,
  estimated_cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0,
  actual_cost_usd    DECIMAL(12,6) NULL,
  error              TEXT          NULL,
  created_at         DATETIME(3)   NOT NULL,
  started_at         DATETIME(3)   NULL,
  finished_at        DATETIME(3)   NULL,
  updated_at         DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tool_calls_idempotency (idempotency_key),
  KEY idx_tool_calls_run_step (run_id, step),
  KEY idx_tool_calls_run_status (run_id, status),
  CONSTRAINT fk_tool_calls_run FOREIGN KEY (run_id) REFERENCES runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One approval per tool call. The raw token is never stored: token_hash is SHA-256 hex.
CREATE TABLE IF NOT EXISTS approvals (
  id               CHAR(36)    NOT NULL,
  run_id           CHAR(36)    NOT NULL,
  tool_call_id     CHAR(36)    NOT NULL,
  status           ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  token_hash       CHAR(64)    NULL,
  token_expires_at DATETIME(3) NULL,
  token_used_at    DATETIME(3) NULL,
  decided_at       DATETIME(3) NULL,
  decided_by       VARCHAR(64) NULL,
  created_at       DATETIME(3) NOT NULL,
  updated_at       DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_approvals_tool_call (tool_call_id),
  UNIQUE KEY uq_approvals_token_hash (token_hash),
  KEY idx_approvals_status_created (status, created_at),
  CONSTRAINT fk_approvals_run FOREIGN KEY (run_id) REFERENCES runs (id),
  CONSTRAINT fk_approvals_tool_call FOREIGN KEY (tool_call_id) REFERENCES tool_calls (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS budgets (
  scope      ENUM('run','day') NOT NULL,
  scope_key  VARCHAR(64)       NOT NULL,
  spent_usd  DECIMAL(12,6)     NOT NULL DEFAULT 0,
  call_count INT UNSIGNED      NOT NULL DEFAULT 0,
  cap_usd    DECIMAL(12,6)     NOT NULL,
  cap_calls  INT UNSIGNED      NULL,
  created_at DATETIME(3)       NOT NULL,
  updated_at DATETIME(3)       NOT NULL,
  PRIMARY KEY (scope, scope_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Registry snapshot, rewritten at every boot. The blast radius column is NOT NULL on purpose.
CREATE TABLE IF NOT EXISTS tools (
  name           VARCHAR(120) NOT NULL,
  description    TEXT         NOT NULL,
  blast_radius   ENUM('reversible','costly','irreversible') NOT NULL,
  input_schema   JSON         NOT NULL,
  version        VARCHAR(32)  NOT NULL,
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  snapshotted_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Persisted switches. The global halt lives here (row `halt`), not only in Redis.
CREATE TABLE IF NOT EXISTS system_flags (
  name       VARCHAR(64) NOT NULL,
  value      JSON        NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
