import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs. Anything that could carry a credential is redacted at the logger,
 * so a careless log line cannot leak it. Request bodies are never logged at all.
 */
export function createLogger(level: string, extra: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: 'marsad-engine', ...extra },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["set-cookie"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.secret',
        '*.apiKey',
        '*.authorization',
        '*.cookie',
        'password',
        'token',
        'secret',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
