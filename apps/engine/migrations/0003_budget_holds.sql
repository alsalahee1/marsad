-- Budget holds. A costly call that would pass a spend cap now waits for the operator exactly
-- like an irreversible call does; `kind` says which decision an approval row carries. Every row
-- written before this migration was for an irreversible tool. Approving a budget hold allows
-- that one call; the cap itself never moves, and there is still no flag that bypasses either path.

ALTER TABLE approvals
  ADD COLUMN kind ENUM('irreversible','budget') NOT NULL DEFAULT 'irreversible' AFTER tool_call_id;

-- The roster groups runs by agent and state on every refresh.
ALTER TABLE runs ADD KEY idx_runs_agent_status (agent_id, status);
