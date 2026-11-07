import { z } from 'zod';
import { ApprovalDecisionSchema, ApprovalStatusSchema, RunStatusSchema } from './enums.js';
import {
  AgentSchema,
  AgentStatsSchema,
  ApprovalSchema,
  BudgetSchema,
  RunSchema,
  ToolCallSchema,
  ToolDefinitionSchema,
  ToolNameSchema,
} from './entities.js';

/** Request bodies. The engine validates with these; the desk can reuse them for forms. */
export const LoginRequestSchema = z.object({
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreateAgentRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  systemPrompt: z.string().max(200_000).default(''),
  tools: z.array(ToolNameSchema).max(100).default([]),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** `PATCH /agents/:id`. Agents are never deleted; `enabled: false` retires one. */
export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(120),
    systemPrompt: z.string().max(200_000),
    tools: z.array(ToolNameSchema).max(100),
    enabled: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, 'at least one field must be provided');
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const CreateRunRequestSchema = z.object({
  agentId: z.uuid(),
  task: z.string().trim().min(1).max(20_000),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const DecideApprovalRequestSchema = z.object({
  token: z.string().min(16).max(256),
  decision: ApprovalDecisionSchema,
});
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>;

export const HaltRequestSchema = z.object({
  reason: z.string().trim().max(255).default('operator'),
});
export type HaltRequest = z.infer<typeof HaltRequestSchema>;

/** `POST /runs/:id/halt`: one run, not the system. */
export const HaltRunRequestSchema = z.object({
  reason: z.string().trim().max(255).default('operator'),
});
export type HaltRunRequest = z.infer<typeof HaltRunRequestSchema>;

/**
 * Run pages are keyed on (created_at, id), newest first. The cursor is the last row's
 * `createdAt` and `id` joined by `_`: neither an ISO timestamp nor a UUID contains one.
 */
export const RUN_CURSOR_SEPARATOR = '_';

export interface RunCursor {
  createdAt: string;
  id: string;
}

export function encodeRunCursor(cursor: RunCursor): string {
  return `${cursor.createdAt}${RUN_CURSOR_SEPARATOR}${cursor.id}`;
}

const RunCursorPartsSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

export function decodeRunCursor(raw: string): RunCursor | null {
  const at = raw.lastIndexOf(RUN_CURSOR_SEPARATOR);
  if (at <= 0) return null;
  const parsed = RunCursorPartsSchema.safeParse({
    createdAt: raw.slice(0, at),
    id: raw.slice(at + 1),
  });
  return parsed.success ? parsed.data : null;
}

export const ListRunsQuerySchema = z.object({
  status: RunStatusSchema.optional(),
  agentId: z.uuid().optional(),
  /** From a previous page's `nextCursor`. */
  cursor: z
    .string()
    .max(80)
    .refine((raw) => decodeRunCursor(raw) !== null, 'malformed cursor')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ListApprovalsQuerySchema = z.object({
  status: ApprovalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ListEventsQuerySchema = z.object({
  after: z.string().regex(/^\d+$/).optional(),
  runId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** `GET /events/tail`: the newest rows, paged backwards with `before`. */
export const TailEventsQuerySchema = z.object({
  before: z.string().regex(/^\d+$/).optional(),
  runId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** Every error response has this shape. `issues` is present only for validation failures. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SystemStateSchema = z.object({
  halted: z.boolean(),
  haltedAt: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});
export type SystemState = z.infer<typeof SystemStateSchema>;

// --- Response bodies. The desk validates every one of these at the boundary. ---

/** `GET /agents`: one row per agent with its live figures. */
export const AgentRosterRowSchema = z.object({ agent: AgentSchema, stats: AgentStatsSchema });
export type AgentRosterRow = z.infer<typeof AgentRosterRowSchema>;
export const AgentRosterResponseSchema = z.object({ agents: z.array(AgentRosterRowSchema) });

/** `GET /agents/:id`, `POST /agents`, `PATCH /agents/:id`. */
export const AgentDetailResponseSchema = z.object({
  agent: AgentSchema,
  stats: AgentStatsSchema,
  recentRuns: z.array(RunSchema),
});
export type AgentDetailResponse = z.infer<typeof AgentDetailResponseSchema>;

/** `GET /runs`: newest first; `nextCursor` is null on the last page. */
export const RunPageResponseSchema = z.object({
  runs: z.array(RunSchema),
  nextCursor: z.string().nullable(),
});
export type RunPageResponse = z.infer<typeof RunPageResponseSchema>;

/** `GET /runs/:id`, `POST /runs`, `POST /runs/:id/halt`. */
export const RunDetailResponseSchema = z.object({
  run: RunSchema,
  agent: AgentSchema.nullable(),
  toolCalls: z.array(ToolCallSchema),
  approvals: z.array(ApprovalSchema),
  /** The run-scope budget row; null until the first costly call. */
  budget: BudgetSchema.nullable(),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

/** One row of the approval queue, with everything the operator needs to decide. */
export const ApprovalQueueItemSchema = z.object({
  approval: ApprovalSchema,
  toolCall: ToolCallSchema,
  run: RunSchema,
  agent: AgentSchema.nullable(),
});
export type ApprovalQueueItem = z.infer<typeof ApprovalQueueItemSchema>;
export const ApprovalQueueResponseSchema = z.object({
  approvals: z.array(ApprovalQueueItemSchema),
});

export const IssueTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.iso.datetime(),
});

export const DecideApprovalResponseSchema = z.object({
  approval: ApprovalSchema,
  resumed: z.boolean(),
});

export const BudgetTodayResponseSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  caps: z.object({
    usd: z.number().nonnegative(),
    calls: z.int().nonnegative(),
    perRunUsd: z.number().nonnegative(),
  }),
  budget: BudgetSchema.nullable(),
});
export type BudgetTodayResponse = z.infer<typeof BudgetTodayResponseSchema>;

export const ToolsResponseSchema = z.object({
  tools: z.array(ToolDefinitionSchema.extend({ active: z.boolean() })),
});
export type ToolsResponse = z.infer<typeof ToolsResponseSchema>;
