import type { Agent, JsonValue, Run, ToolCall, ToolDefinition } from '@marsad/shared';

/**
 * Extension point for the agent loop (next session). The executor asks the planner what to do
 * next and enforces every limit around the answer. The planner never executes anything itself.
 */
export interface PlannerContext {
  run: Run;
  agent: Agent;
  /** Every tool call of this run so far, oldest first, including rejected and failed ones. */
  toolCalls: readonly ToolCall[];
  /** Tools the agent is allowed to call, as registry definitions. */
  tools: readonly ToolDefinition[];
  /** Aborts when the wall-clock ceiling arrives. */
  signal: AbortSignal;
}

/** What every decision carries: the tokens it consumed and, when the planner can price them, the spend. */
interface DecisionUsage {
  tokensUsed: number;
  /** Model spend for this step in USD. Recorded on the run; not a `costly` tool reservation. */
  costUsd?: number;
  model?: string;
}

export type StepDecision =
  | ({
      kind: 'tool_call';
      tool: string;
      input: JsonValue;
      /** Optional explicit key (for example the model's tool_use id). Derived when absent. */
      idempotencyKey?: string;
      /** Overrides the tool's own estimate when the caller knows better. */
      estimatedCostUsd?: number;
      /** The assistant turn that made the call, stored with the row and replayed verbatim. */
      modelTurn?: JsonValue;
    } & DecisionUsage)
  | ({ kind: 'final'; output: JsonValue | null } & DecisionUsage)
  | ({ kind: 'fail'; error: string } & DecisionUsage);

export interface Planner {
  next(ctx: PlannerContext): Promise<StepDecision>;
}

/** Wired by default until the LLM planner exists. Fails the run loudly instead of pretending. */
export class UnconfiguredPlanner implements Planner {
  next(): Promise<StepDecision> {
    return Promise.resolve({
      kind: 'fail',
      error: 'no planner configured: the agent loop is not wired into this engine build',
      tokensUsed: 0,
    });
  }
}
