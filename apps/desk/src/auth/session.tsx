import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiRequestError, describeError, onUnauthorized } from '../api/client.js';
import { getSession, login as loginRequest, logout as logoutRequest } from '../api/endpoints.js';
import { LoginForm } from './LoginForm.js';

export type AuthState =
  | { kind: 'checking' }
  | { kind: 'signed-in'; expiresAt: string | null }
  | { kind: 'signed-out'; notice: string | null }
  | { kind: 'unreachable'; detail: string };

interface SessionApi {
  expiresAt: string | null;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside AuthGate');
  return ctx;
}

/** setTimeout saturates above 2^31-1 ms; a 12h session is well inside, but clamp anyway. */
const MAX_TIMEOUT_MS = 2_147_483_647;

function stateForFailure(err: unknown): AuthState {
  if (err instanceof ApiRequestError && err.status === 401) {
    return { kind: 'signed-out', notice: null };
  }
  return { kind: 'unreachable', detail: describeError(err) };
}

/**
 * The auth gate. Nothing behind it renders until GET /auth/session says the cookie is valid;
 * a 401 from any later request, or the session's own expiry, drops straight back to the form.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(
      (session) => {
        setState({ kind: 'signed-in', expiresAt: session.expiresAt });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setState(stateForFailure(err));
      },
    );
    return () => {
      controller.abort();
    };
  }, [attempt]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setState((s) =>
          s.kind === 'signed-in' ? { kind: 'signed-out', notice: 'Session expired.' } : s,
        );
      }),
    [],
  );

  const expiresAt = state.kind === 'signed-in' ? state.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, new Date(expiresAt).getTime() - Date.now()));
    const timer = setTimeout(() => {
      setState({ kind: 'signed-out', notice: 'Session expired.' });
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [expiresAt]);

  const signIn = useCallback(async (password: string) => {
    const { expiresAt: exp } = await loginRequest(password);
    setState({ kind: 'signed-in', expiresAt: exp });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setState({ kind: 'signed-out', notice: 'Signed out.' });
    }
  }, []);

  const api = useMemo<SessionApi>(() => ({ expiresAt, signOut }), [expiresAt, signOut]);

  switch (state.kind) {
    case 'checking':
      return (
        <div className="gate" role="status" aria-live="polite">
          <p className="gate__note">Checking session</p>
        </div>
      );
    case 'unreachable':
      return (
        <div className="gate">
          <div className="panel gate__panel" role="alert">
            <h1 className="gate__brand">MARSAD</h1>
            <p className="gate__note">Engine unreachable: {state.detail}.</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setState({ kind: 'checking' });
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </button>
          </div>
        </div>
      );
    case 'signed-out':
      return <LoginForm notice={state.notice} onSubmit={signIn} />;
    case 'signed-in':
      return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
  }
}
