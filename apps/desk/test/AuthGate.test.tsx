import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, useSession } from '../src/auth/session.js';

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function Inside() {
  const { expiresAt } = useSession();
  return <p>signed in until {expiresAt}</p>;
}

describe('AuthGate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the login form on 401, signs in with the password, then renders children', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/auth/session'))
        return Promise.resolve(respond(401, { error: { code: 'unauthorized', message: 'no' } }));
      if (url.endsWith('/auth/login')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          password: string;
        };
        return Promise.resolve(
          body.password === 'hunter2'
            ? respond(200, { ok: true, expiresAt: '2026-09-09T22:00:00.000Z' })
            : respond(401, { error: { code: 'invalid_credentials', message: 'invalid password' } }),
        );
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });

    render(
      <AuthGate>
        <Inside />
      </AuthGate>,
    );
    const input = await screen.findByLabelText('Operator password');
    expect(calls[0]?.init?.credentials).toBe('include');

    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.');
    expect((input as HTMLInputElement).value).toBe('');

    fireEvent.change(input, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/signed in until 2026-09-09T22:00:00.000Z/)).toBeTruthy();
    expect(document.querySelector('input[type=password]')).toBeNull();
  });

  it('renders children straight away when the session cookie is valid, and drops on a later 401', async () => {
    let sessionStatus = 200;
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/auth/session'))
        return Promise.resolve(
          sessionStatus === 200
            ? respond(200, { authenticated: true, expiresAt: null })
            : respond(401, { error: { code: 'unauthorized', message: 'no' } }),
        );
      return Promise.resolve(respond(401, { error: { code: 'unauthorized', message: 'no' } }));
    });
    render(
      <AuthGate>
        <Inside />
      </AuthGate>,
    );
    await screen.findByText(/signed in until/);
    sessionStatus = 401;
    const { apiFetch } = await import('../src/api/client.js');
    await apiFetch('/system').catch(() => undefined);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Session expired.');
    });
  });

  it('offers a retry when the engine is unreachable', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(respond(200, { authenticated: true, expiresAt: null }));
    });
    render(
      <AuthGate>
        <Inside />
      </AuthGate>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Engine unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/signed in until/);
  });
});
