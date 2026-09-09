import {
  BLAST_RADII,
  ToolNameSchema,
  type BlastRadius,
  type JsonValue,
  type ToolDefinition,
} from '@marsad/shared';
import { z } from 'zod';
import type { Logger } from '../logger.js';

export interface ToolContext {
  runId: string;
  agentId: string;
  step: number;
  toolCallId: string;
  /**
   * Forward this to any external side-effecting API that accepts an idempotency key. The same
   * key is reused if a worker retries this exact call, so the remote side can de-duplicate.
   */
  idempotencyKey: string;
  /** Fires when the run's wall-clock ceiling arrives or the engine shuts down. */
  signal: AbortSignal;
  log: Logger;
}

export interface ToolResult<O extends JsonValue = JsonValue> {
  output: O;
  /** Actual spend, for `costly` tools. Defaults to the estimate. */
  costUsd?: number;
}

/**
 * A tool as the author writes it. `blastRadius` is mandatory — the registry rejects a tool
 * without one — and a `costly` tool must be able to estimate its cost before it runs.
 */
export interface Tool<I, O extends JsonValue = JsonValue> {
  name: string;
  description: string;
  blastRadius: BlastRadius;
  version?: string;
  input: z.ZodType<I>;
  estimateCostUsd?: (input: I) => number;
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult<O>>;
}

/** Type-erased form kept in the registry. */
export interface RegisteredTool {
  name: string;
  description: string;
  blastRadius: BlastRadius;
  version: string;
  input: z.ZodType;
  estimateCostUsd: ((input: unknown) => number) | undefined;
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export class ToolRegistrationError extends Error {
  override readonly name = 'ToolRegistrationError';
}

/** Preserves inference of the input type from the zod schema at the definition site. */
export function defineTool<I, O extends JsonValue>(tool: Tool<I, O>): Tool<I, O> {
  return tool;
}

const BLAST_RADIUS_SET = new Set<string>(BLAST_RADII);

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  /**
   * Validates and stores a tool. Throws ToolRegistrationError (and therefore fails boot) when:
   * the name is invalid or duplicated, blastRadius is missing or not one of the three values,
   * the input is not a zod schema, or a costly tool cannot estimate its cost.
   */
  register<I, O extends JsonValue>(tool: Tool<I, O>): void {
    const candidate = tool as Partial<Tool<I, O>>;
    const name = typeof candidate.name === 'string' ? candidate.name : '<unnamed>';
    if (!ToolNameSchema.safeParse(name).success) {
      throw new ToolRegistrationError(
        `tool "${name}": invalid name (lowercase segments joined by dots)`,
      );
    }
    if (this.#tools.has(name))
      throw new ToolRegistrationError(`tool "${name}": already registered`);
    if (candidate.blastRadius === undefined) {
      throw new ToolRegistrationError(
        `tool "${name}": blastRadius is required (reversible | costly | irreversible)`,
      );
    }
    if (typeof candidate.blastRadius !== 'string' || !BLAST_RADIUS_SET.has(candidate.blastRadius)) {
      throw new ToolRegistrationError(
        `tool "${name}": blastRadius must be one of reversible | costly | irreversible, got ${JSON.stringify(candidate.blastRadius)}`,
      );
    }
    if (!(candidate.input instanceof z.ZodType)) {
      throw new ToolRegistrationError(`tool "${name}": input must be a zod schema`);
    }
    if (typeof candidate.execute !== 'function') {
      throw new ToolRegistrationError(`tool "${name}": execute must be a function`);
    }
    if (typeof candidate.description !== 'string' || candidate.description.trim() === '') {
      throw new ToolRegistrationError(`tool "${name}": description is required`);
    }
    if (candidate.blastRadius === 'costly' && typeof candidate.estimateCostUsd !== 'function') {
      throw new ToolRegistrationError(
        `tool "${name}": a costly tool must implement estimateCostUsd(input)`,
      );
    }
    const input = candidate.input as z.ZodType;
    const execute = candidate.execute as (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
    const estimateCostUsd = candidate.estimateCostUsd as ((input: unknown) => number) | undefined;
    this.#tools.set(name, {
      name,
      description: candidate.description,
      blastRadius: candidate.blastRadius,
      version: candidate.version ?? '1',
      input,
      estimateCostUsd,
      execute,
    });
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Serialisable snapshot written to the `tools` table at boot. */
  definitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      blastRadius: t.blastRadius,
      inputSchema: z.toJSONSchema(t.input, { unrepresentable: 'any' }) as JsonValue,
      version: t.version,
    }));
  }
}
