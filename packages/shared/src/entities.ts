import { z } from 'zod';
import {
  ApprovalStatusSchema,
  BlastRadiusSchema,
  BlockReasonSchema,
  BudgetScopeSchema,
  RunStatusSchema,
  ToolCallStatusSchema,
} from './enums.js';
import { JsonValueSchema } from './json.js';

const Id = z.uuid();
const Timestamp = z.iso.datetime();
const Usd = z.number().nonnegative();
const Count = z.int().nonnegative();

/** Tool names are stable identifiers: lowercase, dot/underscore separated. */
export const ToolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'tool name: lowercase segments joined by dots');

export const AgentSchema = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  /** Instructions for the model. Never a security boundary — every limit lives in the executor. */
  systemPrompt: z.string(),
  /** Names of tools this agent may call. Must exist in the registry. */
  tools: z.array(ToolNameSchema),
  enabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Agent = z.infer<typeof AgentSchema>;

export const RunBlockedOnSchema = z.object({
  kind: BlockReasonSchema,
  /** Approval id for `approval`; the budget key (run id or YYYY-MM-DD) for `budget`. */
  id: z.string().nullable(),
});
export type RunBlockedOn = z.infer<typeof RunBlockedOnSchema>;

export const RunSchema = z.object({
  id: Id,
  agentId: Id,
  status: RunStatusSchema,
  task: z.string().min(1),
  stepCount: Count,
  tokensUsed: Count,
  costUsd: Usd,
  /** Wall-clock milliseconds spent in `running`; time spent blocked does not count. */
  activeMs: Count,
  statusReason: z.string().nullable(),
  blockedOn: RunBlockedOnSchema.nullable(),
  output: JsonValueSchema.nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type Run = z.infer<typeof RunSchema>;

/** Idempotency keys: opaque, 8–128 chars, safe in URLs and headers. */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

export const ToolCallSchema = z.object({
  id: Id,
  runId: Id,
  step: Count,
  tool: ToolNameSchema,
  blastRadius: BlastRadiusSchema,
  idempotencyKey: IdempotencyKeySchema,
  status: ToolCallStatusSchema,
  input: JsonValueSchema,
  output: JsonValueSchema.nullable(),
  estimatedCostUsd: Usd,
  actualCostUsd: Usd.nullable(),
  error: z.string().nullable(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** The token itself is never part of this shape. Only its hash is stored, and only server-side. */
export const ApprovalSchema = z.object({
  id: Id,
  runId: Id,
  toolCallId: Id,
  status: ApprovalStatusSchema,
  tokenExpiresAt: Timestamp.nullable(),
  decidedAt: Timestamp.nullable(),
  decidedBy: z.string().nullable(),
  createdAt: Timestamp,
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const BudgetSchema = z.object({
  scope: BudgetScopeSchema,
  /** Run id for `run`; UTC date `YYYY-MM-DD` for `day`. */
  key: z.string().min(1).max(64),
  spentUsd: Usd,
  callCount: Count,
  capUsd: Usd,
  capCalls: Count.nullable(),
  updatedAt: Timestamp,
});
export type Budget = z.infer<typeof BudgetSchema>;

/** Registry snapshot row. `inputSchema` is JSON Schema derived from the tool's zod input. */
export const ToolDefinitionSchema = z.object({
  name: ToolNameSchema,
  description: z.string().min(1),
  blastRadius: BlastRadiusSchema,
  inputSchema: JsonValueSchema,
  version: z.string().min(1).max(32),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
