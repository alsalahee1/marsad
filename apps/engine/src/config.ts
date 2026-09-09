import { z } from 'zod';

/**
 * A credential. Wrapping every secret means an accidental `JSON.stringify(config)`,
 * a template literal, or `util.inspect` prints `[redacted]` instead of the value.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([redacted])';
  }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const integer = (min: number, max: number) =>
  z.string().regex(/^\d+$/, 'must be an integer').transform(Number).pipe(z.int().min(min).max(max));

const positiveInt = integer(1, Number.MAX_SAFE_INTEGER);
const port = integer(1, 65_535);

const usd = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a decimal amount with at most 6 fraction digits')
  .transform(Number)
  .pipe(z.number().positive());

const secret = (min: number) =>
  z
    .string()
    .min(min)
    .transform((v) => new Secret(v));

/** Empty string means "not configured". Only the keys the agent loop needs are allowed to be empty. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const origins = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z.string().refine((o) => {
          if (o === '*') return false;
          try {
            return new URL(o).origin === o;
          } catch {
            return false;
          }
        }, 'must be an exact origin (scheme://host[:port]) and never "*"'),
      )
      .min(1, 'must list at least one origin'),
  );

const trustProxy = z
  .string()
  .refine(
    (v) => v !== 'true',
    'never "true": trusting every proxy makes the login rate-limit spoofable',
  )
  .refine(
    (v) =>
      /^(false|loopback|linklocal|uniquelocal|\d+|[0-9a-fA-F.:/]+(,\s*[0-9a-fA-F.:/]+)*)$/.test(v),
    'must be false, loopback, linklocal, uniquelocal, a hop count, or a list of IPs/CIDRs',
  )
  .transform((v): boolean | number | string => {
    if (v === 'false') return false;
    if (/^\d+$/.test(v)) return Number(v);
    return v;
  });

/** Every key in .env.example, in the same order. A test asserts the two never drift. */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS),
  PORT: port,
  CORS_ORIGINS: origins,
  TRUST_PROXY: trustProxy.default('loopback'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  MYSQL_HOST: z.string().min(1),
  MYSQL_PORT: port,
  MYSQL_DATABASE: z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'must be a plain identifier'),
  MYSQL_USER: z.string().min(1).max(32),
  MYSQL_PASSWORD: secret(1),
  MYSQL_APP_USER_HOST: z.string().min(1).max(255).default('%'),
  MYSQL_MIGRATE_USER: z.string().min(1).max(32),
  MYSQL_MIGRATE_PASSWORD: secret(1),

  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\/.+/, 'must be a redis:// or rediss:// URL')
    .transform((v) => new Secret(v)),

  SESSION_SECRET: secret(32),
  SESSION_TTL_MS: positiveInt.default(43_200_000),
  OPERATOR_PASSWORD_HASH: z
    .string()
    .regex(
      /^\$argon2id\$v=19\$[mtp]=\d+(,[mtp]=\d+){2}\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
      'must be an argon2id PHC string (generate one with `pnpm --filter @marsad/engine hash-password`)',
    )
    .transform((v) => new Secret(v)),

  RUN_MAX_STEPS: positiveInt,
  RUN_MAX_TOKENS: positiveInt,
  RUN_MAX_WALL_CLOCK_MS: positiveInt,

  BUDGET_PER_RUN_USD: usd,
  BUDGET_PER_DAY_USD: usd,
  BUDGET_PER_DAY_CALLS: positiveInt,
  APPROVAL_TOKEN_TTL_MS: positiveInt.default(600_000),

  ANTHROPIC_API_KEY: optionalString.transform((v) => (v === undefined ? undefined : new Secret(v))),
  AGENT_MODEL: optionalString,
});

export type EnvKey = keyof z.infer<typeof EnvSchema>;
export const ENV_KEYS = Object.keys(EnvSchema.shape) as readonly EnvKey[];

export interface Config {
  readonly env: (typeof NODE_ENVS)[number];
  readonly isProduction: boolean;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: boolean | number | string;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly mysql: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: Secret;
    readonly appUserHost: string;
    readonly migrateUser: string;
    readonly migratePassword: Secret;
  };
  readonly redisUrl: Secret;
  readonly auth: {
    readonly sessionSecret: Secret;
    readonly sessionTtlMs: number;
    readonly operatorPasswordHash: Secret;
  };
  readonly ceilings: {
    readonly maxSteps: number;
    readonly maxTokens: number;
    readonly maxWallClockMs: number;
  };
  readonly budget: {
    readonly perRunUsd: number;
    readonly perDayUsd: number;
    readonly perDayCalls: number;
  };
  readonly approvals: {
    readonly tokenTtlMs: number;
  };
  /** Reserved for the agent loop (next session). Absent until configured. */
  readonly model: {
    readonly anthropicApiKey: Secret | undefined;
    readonly agentModel: string | undefined;
  };
}

/**
 * Parse process.env (or any record) into a typed Config. Throws ConfigError naming every
 * missing or malformed key. Never logs values.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '?');
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = env[key];
      if (raw === undefined) problems.push(`${key}: missing`);
      else if (raw.trim() === '') problems.push(`${key}: empty`);
      else problems.push(`${key}: ${issue.message}`);
    }
    throw new ConfigError(problems);
  }
  const e = result.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    mysql: {
      host: e.MYSQL_HOST,
      port: e.MYSQL_PORT,
      database: e.MYSQL_DATABASE,
      user: e.MYSQL_USER,
      password: e.MYSQL_PASSWORD,
      appUserHost: e.MYSQL_APP_USER_HOST,
      migrateUser: e.MYSQL_MIGRATE_USER,
      migratePassword: e.MYSQL_MIGRATE_PASSWORD,
    },
    redisUrl: e.REDIS_URL,
    auth: {
      sessionSecret: e.SESSION_SECRET,
      sessionTtlMs: e.SESSION_TTL_MS,
      operatorPasswordHash: e.OPERATOR_PASSWORD_HASH,
    },
    ceilings: {
      maxSteps: e.RUN_MAX_STEPS,
      maxTokens: e.RUN_MAX_TOKENS,
      maxWallClockMs: e.RUN_MAX_WALL_CLOCK_MS,
    },
    budget: {
      perRunUsd: e.BUDGET_PER_RUN_USD,
      perDayUsd: e.BUDGET_PER_DAY_USD,
      perDayCalls: e.BUDGET_PER_DAY_CALLS,
    },
    approvals: { tokenTtlMs: e.APPROVAL_TOKEN_TTL_MS },
    model: { anthropicApiKey: e.ANTHROPIC_API_KEY, agentModel: e.AGENT_MODEL },
  };
}
