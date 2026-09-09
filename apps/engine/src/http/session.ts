import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Secret } from '../config.js';

export const SESSION_COOKIE = 'marsad_session';

export interface SessionClaims {
  sid: string;
  iat: number;
  exp: number;
}

function sign(payload: string, secret: Secret): string {
  return createHmac('sha256', secret.reveal()).update(payload).digest('base64url');
}

/** Stateless signed session. Rotating SESSION_SECRET invalidates every cookie at once. */
export function issueSession(
  secret: Secret,
  ttlMs: number,
  now: Date,
): { value: string; claims: SessionClaims } {
  const claims: SessionClaims = {
    sid: randomUUID(),
    iat: now.getTime(),
    exp: now.getTime() + ttlMs,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { value: `${payload}.${sign(payload, secret)}`, claims };
}

export function verifySession(
  secret: Secret,
  value: string | undefined,
  now: Date,
): SessionClaims | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const c = claims as Partial<SessionClaims>;
  if (typeof c.sid !== 'string' || typeof c.iat !== 'number' || typeof c.exp !== 'number')
    return null;
  if (c.exp <= now.getTime()) return null;
  return { sid: c.sid, iat: c.iat, exp: c.exp };
}
