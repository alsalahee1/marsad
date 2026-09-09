import { LoginRequestSchema } from '@marsad/shared';
import { useId, useState, type SyntheticEvent } from 'react';
import { ApiRequestError, describeError } from '../api/client.js';

interface LoginFormProps {
  notice: string | null;
  onSubmit: (password: string) => Promise<void>;
}

/**
 * Single-operator login. The password lives in component state for the duration of the
 * request only, is never persisted, and is cleared whether the attempt succeeds or fails.
 */
export function LoginForm({ notice, onSubmit }: LoginFormProps) {
  const inputId = useId();
  const errorId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = LoginRequestSchema.safeParse({ password });
    if (!parsed.success) {
      setError('Enter the operator password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed.data.password);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) setError('Wrong password.');
      else if (err instanceof ApiRequestError && err.status === 429)
        setError('Too many attempts. Wait 15 minutes.');
      else setError(describeError(err));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form
        className="panel gate__panel"
        onSubmit={(e) => {
          void submit(e);
        }}
        aria-describedby={error ? errorId : undefined}
      >
        <h1 className="gate__brand">MARSAD</h1>
        <p className="gate__sub">Agent operations desk</p>
        {notice !== null && (
          <p className="gate__note" role="status">
            {notice}
          </p>
        )}
        <label className="field__label" htmlFor={inputId}>
          Operator password
        </label>
        <input
          id={inputId}
          className="field__input"
          type="password"
          name="password"
          autoComplete="current-password"
          autoCapitalize="off"
          spellCheck={false}
          required
          maxLength={1024}
          value={password}
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          aria-invalid={error !== null}
        />
        {error !== null && (
          <p id={errorId} className="field__error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
