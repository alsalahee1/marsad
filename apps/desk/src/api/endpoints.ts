import {
  AgentDetailResponseSchema,
  AgentRosterResponseSchema,
  ApprovalQueueResponseSchema,
  BudgetTodayResponseSchema,
  CreateAgentRequestSchema,
  CreateRunRequestSchema,
  DecideApprovalResponseSchema,
  EventSchema,
  IssueTokenResponseSchema,
  LimitsResponseSchema,
  LoginRequestSchema,
  RunDetailResponseSchema,
  RunPageResponseSchema,
  SystemStateSchema,
  ToolsResponseSchema,
  UpdateAgentRequestSchema,
  type AgentDetailResponse,
  type AgentRosterRow,
  type ApprovalDecision,
  type ApprovalQueueItem,
  type ApprovalStatus,
  type BudgetTodayResponse,
  type CreateAgentRequest,
  type CreateRunRequest,
  type Event,
  type LimitsResponse,
  type RunDetailResponse,
  type RunPageResponse,
  type RunStatus,
  type SystemState,
  type ToolsResponse,
  type UpdateAgentRequest,
} from '@marsad/shared';
import { z } from 'zod';
import { apiFetch } from './client.js';

/**
 * Typed calls, one per route the desk uses. Every response body is validated at the boundary
 * so a drifted engine fails loudly here instead of somewhere in a render.
 */

const SessionResponseSchema = z.object({
  authenticated: z.literal(true),
  expiresAt: z.iso.datetime().nullable(),
});
export type SessionInfo = z.infer<typeof SessionResponseSchema>;

const LoginResponseSchema = z.object({ ok: z.literal(true), expiresAt: z.iso.datetime() });

const HaltResponseSchema = z.object({
  halted: z.literal(true),
  drainedJobs: z.int().nonnegative(),
  haltedRuns: z.array(z.string()),
});
export type HaltResult = z.infer<typeof HaltResponseSchema>;

const EventsResponseSchema = z.object({ events: z.array(EventSchema) });

const opts = (signal?: AbortSignal) => (signal ? { signal } : {});

// --- auth ---

export async function getSession(signal?: AbortSignal): Promise<SessionInfo> {
  return SessionResponseSchema.parse(await apiFetch('/auth/session', opts(signal)));
}

export async function login(password: string): Promise<{ expiresAt: string }> {
  const body = LoginRequestSchema.parse({ password });
  const res = LoginResponseSchema.parse(await apiFetch('/auth/login', { method: 'POST', body }));
  return { expiresAt: res.expiresAt };
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

// --- system ---

export async function getSystem(signal?: AbortSignal): Promise<SystemState> {
  return SystemStateSchema.parse(await apiFetch('/system', opts(signal)));
}

export async function haltAll(reason = 'operator'): Promise<HaltResult> {
  return HaltResponseSchema.parse(await apiFetch('/halt', { method: 'POST', body: { reason } }));
}

export async function resumeAll(): Promise<void> {
  await apiFetch('/resume', { method: 'POST', body: {} });
}

export async function getLimits(signal?: AbortSignal): Promise<LimitsResponse> {
  return LimitsResponseSchema.parse(await apiFetch('/limits', opts(signal)));
}

// --- events ---

export async function getEventsTail(
  limit: number,
  before?: string,
  signal?: AbortSignal,
): Promise<Event[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', before);
  const res = await apiFetch(`/events/tail?${params.toString()}`, opts(signal));
  return EventsResponseSchema.parse(res).events;
}

/** The run timeline: the newest `limit` rows of one run, ascending. */
export async function getRunEvents(
  runId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Event[]> {
  const params = new URLSearchParams({ runId, limit: String(limit) });
  const res = await apiFetch(`/events/tail?${params.toString()}`, opts(signal));
  return EventsResponseSchema.parse(res).events;
}

// --- agents ---

export async function listAgents(signal?: AbortSignal): Promise<AgentRosterRow[]> {
  return AgentRosterResponseSchema.parse(await apiFetch('/agents', opts(signal))).agents;
}

export async function getAgent(id: string, signal?: AbortSignal): Promise<AgentDetailResponse> {
  return AgentDetailResponseSchema.parse(
    await apiFetch(`/agents/${encodeURIComponent(id)}`, opts(signal)),
  );
}

export async function createAgent(input: CreateAgentRequest): Promise<AgentDetailResponse> {
  const body = CreateAgentRequestSchema.parse(input);
  return AgentDetailResponseSchema.parse(await apiFetch('/agents', { method: 'POST', body }));
}

export async function updateAgent(
  id: string,
  patch: UpdateAgentRequest,
): Promise<AgentDetailResponse> {
  const body = UpdateAgentRequestSchema.parse(patch);
  return AgentDetailResponseSchema.parse(
    await apiFetch(`/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  );
}

// --- runs ---

export interface RunListParams {
  status?: RunStatus;
  agentId?: string;
  cursor?: string;
  limit?: number;
}

export async function listRuns(
  params: RunListParams = {},
  signal?: AbortSignal,
): Promise<RunPageResponse> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.agentId) q.set('agentId', params.agentId);
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  const query = q.toString();
  return RunPageResponseSchema.parse(
    await apiFetch(`/runs${query ? `?${query}` : ''}`, opts(signal)),
  );
}

export async function getRun(id: string, signal?: AbortSignal): Promise<RunDetailResponse> {
  return RunDetailResponseSchema.parse(
    await apiFetch(`/runs/${encodeURIComponent(id)}`, opts(signal)),
  );
}

export async function createRun(input: CreateRunRequest): Promise<RunDetailResponse> {
  const body = CreateRunRequestSchema.parse(input);
  return RunDetailResponseSchema.parse(await apiFetch('/runs', { method: 'POST', body }));
}

export async function haltRun(id: string, reason = 'operator'): Promise<RunDetailResponse> {
  return RunDetailResponseSchema.parse(
    await apiFetch(`/runs/${encodeURIComponent(id)}/halt`, { method: 'POST', body: { reason } }),
  );
}

// --- approvals ---

export async function listApprovals(
  status?: ApprovalStatus,
  signal?: AbortSignal,
): Promise<ApprovalQueueItem[]> {
  const query = status ? `?status=${status}` : '';
  return ApprovalQueueResponseSchema.parse(await apiFetch(`/approvals${query}`, opts(signal)))
    .approvals;
}

/**
 * Decide an approval: mint a single-use token, then spend it. The token lives in this call's
 * stack frame only; the desk never stores it.
 */
export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
): Promise<{ resumed: boolean }> {
  const path = `/approvals/${encodeURIComponent(approvalId)}`;
  const issued = IssueTokenResponseSchema.parse(
    await apiFetch(`${path}/token`, { method: 'POST' }),
  );
  const decided = DecideApprovalResponseSchema.parse(
    await apiFetch(`${path}/decide`, { method: 'POST', body: { token: issued.token, decision } }),
  );
  return { resumed: decided.resumed };
}

// --- catalog ---

export async function getTools(signal?: AbortSignal): Promise<ToolsResponse['tools']> {
  return ToolsResponseSchema.parse(await apiFetch('/tools', opts(signal))).tools;
}

export async function getBudgetToday(signal?: AbortSignal): Promise<BudgetTodayResponse> {
  return BudgetTodayResponseSchema.parse(await apiFetch('/budgets/today', opts(signal)));
}
