import type { Event } from '@marsad/shared';

export const RUN_ID = '9b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
export const AGENT_ID = '1b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
const TOOL_CALL_ID = '2b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
const APPROVAL_ID = '3b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';

let clock = Date.parse('2026-09-09T10:00:00.000Z');

/** A valid event of any type, with a monotonic timestamp. */
export function makeEvent(id: number | string, type: Event['type'] = 'system.resumed'): Event {
  clock += 1000;
  const base = { id: String(id), runId: RUN_ID, at: new Date(clock).toISOString() };
  const bare = { id: base.id, at: base.at };
  switch (type) {
    case 'run.created':
      return { ...base, type, payload: { agentId: AGENT_ID, task: 'reconcile invoices' } };
    case 'run.started':
      return { ...base, type, payload: { resumed: false } };
    case 'run.step':
      return {
        ...base,
        type,
        payload: { step: 3, decision: 'tool_call', tokensUsed: 1234, tool: 'fs.read' },
      };
    case 'run.blocked':
      return {
        ...base,
        type,
        payload: { reason: 'approval', approvalId: APPROVAL_ID, toolCallId: TOOL_CALL_ID },
      };
    case 'run.resumed':
      return { ...base, type, payload: { via: 'approval', approvalId: APPROVAL_ID } };
    case 'run.done':
      return { ...base, type, payload: { output: { ok: true }, steps: 7 } };
    case 'run.failed':
      return { ...base, type, payload: { error: 'planner exploded', steps: 2 } };
    case 'run.halted':
      return { ...base, type, payload: { reason: 'ceiling.steps', limit: 40, value: 40 } };
    case 'tool.requested':
      return {
        ...base,
        type,
        payload: {
          toolCallId: TOOL_CALL_ID,
          tool: 'http.get',
          blastRadius: 'costly',
          step: 3,
          input: { url: 'https://example.com' },
          idempotencyKey: 'run:3:http.get',
          estimatedCostUsd: 0.0125,
        },
      };
    case 'tool.completed':
      return {
        ...base,
        type,
        payload: {
          toolCallId: TOOL_CALL_ID,
          tool: 'http.get',
          output: { status: 200 },
          actualCostUsd: 0.01,
          durationMs: 840,
        },
      };
    case 'tool.failed':
      return {
        ...base,
        type,
        payload: { toolCallId: TOOL_CALL_ID, tool: 'http.get', step: 3, error: 'ECONNRESET' },
      };
    case 'approval.requested':
      return {
        ...base,
        type,
        payload: {
          approvalId: APPROVAL_ID,
          toolCallId: TOOL_CALL_ID,
          tool: 'email.send',
          step: 4,
          input: { to: 'ops@example.com' },
        },
      };
    case 'approval.token_issued':
      return {
        ...base,
        type,
        payload: { approvalId: APPROVAL_ID, expiresAt: new Date(clock + 600_000).toISOString() },
      };
    case 'approval.decided':
      return {
        ...base,
        type,
        payload: {
          approvalId: APPROVAL_ID,
          toolCallId: TOOL_CALL_ID,
          decision: 'approve',
          decidedBy: 'operator',
        },
      };
    case 'budget.exceeded':
      return {
        ...base,
        type,
        payload: {
          scope: 'day',
          key: '2026-09-09',
          capUsd: 25,
          spentUsd: 24.99,
          capCalls: 200,
          callCount: 199,
          attemptedUsd: 0.0125,
          toolCallId: TOOL_CALL_ID,
        },
      };
    case 'system.halted':
      return {
        ...bare,
        type,
        payload: { reason: 'smoke', by: 'operator', drainedJobs: 2, haltedRuns: [RUN_ID] },
      };
    case 'system.resumed':
      return { ...bare, type, payload: { by: 'operator' } };
    case 'tools.snapshotted':
      return {
        ...bare,
        type,
        payload: { tools: [{ name: 'fs.read', blastRadius: 'reversible' }] },
      };
    case 'agent.created':
      return { ...bare, type, payload: { agentId: AGENT_ID, name: 'Inventory sync' } };
    case 'auth.login':
      return { ...bare, type, payload: { ok: true, ip: '127.0.0.1' } };
  }
}

export function range(from: number, to: number, type?: Event['type']): Event[] {
  const out: Event[] = [];
  for (let i = from; i <= to; i += 1) out.push(makeEvent(i, type));
  return out;
}
