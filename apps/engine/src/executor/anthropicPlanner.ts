import type Anthropic from '@anthropic-ai/sdk';
import type { Agent, JsonValue, ToolCall, ToolDefinition } from '@marsad/shared';
import type { ModelPricingTable } from '../config.js';
import type { Logger } from '../logger.js';
import type { Planner, PlannerContext, StepDecision } from './planner.js';

/**
 * The agent loop, written by hand on top of the Messages API. The executor owns the loop and
 * every limit; this planner makes exactly one request per step and returns one decision:
 * a single tool call (parallel tool use is off), a final answer, or a failure.
 *
 * The conversation is rebuilt on every step from the run's tool_calls rows: each row's
 * `modelTurn` is the assistant turn the model wrote (thinking + tool_use blocks, replayed
 * verbatim, which is what preserved thinking requires) and its output or error is the
 * tool_result. Nothing is kept in memory between steps, so a run resumed after an approval or
 * a worker restart sees exactly what the log says happened.
 */

/** The slice of the SDK the planner touches, so tests hand in a fake without a network. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicPlannerDeps {
  client: MessagesClient;
  /** Used when an agent's model is the literal `default`. */
  defaultModel?: string | undefined;
  effort?: Effort | undefined;
  /** Overrides and extends the built-in price table (USD per million tokens). */
  pricing?: ModelPricingTable | undefined;
  maxTokens?: number;
  log?: Logger;
}

/** Non-streaming per step: a tool call or an answer, never a document. */
export const DEFAULT_MAX_TOKENS = 16_000;

/** USD per million tokens. Cache reads default to 10% of input, cache writes to 125%. */
export const BUILTIN_PRICING: ModelPricingTable = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Models that take `thinking: { type: "adaptive" }` and `output_config.effort`. */
const ADAPTIVE_THINKING = /^claude-(fable|mythos|opus-(5|4-[678])|sonnet-(5|4-6)|haiku-5)/;

export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING.test(model);
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Exact id first, then the longest matching prefix (dated ids, regional suffixes). */
export function priceFor(
  model: string,
  table: ModelPricingTable,
): ModelPricingTable[string] | undefined {
  const exact = table[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : table[best];
}

export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
  table: ModelPricingTable,
): number | undefined {
  const price = priceFor(model, table);
  if (!price) return undefined;
  const perTok = (perMTok: number) => perMTok / 1_000_000;
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * 1.25;
  const usd =
    usage.inputTokens * perTok(price.inputPerMTok) +
    usage.outputTokens * perTok(price.outputPerMTok) +
    usage.cacheReadTokens * perTok(cacheRead) +
    usage.cacheWriteTokens * perTok(cacheWrite);
  return Math.round(usd * 1e6) / 1e6;
}

export const PREAMBLE = [
  'You are an agent run by MARSAD, an operations desk watched by a human operator.',
  'Work on the task below with the tools provided, one tool call at a time.',
  'Every limit on steps, tokens, time and spend is enforced by the engine around you; you do not track them.',
  'Some tools pause for the operator to approve before they run. A tool result marked as an error saying the operator rejected the call means it will not run: do not retry it; continue without it or say what you could not do.',
  'When the task is complete, or you cannot proceed, answer in plain text with the result.',
].join('\n');

function resolveModel(agent: Agent, defaultModel: string | undefined): string {
  if (agent.model === 'default' && defaultModel !== undefined) return defaultModel;
  return agent.model;
}

function inputSchemaOf(def: ToolDefinition): Anthropic.Tool.InputSchema {
  const raw = def.inputSchema;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && raw['type'] === 'object') {
    // Drop the draft marker zod adds; the API wants a bare object schema.
    const { $schema: _dropped, ...schema } = raw;
    return { ...schema, type: 'object' };
  }
  return { type: 'object', properties: {} };
}

export function toolsFor(definitions: readonly ToolDefinition[]): Anthropic.Tool[] {
  return definitions.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: inputSchemaOf(def),
  }));
}

type Block = Anthropic.ContentBlockParam;

/** The stored assistant turn, re-validated block by block; anything odd becomes a synthetic turn. */
function replayTurn(tc: ToolCall): { blocks: Block[]; toolUseId: string } {
  const synthetic = (): { blocks: Block[]; toolUseId: string } => ({
    toolUseId: tc.idempotencyKey,
    blocks: [{ type: 'tool_use', id: tc.idempotencyKey, name: tc.tool, input: tc.input }],
  });
  const turn = tc.modelTurn;
  if (!Array.isArray(turn)) return synthetic();
  const blocks: Block[] = [];
  let toolUseId: string | null = null;
  for (const raw of turn) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const b = raw as Record<string, JsonValue>;
    switch (b['type']) {
      case 'thinking':
        if (typeof b['thinking'] === 'string' && typeof b['signature'] === 'string')
          blocks.push({ type: 'thinking', thinking: b['thinking'], signature: b['signature'] });
        break;
      case 'redacted_thinking':
        if (typeof b['data'] === 'string')
          blocks.push({ type: 'redacted_thinking', data: b['data'] });
        break;
      case 'text':
        if (typeof b['text'] === 'string' && b['text'] !== '')
          blocks.push({ type: 'text', text: b['text'] });
        break;
      case 'tool_use':
        if (typeof b['id'] === 'string' && typeof b['name'] === 'string' && toolUseId === null) {
          toolUseId = b['id'];
          blocks.push({ type: 'tool_use', id: b['id'], name: b['name'], input: tc.input });
        }
        break;
      default:
        break;
    }
  }
  if (toolUseId === null) return synthetic();
  return { blocks, toolUseId };
}

/** What the model is told happened to its call. */
export function resultFor(tc: ToolCall): { content: string; isError: boolean } {
  switch (tc.status) {
    case 'executed':
      return { content: JSON.stringify(tc.output ?? null), isError: false };
    case 'rejected':
      return {
        content: 'The operator rejected this call. It did not run and must not be retried.',
        isError: true,
      };
    case 'failed':
      return { content: tc.error ?? 'the call failed', isError: true };
    default:
      return { content: `the call did not complete (${tc.status})`, isError: true };
  }
}

/** The run's conversation, rebuilt from its rows: task, then one assistant + result pair per call. */
export function messagesFor(
  task: string,
  toolCalls: readonly ToolCall[],
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }];
  const ordered = [...toolCalls].sort(
    (a, b) => a.step - b.step || a.createdAt.localeCompare(b.createdAt),
  );
  for (const tc of ordered) {
    const { blocks, toolUseId } = replayTurn(tc);
    const result = resultFor(tc);
    messages.push({ role: 'assistant', content: blocks });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        },
      ],
    });
  }
  return messages;
}

export class AnthropicPlanner implements Planner {
  readonly #deps: AnthropicPlannerDeps;
  readonly #pricing: ModelPricingTable;
  readonly #unpriced = new Set<string>();

  constructor(deps: AnthropicPlannerDeps) {
    this.#deps = deps;
    this.#pricing = { ...BUILTIN_PRICING, ...(deps.pricing ?? {}) };
  }

  buildRequest(ctx: PlannerContext): Anthropic.MessageCreateParamsNonStreaming {
    const model = resolveModel(ctx.agent, this.#deps.defaultModel);
    const prompt = ctx.agent.systemPrompt.trim();
    // Stable prefix first (preamble, agent prompt, tools), the growing history after it: the
    // cache breakpoint on the last system block keeps every later step cheap.
    const system: Anthropic.TextBlockParam[] =
      prompt === ''
        ? [{ type: 'text', text: PREAMBLE, cache_control: { type: 'ephemeral' } }]
        : [
            { type: 'text', text: PREAMBLE },
            { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
          ];
    const adaptive = supportsAdaptiveThinking(model);
    return {
      model,
      max_tokens: this.#deps.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      tools: toolsFor(ctx.tools),
      // One call per step keeps the executor's accounting exact; `auto` still lets the model answer.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: messagesFor(ctx.run.task, ctx.toolCalls),
      ...(adaptive ? { thinking: { type: 'adaptive' } } : {}),
      ...(adaptive && this.#deps.effort !== undefined
        ? { output_config: { effort: this.#deps.effort } }
        : {}),
    };
  }

  async next(ctx: PlannerContext): Promise<StepDecision> {
    const request = this.buildRequest(ctx);
    const response = await this.#deps.client.messages.create(request, { signal: ctx.signal });
    return this.decide(request.model, response);
  }

  decide(model: string, response: Anthropic.Message): StepDecision {
    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    const tokensUsed =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const costUsd = estimateCostUsd(model, usage, this.#pricing);
    if (costUsd === undefined && !this.#unpriced.has(model)) {
      this.#unpriced.add(model);
      this.#deps.log?.warn(
        { model },
        'no price known for this model; set AGENT_MODEL_PRICING to record its spend',
      );
    }
    const base = { tokensUsed, model, ...(costUsd === undefined ? {} : { costUsd }) };

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      return { kind: 'fail', error: `model refused the request (${category})`, ...base };
    }
    if (response.stop_reason === 'model_context_window_exceeded') {
      return { kind: 'fail', error: 'model context window exceeded', ...base };
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUse) {
      if (response.stop_reason === 'max_tokens') {
        return { kind: 'fail', error: 'tool input truncated at max_tokens', ...base };
      }
      return {
        kind: 'tool_call',
        tool: toolUse.name,
        input: toolUse.input as JsonValue,
        idempotencyKey: toolUse.id,
        modelTurn: response.content as unknown as JsonValue,
        ...base,
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const truncated = response.stop_reason === 'max_tokens';
    return {
      kind: 'final',
      output: { text, ...(truncated ? { truncated: true } : {}) },
      ...base,
    };
  }
}
