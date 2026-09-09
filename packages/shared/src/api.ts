import { z } from 'zod';
import { ApprovalDecisionSchema, RunStatusSchema } from './enums.js';
import { ToolNameSchema } from './entities.js';

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

export const ListRunsQuerySchema = z.object({
  status: RunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ListEventsQuerySchema = z.object({
  after: z.string().regex(/^\d+$/).optional(),
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
