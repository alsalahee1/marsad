import type {
  Agent,
  AgentRosterRow,
  ApprovalKind,
  ApprovalQueueItem,
  Run,
  RunDetailResponse,
  RunStatus,
  ToolCall,
} from '@marsad/shared';

export const AGENT_ID = '1b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
export const RUN_ID = '9b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
export const TOOL_CALL_ID = '2b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
export const APPROVAL_ID = '3b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
const AT = '2026-09-09T10:00:00.000Z';

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: 'Inventory sync',
    model: 'dev',
    systemPrompt: '',
    tools: ['echo', 'demo.pay', 'demo.wipe'],
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

export function rosterRow(
  over: Partial<AgentRosterRow['stats']> = {},
  a = agent(),
): AgentRosterRow {
  return {
    agent: a,
    stats: {
      agentId: a.id,
      activeRun: null,
      runsToday: 3,
      spentTodayUsd: 1.25,
      lastRunAt: AT,
      ...over,
    },
  };
}

export function run(status: RunStatus = 'blocked', over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    status,
    task: 'reconcile invoices for September',
    stepCount: 4,
    tokensUsed: 1234,
    costUsd: 0.7,
    activeMs: 12_000,
    statusReason: status === 'blocked' ? 'awaiting operator approval' : null,
    blockedOn: status === 'blocked' ? { kind: 'approval', id: APPROVAL_ID } : null,
    output: null,
    createdAt: AT,
    startedAt: AT,
    finishedAt: null,
    updatedAt: AT,
    ...over,
  };
}

export function toolCall(
  kind: ApprovalKind = 'irreversible',
  over: Partial<ToolCall> = {},
): ToolCall {
  return {
    id: TOOL_CALL_ID,
    runId: RUN_ID,
    step: 4,
    tool: kind === 'budget' ? 'demo.pay' : 'demo.wipe',
    blastRadius: kind === 'budget' ? 'costly' : 'irreversible',
    idempotencyKey: 'k'.repeat(16),
    status: kind === 'budget' ? 'blocked' : 'awaiting_approval',
    input: kind === 'budget' ? { usd: 999 } : { target: 'prod' },
    output: null,
    estimatedCostUsd: kind === 'budget' ? 999 : 0,
    actualCostUsd: null,
    error: null,
    createdAt: AT,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

export function approvalItem(kind: ApprovalKind = 'irreversible'): ApprovalQueueItem {
  return {
    approval: {
      id: APPROVAL_ID,
      runId: RUN_ID,
      toolCallId: TOOL_CALL_ID,
      kind,
      status: 'pending',
      tokenExpiresAt: null,
      decidedAt: null,
      decidedBy: null,
      createdAt: AT,
    },
    toolCall: toolCall(kind),
    run: run('blocked'),
    agent: agent(),
  };
}

export function runDetail(status: RunStatus = 'running'): RunDetailResponse {
  return {
    run: run(status),
    agent: agent(),
    toolCalls: [
      toolCall('budget', { status: 'executed', actualCostUsd: 0.7, startedAt: AT, finishedAt: AT }),
    ],
    approvals: [],
    budget: {
      scope: 'run',
      key: RUN_ID,
      spentUsd: 0.7,
      callCount: 1,
      capUsd: 2,
      capCalls: null,
      updatedAt: AT,
    },
  };
}

export const LIMITS = {
  maxSteps: 40,
  maxTokens: 250_000,
  maxWallClockMs: 900_000,
  perRunUsd: 2,
  perDayUsd: 25,
  perDayCalls: 200,
  approvalTokenTtlMs: 600_000,
};
