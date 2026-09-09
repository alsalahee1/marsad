import { randomUUID } from 'node:crypto';
import { parseCookie } from 'cookie';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type z } from 'zod';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { HttpError, unauthorized } from '../errors.js';
import type { Logger } from '../logger.js';
import { SESSION_COOKIE, verifySession, type SessionClaims } from './session.js';

/** Typed view of res.locals for this app. */
export interface AppLocals {
  session?: SessionClaims;
  requestId?: string;
}

export function locals(res: Response): AppLocals {
  return res.locals as AppLocals;
}

export function requireSession(config: Config, clock: Clock): RequestHandler {
  return (req, res, next) => {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const claims = verifySession(config.auth.sessionSecret, cookies[SESSION_COOKIE], clock());
    if (!claims) {
      next(unauthorized());
      return;
    }
    locals(res).session = claims;
    next();
  };
}

export class ValidationError extends HttpError {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(400, 'validation', 'request failed validation');
  }
}

/** Parse with a zod schema or throw a 400 whose body names each bad field. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

export function requestLogger(log: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const requestId = randomUUID();
    locals(res).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Path and status only. Never headers, never bodies.
      log.info(
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(ms),
        },
        'request',
      );
    });
    next();
  };
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => {
    next(new HttpError(404, 'not_found', 'route not found'));
  };
}

export function errorHandler(log: Logger, isProduction: boolean) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: { code: err.code, message: err.message, issues: err.issues } });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const e = err as { type?: string; status?: number } | null;
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'payload_too_large', message: 'body exceeds 256kb' } });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_json', message: 'body is not valid JSON' } });
      return;
    }
    const requestId = locals(res).requestId ?? 'unknown';
    log.error({ err, requestId }, 'unhandled error');
    res.status(500).json({
      error: {
        code: 'internal',
        message: isProduction ? 'internal error' : `internal error (${requestId})`,
      },
    });
  };
}
