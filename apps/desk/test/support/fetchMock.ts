import { vi } from 'vitest';

export type Handler = (init: RequestInit | undefined, url: URL) => unknown;

export function respond(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A fetch stub keyed on `METHOD /path` (query string ignored). A handler returns a body (200),
 * a Response, or throws. Every call is recorded for assertions.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; search: string; body: unknown }[] = [];
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) {
      return Promise.resolve(
        respond(404, {
          error: { code: 'not_found', message: `no mock for ${method} ${url.pathname}` },
        }),
      );
    }
    try {
      const out = handler(init, url);
      return Promise.resolve(out instanceof Response ? out : respond(200, out));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
