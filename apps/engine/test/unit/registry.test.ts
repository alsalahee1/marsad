import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ToolRegistrationError,
  ToolRegistry,
  defineTool,
  type Tool,
} from '../../src/tools/registry.js';
import { registerBuiltinTools } from '../../src/tools/builtin/index.js';

const base = {
  name: 'demo',
  description: 'demo tool',
  input: z.object({ x: z.number() }),
  execute: async (input: { x: number }) => ({ output: { x: input.x } }),
};

describe('tool registry', () => {
  it('rejects a tool without a blast radius', () => {
    const registry = new ToolRegistry();
    const tool = { ...base } as unknown as Tool<{ x: number }>;
    expect(() => {
      registry.register(tool);
    }).toThrow(ToolRegistrationError);
    expect(() => {
      registry.register(tool);
    }).toThrow(/blastRadius is required/);
    expect(registry.has('demo')).toBe(false);
  });

  it('rejects an invalid blast radius value', () => {
    const registry = new ToolRegistry();
    const tool = { ...base, blastRadius: 'mostly-harmless' } as unknown as Tool<{ x: number }>;
    expect(() => {
      registry.register(tool);
    }).toThrow(/must be one of reversible \| costly \| irreversible/);
  });

  it('rejects a costly tool that cannot estimate its cost', () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.register(defineTool({ ...base, blastRadius: 'costly' }));
    }).toThrow(/estimateCostUsd/);
  });

  it('rejects duplicates and bad names', () => {
    const registry = new ToolRegistry();
    registry.register(defineTool({ ...base, blastRadius: 'reversible' }));
    expect(() => {
      registry.register(defineTool({ ...base, blastRadius: 'reversible' }));
    }).toThrow(/already registered/);
    expect(() => {
      registry.register(defineTool({ ...base, name: 'Bad Name', blastRadius: 'reversible' }));
    }).toThrow(/invalid name/);
  });

  it('snapshots definitions with JSON schema input and the blast radius', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    registry.register(defineTool({ ...base, blastRadius: 'irreversible', version: '2' }));
    const defs = registry.definitions();
    expect(defs.map((d) => d.name)).toEqual(['demo', 'echo', 'sleep']);
    const demo = defs.find((d) => d.name === 'demo');
    expect(demo?.blastRadius).toBe('irreversible');
    expect(demo?.version).toBe('2');
    expect(demo?.inputSchema).toMatchObject({
      type: 'object',
      properties: { x: { type: 'number' } },
    });
  });
});
