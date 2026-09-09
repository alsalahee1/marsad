import { z } from 'zod';
import {
  ApprovalDecisionSchema,
  BlastRadiusSchema,
  BlockReasonSchema,
  BudgetScopeSchema,
  HaltReasonSchema,
} from './enums.js';
import { ToolNameSchema } from './entities.js';
import { JsonValueSchema } from './json.js';

/**
 * One row of the append-only `events` table, as delivered to the desk. The union is
 * discriminated on `type` so a consumer can narrow `payload` with a single switch.
 *
 * Envelope fields are identical to {@link SseEnvelope}; every Event is a valid SseEnvelope.
 */
const envelope = {
  /** Decimal string of the BIGINT row id. Monotonic, and the SSE `id:` used for replay. */
  id: z.string().regex(/^\d+$/),
  runId: z.uuid().optional(),
  at: z.iso.datetime(),
};

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ ...envelope, type: z.literal(type), payload });
}

const Usd = z.number().nonnegative();
const Count = z.int().nonnegative();

export const BudgetSnapshotSchema = z.object({
  scope: BudgetScopeSchema,
  key: z.string(),
  capUsd: Usd,
  spentUsd: Usd,
  capCalls: Count.nullable(),
  callCount: Count,
});

export const EventSchema = z.discriminatedUnion('type', [
  // --- runs ---
  event('run.created', z.object({ agentId: z.uuid(), task: z.string() })),
  event('run.started', z.object({ resumed: z.boolean() })),
  event(
    'run.step',
    z.object({
      step: Count,
      decision: z.enum(['tool_call', 'final', 'fail']),
      tokensUsed: Count,
      tool: ToolNameSchema.optional(),
    }),
  ),
  event(
    'run.blocked',
    z.object({
      reason: BlockReasonSchema,
      approvalId: z.uuid().optional(),
      toolCallId: z.uuid().optional(),
      budget: BudgetSnapshotSchema.optional(),
    }),
  ),
  event(
    'run.resumed',
    z.object({ via: z.enum(['approval', 'operator']), approvalId: z.uuid().optional() }),
  ),
  event('run.done', z.object({ output: JsonValueSchema.nullable(), steps: Count })),
  event('run.failed', z.object({ error: z.string(), steps: Count })),
  event(
    'run.halted',
    z.object({
      reason: HaltReasonSchema,
      limit: z.number().optional(),
      value: z.number().optional(),
      detail: z.string().optional(),
    }),
  ),

  // --- tool calls ---
  event(
    'tool.requested',
    z.object({
      toolCallId: z.uuid(),
      tool: ToolNameSchema,
      blastRadius: BlastRadiusSchema,
      step: Count,
      input: JsonValueSchema,
      idempotencyKey: z.string(),
      estimatedCostUsd: Usd,
    }),
  ),
  event(
    'tool.completed',
    z.object({
      toolCallId: z.uuid(),
      tool: ToolNameSchema,
      output: JsonValueSchema,
      actualCostUsd: Usd,
      durationMs: Count,
    }),
  ),
  event(
    'tool.failed',
    z.object({
      toolCallId: z.uuid().optional(),
      tool: z.string(),
      step: Count,
      error: z.string(),
    }),
  ),

  // --- approvals ---
  event(
    'approval.requested',
    z.object({
      approvalId: z.uuid(),
      toolCallId: z.uuid(),
      tool: ToolNameSchema,
      step: Count,
      input: JsonValueSchema,
    }),
  ),
  event('approval.token_issued', z.object({ approvalId: z.uuid(), expiresAt: z.iso.datetime() })),
  event(
    'approval.decided',
    z.object({
      approvalId: z.uuid(),
      toolCallId: z.uuid(),
      decision: ApprovalDecisionSchema,
      decidedBy: z.string(),
    }),
  ),

  // --- budgets ---
  event(
    'budget.exceeded',
    BudgetSnapshotSchema.extend({ attemptedUsd: Usd, toolCallId: z.uuid() }),
  ),

  // --- system ---
  event(
    'system.halted',
    z.object({
      reason: z.string(),
      by: z.string(),
      drainedJobs: Count,
      haltedRuns: z.array(z.uuid()),
    }),
  ),
  event('system.resumed', z.object({ by: z.string() })),
  event(
    'tools.snapshotted',
    z.object({
      tools: z.array(z.object({ name: ToolNameSchema, blastRadius: BlastRadiusSchema })),
    }),
  ),
  event('agent.created', z.object({ agentId: z.uuid(), name: z.string() })),
  event('auth.login', z.object({ ok: z.boolean(), ip: z.string() })),
]);

export type Event = z.infer<typeof EventSchema>;
export type EventType = Event['type'];
export type EventOfType<T extends EventType> = Extract<Event, { type: T }>;
export type EventPayload<T extends EventType> = EventOfType<T>['payload'];

/** What a producer hands to `insertEvent()`: the store assigns `id` and `at`. */
export type EventInput = {
  [T in EventType]: { type: T; runId?: string; payload: EventPayload<T> };
}[EventType];

export const EVENT_TYPES = EventSchema.options.map(
  (o) => o.shape.type.value,
) as readonly EventType[];
