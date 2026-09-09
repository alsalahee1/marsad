import { z } from 'zod';
import { defineTool, type ToolRegistry } from '../registry.js';

/**
 * Reversible reference tool. It proves the dispatch path end to end without touching anything.
 * Real tools live next to it, each declaring its blast radius.
 */
export const echoTool = defineTool({
  name: 'echo',
  description: 'Returns its input unchanged. Reversible; used to exercise the executor.',
  blastRadius: 'reversible',
  input: z.object({ message: z.string().max(4000) }),
  execute: (input) => Promise.resolve({ output: { message: input.message } }),
});

/** Reversible: waits, then returns. Useful for exercising the wall-clock ceiling and the halt path. */
export const sleepTool = defineTool({
  name: 'sleep',
  description: 'Waits for up to 30 seconds. Reversible.',
  blastRadius: 'reversible',
  input: z.object({ ms: z.int().min(0).max(30_000) }),
  execute: async (input, ctx) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, input.ms);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
    return { output: { sleptMs: input.ms } };
  },
});

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(echoTool);
  registry.register(sleepTool);
}
