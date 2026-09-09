import type {
  Agent,
  Approval,
  ApprovalDecision,
  BlastRadius,
  BlockReason,
  Budget,
  BudgetScope,
  Event,
  EventInput,
  JsonValue,
  Run,
  RunStatus,
  ToolCall,
  ToolCallStatus,
  ToolDefinition,
} from '@marsad/shared';

/**
 * Persistence ports. The MySQL implementation is the real one; an in-memory implementation
 * lives under test/ so executor behaviour can be tested without a database, and the same
 * behavioural suites run against MySQL when MYSQL_HOST is set.
 *
 * Every guarded write (`transition`, `consumeToken`, `reserve`) is atomic: it returns whether
 * the precondition held. Callers must branch on that, never re-read and hope.
 */

export interface EventStore {
  /** INSERT one row and return it with its assigned id and timestamp. The only write path. */
  insert(input: EventInput, at: Date): Promise<Event>;
  /** Rows with id > afterId, ascending, at most `limit`. */
  listAfter(afterId: string | null, limit: number, runId?: string): Promise<Event[]>;
}

export interface NewRun {
  id: string;
  agentId: string;
  task: string;
}

export interface RunPatch {
  statusReason?: string | null;
  blockedOn?: { kind: BlockReason; id: string | null } | null;
  output?: JsonValue | null;
}

export interface RunStore {
  create(input: NewRun, now: Date): Promise<Run>;
  get(id: string): Promise<Run | null>;
  list(filter: { status?: RunStatus; limit: number }): Promise<Run[]>;
  /**
   * Move a run from one of `from` to `to`. Entering `running` stamps claimed_at (and started_at
   * on first claim); leaving `running` folds the elapsed time into active_ms.
   */
  transition(
    id: string,
    from: readonly RunStatus[],
    to: RunStatus,
    now: Date,
    patch?: RunPatch,
  ): Promise<boolean>;
  /** Move every run in `from` to `to` (used by the global halt). Returns the affected ids. */
  transitionAll(
    from: readonly RunStatus[],
    to: RunStatus,
    now: Date,
    patch?: RunPatch,
  ): Promise<string[]>;
  /** step_count += 1, tokens_used += tokens. */
  recordStep(id: string, tokens: number, now: Date): Promise<void>;
  /** cost_usd += usd. */
  addCost(id: string, usd: number, now: Date): Promise<void>;
  /** Milliseconds spent running so far, including the current claim if any. */
  activeMs(run: Run, claimedAt: Date | null, now: Date): number;
  getClaimedAt(id: string): Promise<Date | null>;
}

export interface NewToolCall {
  id: string;
  runId: string;
  step: number;
  tool: string;
  blastRadius: BlastRadius;
  idempotencyKey: string;
  input: JsonValue;
  estimatedCostUsd: number;
  status: ToolCallStatus;
}

export interface ToolCallPatch {
  output?: JsonValue | null;
  actualCostUsd?: number | null;
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date;
}

export interface ToolCallStore {
  /** Throws IdempotencyConflictError when the key exists. */
  insert(input: NewToolCall, now: Date): Promise<ToolCall>;
  get(id: string): Promise<ToolCall | null>;
  findByIdempotencyKey(key: string): Promise<ToolCall | null>;
  listByRun(runId: string): Promise<ToolCall[]>;
  findByRunAndStatus(runId: string, status: ToolCallStatus): Promise<ToolCall | null>;
  transition(
    id: string,
    from: readonly ToolCallStatus[],
    to: ToolCallStatus,
    now: Date,
    patch?: ToolCallPatch,
  ): Promise<boolean>;
}

export interface ApprovalStore {
  create(input: { id: string; runId: string; toolCallId: string }, now: Date): Promise<Approval>;
  get(id: string): Promise<Approval | null>;
  list(filter: { status?: Approval['status']; limit: number }): Promise<Approval[]>;
  /** Store a fresh token hash on a pending approval, replacing any previous one. */
  setToken(id: string, tokenHash: string, expiresAt: Date, now: Date): Promise<boolean>;
  /**
   * Single-use consumption: succeeds only if the approval is pending, the hash matches, the
   * token is unused and unexpired. Marks the approval decided in the same statement.
   */
  consumeToken(
    id: string,
    tokenHash: string,
    decision: ApprovalDecision,
    decidedBy: string,
    now: Date,
  ): Promise<boolean>;
}

export interface BudgetCaps {
  capUsd: number;
  capCalls: number | null;
}

export type ReserveResult = { ok: true; budget: Budget } | { ok: false; budget: Budget };

export interface BudgetStore {
  /**
   * Atomically add `amountUsd` and one call to the scope if both stay within the caps.
   * Returns the budget row either way, so the caller can report exactly what was exceeded.
   */
  reserve(
    scope: BudgetScope,
    key: string,
    amountUsd: number,
    caps: BudgetCaps,
    now: Date,
  ): Promise<ReserveResult>;
  /** Replace a reservation with the actual spend (delta may be negative). Never touches call_count. */
  adjust(scope: BudgetScope, key: string, deltaUsd: number, now: Date): Promise<void>;
  get(scope: BudgetScope, key: string): Promise<Budget | null>;
}

export interface ToolSnapshotStore {
  /** Upsert every definition and mark absent tools inactive. */
  snapshot(tools: readonly ToolDefinition[], now: Date): Promise<void>;
  list(): Promise<(ToolDefinition & { active: boolean })[]>;
}

export interface NewAgent {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
}

export interface AgentStore {
  create(input: NewAgent, now: Date): Promise<Agent>;
  get(id: string): Promise<Agent | null>;
  list(): Promise<Agent[]>;
}

export interface HaltState {
  halted: boolean;
  reason: string | null;
  at: string | null;
  by: string | null;
}

export interface FlagStore {
  getHalt(): Promise<HaltState>;
  setHalt(state: HaltState, now: Date): Promise<void>;
}

export interface Store {
  events: EventStore;
  runs: RunStore;
  toolCalls: ToolCallStore;
  approvals: ApprovalStore;
  budgets: BudgetStore;
  tools: ToolSnapshotStore;
  agents: AgentStore;
  flags: FlagStore;
  ping(): Promise<void>;
  close(): Promise<void>;
}
