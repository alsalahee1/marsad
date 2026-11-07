import { JsonValueSchema, type JsonValue } from '@marsad/shared';
import { z } from 'zod';
import type { Planner, PlannerContext, StepDecision } from './planner.js';

/**
 * Development planner: turns a run's task text into a fixed script of tool calls, so every run
 * state can be produced and watched on the desk without a model. The executor still enforces
 * every limit around it exactly as it would for the real agent loop. Never wired in production.
 *
 * Task forms:
 *   demo:happy      two echoes, then done
 *   demo:approval   echo, then `demo.wipe` (irreversible: waits for you), then echo, then done
 *   demo:budget     a small `demo.pay`, then one far past every cap (a budget hold), then echo
 *   demo:ceiling    echo forever, until RUN_MAX_STEPS halts the run
 *   demo:failure    echo, then the run fails
 *   plan:<json>     an explicit array of {"tool", "input", "tokens"?} steps, then done
 *   anything else   one echo of the task text, then done
 *
 * Step selection is by `run.stepCount`, never by memory, so a run resumed after an approval or a
 * worker restart continues exactly where the log says it stopped.
 */

export const DevStepSchema = z.object({
  tool: z.string().min(1),
  input: JsonValueSchema.default({}),
  tokens: z.int().nonnegative().max(1_000_000).default(10),
});
export type DevStep = z.infer<typeof DevStepSchema>;
export const DevPlanStepsSchema = z.array(DevStepSchema).max(500);

export type DevPlanEnding = 'final' | 'fail' | 'loop';

export interface DevPlan {
  name: string;
  steps: DevStep[];
  /** What happens once the steps run out. `loop` keeps echoing until a ceiling stops it. */
  ending: DevPlanEnding;
  /** Set when the task was malformed: the run fails with this message at its first step. */
  error?: string;
}

const echo = (message: string): DevStep => ({ tool: 'echo', input: { message }, tokens: 10 });

export const DEMO_PLANS: Readonly<Record<string, Omit<DevPlan, 'name'>>> = {
  happy: { steps: [echo('hello from the dev planner'), echo('second step')], ending: 'final' },
  approval: {
    steps: [
      echo('about to request approval'),
      { tool: 'demo.wipe', input: { target: 'demo' }, tokens: 25 },
      echo('approved path continues'),
    ],
    ending: 'final',
  },
  budget: {
    steps: [
      { tool: 'demo.pay', input: { usd: 0.01 }, tokens: 20 },
      { tool: 'demo.pay', input: { usd: 999_999 }, tokens: 20 },
      echo('after the budget hold'),
    ],
    ending: 'final',
  },
  ceiling: { steps: [], ending: 'loop' },
  failure: { steps: [echo('about to fail')], ending: 'fail' },
};

export function parseDevTask(task: string): DevPlan {
  const text = task.trim();
  const demo = /^demo:([a-z]+)$/i.exec(text);
  if (demo) {
    const key = (demo[1] ?? '').toLowerCase();
    const plan = DEMO_PLANS[key];
    if (plan) return { name: key, ...plan, steps: plan.steps.map((s) => ({ ...s })) };
    return {
      name: key,
      steps: [],
      ending: 'fail',
      error: `unknown demo plan "${key}"; known: ${Object.keys(DEMO_PLANS).join(', ')}`,
    };
  }
  if (text.startsWith('plan:')) {
    let json: unknown;
    try {
      json = JSON.parse(text.slice('plan:'.length));
    } catch (err) {
      return {
        name: 'plan',
        steps: [],
        ending: 'fail',
        error: `plan is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const parsed = DevPlanStepsSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        name: 'plan',
        steps: [],
        ending: 'fail',
        error: `plan does not match [{tool, input?, tokens?}]: ${first ? `${first.path.map(String).join('.')}: ${first.message}` : 'schema mismatch'}`,
      };
    }
    return { name: 'plan', steps: parsed.data, ending: 'final' };
  }
  return { name: 'echo', steps: [echo(text.slice(0, 4000))], ending: 'final' };
}

export class DevPlanner implements Planner {
  next(ctx: PlannerContext): Promise<StepDecision> {
    return Promise.resolve(this.decide(ctx));
  }

  private decide(ctx: PlannerContext): StepDecision {
    const plan = parseDevTask(ctx.run.task);
    if (plan.error !== undefined) return { kind: 'fail', error: plan.error, tokensUsed: 0 };
    const index = ctx.run.stepCount;
    const step = plan.steps[index];
    if (step)
      return { kind: 'tool_call', tool: step.tool, input: step.input, tokensUsed: step.tokens };
    switch (plan.ending) {
      case 'loop':
        return {
          kind: 'tool_call',
          tool: 'echo',
          input: { message: `tick ${index + 1}` },
          tokensUsed: 10,
        };
      case 'fail':
        return { kind: 'fail', error: `demo:${plan.name} fails here, by design`, tokensUsed: 5 };
      case 'final': {
        const output: JsonValue = { plan: plan.name, completedSteps: index };
        return { kind: 'final', output, tokensUsed: 5 };
      }
    }
  }
}
