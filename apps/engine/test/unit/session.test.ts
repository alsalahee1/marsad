import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config.js';
import { issueSession, verifySession } from '../../src/http/session.js';

describe('signed session cookie', () => {
  const secret = new Secret('s'.repeat(40));
  const now = new Date('2026-09-09T10:00:00Z');

  it('round-trips and expires', () => {
    const { value, claims } = issueSession(secret, 1000, now);
    expect(verifySession(secret, value, now)).toEqual(claims);
    expect(verifySession(secret, value, new Date(now.getTime() + 1000))).toBeNull();
  });

  it('rejects tampering and a different secret', () => {
    const { value } = issueSession(secret, 1000, now);
    const [payload, sig] = value.split('.');
    expect(verifySession(secret, `${payload}x.${sig}`, now)).toBeNull();
    expect(verifySession(secret, `${payload}.${sig}x`, now)).toBeNull();
    expect(verifySession(new Secret('t'.repeat(40)), value, now)).toBeNull();
    expect(verifySession(secret, undefined, now)).toBeNull();
    expect(verifySession(secret, 'garbage', now)).toBeNull();
  });
});
