import { z } from 'zod';
import { defineTool, type ToolRegistry } from '../registry.js';

/**
 * Development-only tools. They exist so every run state can be produced on a laptop without a
 * model or a real side effect: a costly call that "spends" what it is told, an irreversible call
 * that always enters the approval queue, and a call that always fails. `registerDevTools` is
 * never called in a production build (see main.ts); their blast radii are real all the same.
 */

export const demoPayTool = defineTool({
  name: 'demo.pay',
  description: 'Costly demo: pretends to spend input.usd and reports it as the actual cost.',
  blastRadius: 'costly',
  input: z.object({ usd: z.number().nonnegative().max(1_000_000_000) }),
  estimateCostUsd: (input) => input.usd,
  execute: (input) => Promise.resolve({ output: { paid: input.usd }, costUsd: input.usd }),
});

export const demoWipeTool = defineTool({
  name: 'demo.wipe',
  description: 'Irreversible demo: deletes nothing, but always needs your approval first.',
  blastRadius: 'irreversible',
  input: z.object({ target: z.string().min(1).max(200) }),
  execute: (input) => Promise.resolve({ output: { wiped: input.target } }),
});

export const demoFailTool = defineTool({
  name: 'demo.fail',
  description: 'Reversible demo: always throws, to exercise the failure path.',
  blastRadius: 'reversible',
  input: z.object({ message: z.string().max(200).default('demo.fail always throws') }),
  execute: (input) => Promise.reject(new Error(input.message)),
});

export const DEV_TOOL_NAMES = [demoPayTool.name, demoWipeTool.name, demoFailTool.name] as const;

export function registerDevTools(registry: ToolRegistry): void {
  registry.register(demoPayTool);
  registry.register(demoWipeTool);
  registry.register(demoFailTool);
}
