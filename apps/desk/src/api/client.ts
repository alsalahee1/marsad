import { ApiErrorSchema } from '@marsad/shared';
import { apiUrl } from './base.js';

/** An HTTP response the engine answered with an error body (`{ error: { code, message } }`). */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

/** The engine could not be reached at all (DNS, refused, CORS, offline). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';

  constructor(cause: unknown) {
    super('engine unreachable', { cause });
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Fires whenever any request other than the login itself comes back 401: the session cookie
 * expired or the secret rotated. The auth gate subscribes and drops back to the login form.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Every call to the engine goes through here: same-site cookie included, JSON in and out,
 * errors mapped to {@link ApiRequestError} / {@link NetworkError}. The caller validates the
 * successful body with a schema; this function only promises it is parsed JSON (or nothing).
 */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<unknown> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }

  if (response.status === 204) return undefined;

  let parsed: unknown = undefined;
  const text = await response.text();
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (response.ok) return parsed;

  if (response.status === 401 && path !== '/auth/login') {
    for (const listener of unauthorizedListeners) listener();
  }
  const known = ApiErrorSchema.safeParse(parsed);
  if (known.success) {
    const { code, message, issues } = known.data.error;
    throw new ApiRequestError(response.status, code, message, issues ?? []);
  }
  throw new ApiRequestError(
    response.status,
    `http_${response.status}`,
    response.statusText || `request failed with status ${response.status}`,
  );
}

/** A one-line operator-facing description of any failure this module can throw. */
export function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof NetworkError) return 'engine unreachable';
  if (err instanceof Error) return err.message;
  return 'unknown error';
}
