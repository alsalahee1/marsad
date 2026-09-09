import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NetworkError, apiFetch, onUnauthorized } from '../src/api/client.js';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends credentials on every request and JSON on POST', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(respond(200, { ok: true })));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/halt', { method: 'POST', body: { reason: 'operator' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/halt$/);
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"reason":"operator"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('maps an engine error body to ApiRequestError with its code and issues', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        respond(400, {
          error: {
            code: 'validation',
            message: 'request failed validation',
            issues: [{ path: 'before', message: 'invalid' }],
          },
        }),
      ),
    );
    const err = await apiFetch('/events/tail?before=x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    if (!(err instanceof ApiRequestError)) throw new Error('type');
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation');
    expect(err.issues).toEqual([{ path: 'before', message: 'invalid' }]);
  });

  it('notifies unauthorized listeners on a 401 from any route but the login itself', async () => {
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(respond(401, { error: { code: 'unauthorized', message: 'nope' } })),
    );
    await expect(apiFetch('/auth/login', { method: 'POST', body: {} })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(listener).not.toHaveBeenCalled();
    await expect(apiFetch('/events')).rejects.toBeInstanceOf(ApiRequestError);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('wraps a failed fetch as NetworkError and passes 204 through as undefined', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiFetch('/system')).rejects.toBeInstanceOf(NetworkError);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 204 })));
    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});
