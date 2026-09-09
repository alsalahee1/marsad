import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV_KEYS, Secret, loadConfig } from '../../src/config.js';
import { testEnv } from '../support/fixtures.js';

describe('config loader', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(testEnv());
    expect(config.port).toBe(8080);
    expect(config.corsOrigins).toEqual(['http://localhost:5173']);
    expect(config.ceilings).toEqual({ maxSteps: 10, maxTokens: 10_000, maxWallClockMs: 60_000 });
    expect(config.budget).toEqual({ perRunUsd: 1, perDayUsd: 5, perDayCalls: 100 });
    expect(config.model.anthropicApiKey).toBeUndefined();
    expect(config.model.agentModel).toBeUndefined();
    expect(config.trustProxy).toBe(false);
  });

  it('names every missing key', () => {
    expect(() => loadConfig(testEnv({ SESSION_SECRET: undefined, MYSQL_HOST: undefined }))).toThrow(
      ConfigError,
    );
    try {
      loadConfig(testEnv({ SESSION_SECRET: undefined, MYSQL_HOST: undefined }));
    } catch (err) {
      const e = err as ConfigError;
      expect(e.problems).toContain('SESSION_SECRET: missing');
      expect(e.problems).toContain('MYSQL_HOST: missing');
      expect(e.problems).toHaveLength(2);
    }
  });

  it('names a malformed key and an empty key', () => {
    const attempt = (overrides: Record<string, string | undefined>) => {
      try {
        loadConfig(testEnv(overrides));
        return [];
      } catch (err) {
        return (err as ConfigError).problems;
      }
    };
    expect(attempt({ PORT: 'eighty' })[0]).toMatch(/^PORT: /);
    expect(attempt({ MYSQL_PASSWORD: '' })).toEqual(['MYSQL_PASSWORD: empty']);
    expect(attempt({ SESSION_SECRET: 'short' })[0]).toMatch(/^SESSION_SECRET: /);
    expect(attempt({ OPERATOR_PASSWORD_HASH: 'hunter2' })[0]).toMatch(/argon2id/);
    expect(attempt({ BUDGET_PER_RUN_USD: '-1' })[0]).toMatch(/^BUDGET_PER_RUN_USD: /);
  });

  it('rejects "*" and non-origin values for CORS_ORIGINS', () => {
    expect(() => loadConfig(testEnv({ CORS_ORIGINS: '*' }))).toThrow(/CORS_ORIGINS/);
    expect(() => loadConfig(testEnv({ CORS_ORIGINS: 'http://a.example,*' }))).toThrow(
      /CORS_ORIGINS/,
    );
    expect(() => loadConfig(testEnv({ CORS_ORIGINS: 'https://desk.example/path' }))).toThrow(
      /CORS_ORIGINS/,
    );
    expect(() => loadConfig(testEnv({ CORS_ORIGINS: '' }))).toThrow(/CORS_ORIGINS/);
    expect(
      loadConfig(testEnv({ CORS_ORIGINS: 'https://desk.example, http://localhost:5173' }))
        .corsOrigins,
    ).toEqual(['https://desk.example', 'http://localhost:5173']);
  });

  it('refuses TRUST_PROXY=true', () => {
    expect(() => loadConfig(testEnv({ TRUST_PROXY: 'true' }))).toThrow(/TRUST_PROXY/);
    expect(loadConfig(testEnv({ TRUST_PROXY: '1' })).trustProxy).toBe(1);
    expect(loadConfig(testEnv({ TRUST_PROXY: '10.0.0.0/8' })).trustProxy).toBe('10.0.0.0/8');
  });

  it('never exposes secrets through JSON, string conversion or inspect', () => {
    const config = loadConfig(
      testEnv({ MYSQL_PASSWORD: 'hunter2-db', SESSION_SECRET: 'x'.repeat(40) }),
    );
    const json = JSON.stringify(config);
    expect(json).not.toContain('hunter2-db');
    expect(json).not.toContain('x'.repeat(40));
    expect(json).not.toContain('$argon2id');
    expect(String(config.mysql.password)).toBe('[redacted]');
    expect(inspect(config)).not.toContain('hunter2-db');
    expect(config.mysql.password).toBeInstanceOf(Secret);
    expect(config.mysql.password.reveal()).toBe('hunter2-db');
  });

  it('parses exactly the keys documented in .env.example', () => {
    const example = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');
    const documented = example
      .split('\n')
      .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined);
    expect([...documented].sort()).toEqual([...ENV_KEYS].sort());
  });
});
