import type Anthropic from '@anthropic-ai/sdk';
import type { ToolCall } from '@marsad/shared';
import { describe, expect, it } from 'vitest';
import {
  AnthropicPlanner,
  BUILTIN_PRICING,
  estimateCostUsd,
  messagesFor,
  priceFor,
  supportsAdaptiveThinking,
  type MessagesClient,
} from '../../src/executor/anthropicPlanner.js';
import { buildHarness } from '../support/fixtures.js';
import { createMemoryStore } from '../support/memoryStore.js';

const RUN_ID = '9b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';
const TC_ID = '2b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e';

function message(
  content: Anthropic.ContentBlock[],
  stop: Anthropic.StopReason = 'tool_use',
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    container: null,
    diagnostics: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...usage,
    },
  };
}

const toolUse = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
  caller: { type: 'direct' },
});
const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null });
const thinking = (): Anthropic.ThinkingBlock => ({
  type: 'thinking',
  thinking: '',
  signature: 'sig',
});

/** The request-side shape of a stored response turn: response-only fields are not replayed. */
const replayed = (blocks: Anthropic.ContentBlock[]) =>
  blocks.map((b) => {
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    if (b.type === 'text') return { type: 'text', text: b.text };
    return { ...b };
  });

/** Scripted client: answers in order and records every request and its options. */
function fakeClient(responses: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const client: MessagesClient = {
    messages: {
      create: (params, options) => {
        requests.push(params);
        signals.push(options?.signal);
        const next = responses.shift();
        if (!next) throw new Error('no scripted response left');
        return Promise.resolve(next);
      },
    },
  };
  return { client, requests, signals };
}

function toolCallRow(over: Partial<ToolCall>): ToolCall {
  return {
    id: TC_ID,
    runId: RUN_ID,
    step: 1,
    tool: 'echo',
    blastRadius: 'reversible',
    idempotencyKey: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA',
    status: 'executed',
    input: { message: 'hi' },
    modelTurn: null,
    output: { message: 'hi' },
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    error: null,
    createdAt: '2026-09-09T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe('pricing', () => {
  it('matches exact ids, then the longest prefix, and prices cache tokens', () => {
    expect(priceFor('claude-opus-5-5', BUILTIN_PRICING)?.inputPerMTok).toBe(4);
    expect(priceFor('claude-opus-5-5-20260401', BUILTIN_PRICING)?.inputPerMTok).toBe(4);
    expect(priceFor('claude-opus-5-20260101', BUILTIN_PRICING)?.inputPerMTok).toBe(5);
    expect(priceFor('gpt-oss', BUILTIN_PRICING)).toBeUndefined();
    const usd = estimateCostUsd(
      'claude-sonnet-5',
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      },
      BUILTIN_PRICING,
    );
    // 2 + 1 + 0.2 (cache reads default to a tenth of input)
    expect(usd).toBeCloseTo(3.2, 6);
    expect(
      estimateCostUsd(
        'unknown-model',
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        BUILTIN_PRICING,
      ),
    ).toBeUndefined();
  });

  it('knows which models take adaptive thinking', () => {
    expect(supportsAdaptiveThinking('claude-opus-5-5')).toBe(true);
    expect(supportsAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    expect(supportsAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
  });
});

describe('messagesFor: the conversation is the log', () => {
  it('replays the stored assistant turn verbatim and reports each outcome as a tool_result', () => {
    const turn = [thinking(), toolUse('toolu_01AAAAAAAAAAAAAAAAAAAAAA', 'echo', { message: 'hi' })];
    const executed = toolCallRow({ modelTurn: turn as never });
    const rejected = toolCallRow({
      id: '3b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e',
      step: 2,
      tool: 'wipe',
      status: 'rejected',
      idempotencyKey: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB',
      input: { target: 'prod' },
      output: null,
      error: 'rejected by operator',
    });
    const failed = toolCallRow({
      id: '4b2d7f0e-3a3c-4c2a-9d1e-0f9f5b1c2d3e',
      step: 3,
      status: 'failed',
      idempotencyKey: 'derived-key-0003',
      error: 'kaboom',
      output: null,
    });
    const messages = messagesFor('do the thing', [failed, rejected, executed]);
    expect(messages).toHaveLength(7);
    expect(messages[0]).toEqual({ role: 'user', content: 'do the thing' });
    expect(messages[1]).toEqual({ role: 'assistant', content: replayed(turn) });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA',
          content: '{"message":"hi"}',
        },
      ],
    });
    // No stored turn: a synthetic tool_use whose id is the idempotency key.
    expect(messages[3]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB',
          name: 'wipe',
          input: { target: 'prod' },
        },
      ],
    });
    expect(messages[4]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB', is_error: true },
      ],
    });
    expect(JSON.stringify(messages[4])).toContain('operator rejected');
    expect(messages[6]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'derived-key-0003', content: 'kaboom', is_error: true },
      ],
    });
  });
});

describe('AnthropicPlanner decisions', () => {
  async function ctx(toolCalls: ToolCall[] = [], model = 'claude-opus-5-5') {
    const h = await buildHarness(createMemoryStore());
    const agentId = await h.createAgent(['echo', 'pay', 'wipe']);
    const agent = await h.store.agents.get(agentId);
    if (!agent) throw new Error('no agent');
    await h.store.agents.update(agentId, { model, systemPrompt: 'Be brief.' }, h.clock.clock());
    const updated = await h.store.agents.get(agentId);
    const runId = await h.createRun(agentId, 'count the beans');
    const run = await h.store.runs.get(runId);
    if (!run || !updated) throw new Error('no run');
    const controller = new AbortController();
    return {
      h,
      context: {
        run,
        agent: updated,
        toolCalls,
        tools: h.registry.definitions().filter((t) => updated.tools.includes(t.name)),
        signal: controller.signal,
      },
      controller,
    };
  }

  it('builds one request per step: cached system prefix, closed tool set, no parallel calls, adaptive thinking', async () => {
    const { client, requests, signals } = fakeClient([
      message([toolUse('toolu_01CCCCCCCCCCCCCCCCCCCCCC', 'echo', { message: 'beans' })]),
    ]);
    const planner = new AnthropicPlanner({ client, effort: 'high' });
    const { context, controller } = await ctx();
    const decision = await planner.next(context);
    const req = requests[0];
    if (!req) throw new Error('no request');
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.max_tokens).toBe(16_000);
    expect(req.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config).toEqual({ effort: 'high' });
    expect(Array.isArray(req.system) ? req.system.at(-1) : null).toMatchObject({
      text: 'Be brief.',
      cache_control: { type: 'ephemeral' },
    });
    expect((req.tools ?? []).map((t) => (t as Anthropic.Tool).name)).toEqual([
      'echo',
      'pay',
      'wipe',
    ]);
    const echo = (req.tools ?? [])[0] as Anthropic.Tool;
    expect(echo.input_schema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
    });
    expect(JSON.stringify(echo.input_schema)).not.toContain('$schema');
    expect(req.messages).toEqual([{ role: 'user', content: 'count the beans' }]);
    expect(signals[0]).toBe(controller.signal);
    expect(decision).toMatchObject({
      kind: 'tool_call',
      tool: 'echo',
      input: { message: 'beans' },
      idempotencyKey: 'toolu_01CCCCCCCCCCCCCCCCCCCCCC',
      tokensUsed: 1050,
      model: 'claude-opus-5-5',
    });
    if (decision.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(decision.costUsd).toBeCloseTo(0.005, 6); // 1000 in at $4/M + 50 out at $20/M
    expect(Array.isArray(decision.modelTurn)).toBe(true);
  });

  it('omits thinking for models without it and honours the default model alias', async () => {
    const { client, requests } = fakeClient([message([text('done')], 'end_turn')]);
    const planner = new AnthropicPlanner({
      client,
      defaultModel: 'claude-haiku-4-5',
      effort: 'low',
    });
    const { context } = await ctx([], 'default');
    const decision = await planner.next(context);
    expect(requests[0]?.model).toBe('claude-haiku-4-5');
    expect(requests[0]?.thinking).toBeUndefined();
    expect(requests[0]?.output_config).toBeUndefined();
    expect(decision).toMatchObject({
      kind: 'final',
      output: { text: 'done' },
      model: 'claude-haiku-4-5',
    });
  });

  it('maps refusal, context overflow and a truncated tool input to failures, and a truncated answer to a flagged final', async () => {
    const refusal = message([], 'refusal');
    (refusal as { stop_details: unknown }).stop_details = {
      type: 'refusal',
      category: 'cyber',
      explanation: null,
    };
    const { client } = fakeClient([
      refusal,
      message([], 'model_context_window_exceeded'),
      message([toolUse('toolu_01DDDDDDDDDDDDDDDDDDDDDD', 'echo', { message: 'x' })], 'max_tokens'),
      message([text('partial answer')], 'max_tokens'),
    ]);
    const planner = new AnthropicPlanner({ client });
    const { context } = await ctx();
    expect(await planner.next(context)).toMatchObject({
      kind: 'fail',
      error: 'model refused the request (cyber)',
    });
    expect(await planner.next(context)).toMatchObject({
      kind: 'fail',
      error: 'model context window exceeded',
    });
    expect(await planner.next(context)).toMatchObject({
      kind: 'fail',
      error: 'tool input truncated at max_tokens',
    });
    expect(await planner.next(context)).toMatchObject({
      kind: 'final',
      output: { text: 'partial answer', truncated: true },
    });
  });
});

describe('AnthropicPlanner through the executor', () => {
  it('runs a two-call task to done, replaying its own turns and recording model spend', async () => {
    const turn1 = [
      thinking(),
      toolUse('toolu_01EEEEEEEEEEEEEEEEEEEEEE', 'echo', { message: 'one' }),
    ];
    const turn2 = [toolUse('toolu_01FFFFFFFFFFFFFFFFFFFFFF', 'pay', { usd: 0.25 })];
    const { client, requests } = fakeClient([
      message(turn1, 'tool_use', { input_tokens: 500, output_tokens: 20 }),
      message(turn2, 'tool_use', {
        input_tokens: 700,
        output_tokens: 30,
        cache_read_input_tokens: 400,
      }),
      message([text('All done: paid 0.25')], 'end_turn', { input_tokens: 900, output_tokens: 10 }),
    ]);
    const planner = new AnthropicPlanner({ client });
    const h = await buildHarness(createMemoryStore(), { planner });
    const agentId = await h.createAgent(['echo', 'pay']);
    await h.store.agents.update(agentId, { model: 'claude-sonnet-5' }, h.clock.clock());
    const runId = await h.createRun(agentId, 'count then pay');
    expect(await h.executor.execute(runId)).toEqual({ status: 'done' });

    // The second request carries the first turn verbatim and its result; the third carries both.
    expect(requests[1]?.messages).toHaveLength(3);
    expect(requests[1]?.messages[1]).toEqual({
      role: 'assistant',
      content: replayed(turn1),
    });
    expect(requests[1]?.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01EEEEEEEEEEEEEEEEEEEEEE',
          content: '{"message":"one"}',
        },
      ],
    });
    expect(requests[2]?.messages).toHaveLength(5);

    const calls = await h.store.toolCalls.listByRun(runId);
    expect(calls.map((c) => [c.tool, c.status, c.idempotencyKey])).toEqual([
      ['echo', 'executed', 'toolu_01EEEEEEEEEEEEEEEEEEEEEE'],
      ['pay', 'executed', 'toolu_01FFFFFFFFFFFFFFFFFFFFFF'],
    ]);
    expect(calls[0]?.modelTurn).toEqual(turn1);
    const run = await h.store.runs.get(runId);
    expect(run?.output).toEqual({ text: 'All done: paid 0.25' });
    expect(run?.stepCount).toBe(3);
    // 500+20, 700+30+400, 900+10 tokens; spend = model steps at sonnet-5 prices + the 0.25 tool
    expect(run?.tokensUsed).toBe(2560);
    const modelUsd = (500 + 700 + 900) * 2e-6 + (20 + 30 + 10) * 10e-6 + 400 * 0.2e-6;
    expect(run?.costUsd).toBeCloseTo(modelUsd + 0.25, 6);
    const steps = (await h.store.events.listAfter(null, 100)).filter((e) => e.type === 'run.step');
    expect(steps).toHaveLength(3);
    expect(steps[0]?.payload).toMatchObject({
      decision: 'tool_call',
      tool: 'echo',
      model: 'claude-sonnet-5',
    });
    expect((steps[0]?.payload as { costUsd: number }).costUsd).toBeCloseTo(
      500 * 2e-6 + 20 * 10e-6,
      9,
    );
  });

  it('invalid model arguments become a failed row the model sees next step', async () => {
    const { client, requests } = fakeClient([
      message([toolUse('toolu_01GGGGGGGGGGGGGGGGGGGGGG', 'echo', { nope: true })]),
      message([text('giving up')], 'end_turn'),
    ]);
    const h = await buildHarness(createMemoryStore(), {
      planner: new AnthropicPlanner({ client }),
    });
    const agentId = await h.createAgent(['echo']);
    await h.store.agents.update(agentId, { model: 'claude-sonnet-5' }, h.clock.clock());
    const runId = await h.createRun(agentId, 'echo badly');
    expect(await h.executor.execute(runId)).toEqual({ status: 'done' });
    const calls = await h.store.toolCalls.listByRun(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('failed');
    expect(calls[0]?.error).toMatch(/invalid input: message/);
    expect(h.counts.echo).toBe(0);
    expect(requests[1]?.messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01GGGGGGGGGGGGGGGGGGGGGG', is_error: true },
      ],
    });
  });

  it('a request aborted by the wall-clock deadline halts the run as a ceiling, not a planner error', async () => {
    const client: MessagesClient = {
      messages: {
        create: (_params, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('Request was aborted'));
            });
          }),
      },
    };
    const h = await buildHarness(createMemoryStore(), {
      planner: new AnthropicPlanner({ client }),
      env: { RUN_MAX_WALL_CLOCK_MS: '50' },
    });
    const agentId = await h.createAgent(['echo']);
    await h.store.agents.update(agentId, { model: 'claude-sonnet-5' }, h.clock.clock());
    const runId = await h.createRun(agentId, 'take forever');
    expect(await h.executor.execute(runId)).toEqual({
      status: 'halted',
      reason: 'ceiling.wall_clock',
    });
    expect((await h.store.runs.get(runId))?.statusReason).toBe('ceiling.wall_clock');
  });
});
