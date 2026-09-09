/**
 * Where the engine lives. Only `VITE_*` keys reach the bundle, and this is the only one: the
 * desk carries no credential of any kind.
 *
 * Defaults: the engine's dev origin in `pnpm dev`, a same-origin `/api` prefix in a production
 * build (Nginx strips it and proxies to the engine, so the SameSite=Strict cookie is first-party).
 */
function resolveBase(): string {
  const configured = import.meta.env.VITE_API_BASE?.trim();
  const base = configured !== undefined && configured !== '' ? configured : defaultBase();
  return base.replace(/\/+$/, '');
}

function defaultBase(): string {
  return import.meta.env.DEV ? 'http://localhost:8080' : '/api';
}

export const API_BASE = resolveBase();

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
