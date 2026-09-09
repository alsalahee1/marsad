import {
  EventSchema,
  LoginRequestSchema,
  SystemStateSchema,
  type Event,
  type SystemState,
} from '@marsad/shared';
import { z } from 'zod';
import { apiFetch } from './client.js';

/**
 * Typed calls, one per route the desk uses. Every response body is validated at the boundary
 * so a drifted engine fails loudly here instead of somewhere in a render.
 */

const SessionResponseSchema = z.object({
  authenticated: z.literal(true),
  expiresAt: z.iso.datetime().nullable(),
});
export type SessionInfo = z.infer<typeof SessionResponseSchema>;

const LoginResponseSchema = z.object({ ok: z.literal(true), expiresAt: z.iso.datetime() });

const HaltResponseSchema = z.object({
  halted: z.literal(true),
  drainedJobs: z.int().nonnegative(),
  haltedRuns: z.array(z.string()),
});
export type HaltResult = z.infer<typeof HaltResponseSchema>;

const EventsResponseSchema = z.object({ events: z.array(EventSchema) });

export async function getSession(signal?: AbortSignal): Promise<SessionInfo> {
  return SessionResponseSchema.parse(await apiFetch('/auth/session', signal ? { signal } : {}));
}

export async function login(password: string): Promise<{ expiresAt: string }> {
  const body = LoginRequestSchema.parse({ password });
  const res = LoginResponseSchema.parse(await apiFetch('/auth/login', { method: 'POST', body }));
  return { expiresAt: res.expiresAt };
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST' });
}

export async function getSystem(signal?: AbortSignal): Promise<SystemState> {
  return SystemStateSchema.parse(await apiFetch('/system', signal ? { signal } : {}));
}

export async function haltAll(reason = 'operator'): Promise<HaltResult> {
  return HaltResponseSchema.parse(await apiFetch('/halt', { method: 'POST', body: { reason } }));
}

export async function resumeAll(): Promise<void> {
  await apiFetch('/resume', { method: 'POST', body: {} });
}

export async function getEventsTail(
  limit: number,
  before?: string,
  signal?: AbortSignal,
): Promise<Event[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', before);
  const res = await apiFetch(`/events/tail?${params.toString()}`, signal ? { signal } : {});
  return EventsResponseSchema.parse(res).events;
}
