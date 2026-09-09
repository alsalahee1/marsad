import { HaltIcon, ResumeIcon } from '../lib/Icons.js';
import { formatClock } from '../lib/format.js';
import { useSystem } from '../system/systemState.js';

interface HaltControlProps {
  variant: 'rail' | 'nav' | 'bar' | 'panel';
  showLabel?: boolean;
}

/**
 * The global halt (CLAUDE.md §2.3): one tap from any screen. The same control shows "Resume"
 * once the system is halted, so the operator always has the opposite action under the thumb.
 * Colour here is the `halted` run-state token: the action puts every run into that state.
 */
export function HaltControl({ variant, showLabel = true }: HaltControlProps) {
  const { state, pending, halt, resume } = useSystem();
  const halted = state?.halted === true;
  const busy = pending !== null;
  const label = halted ? 'Resume' : 'Halt all';
  const onClick = () => {
    void (halted ? resume() : halt());
  };
  return (
    <button
      type="button"
      className={`halt-btn halt-btn--${variant} ${halted ? 'halt-btn--resume' : ''}`.trim()}
      onClick={onClick}
      disabled={busy || state === null}
      aria-label={showLabel ? undefined : label}
      title={showLabel ? undefined : label}
      aria-busy={busy}
    >
      {halted ? <ResumeIcon /> : <HaltIcon />}
      {showLabel && (
        <span className="halt-btn__label">
          {pending === 'halt' ? 'Halting' : pending === 'resume' ? 'Resuming' : label}
        </span>
      )}
    </button>
  );
}

/** Phone: sticky in the thumb zone, above the tab bar. Shows why the system is halted. */
export function HaltBar() {
  const { state, error } = useSystem();
  return (
    <div className="app-haltbar">
      {state?.halted === true && (
        <p className="app-haltbar__status">
          Halted{state.haltedAt ? ' at ' : ''}
          {state.haltedAt && <time dateTime={state.haltedAt}>{formatClock(state.haltedAt)}</time>}
          {state.reason ? ` · ${state.reason}` : ''}
        </p>
      )}
      {error !== null && (
        <p className="app-haltbar__status" role="alert">
          {error}
        </p>
      )}
      <HaltControl variant="bar" />
    </div>
  );
}

/** Every layout but phone: a banner across the content while the system is halted. */
export function HaltBanner() {
  const { state, error } = useSystem();
  if (state?.halted !== true && error === null) return null;
  return (
    <div className="halt-banner" role="status">
      {state?.halted === true ? (
        <span>
          System halted
          {state.haltedAt && (
            <>
              {' at '}
              <time dateTime={state.haltedAt}>{formatClock(state.haltedAt)}</time>
            </>
          )}
          {state.reason ? ` · ${state.reason}` : ''}. Workers stop before their next step; queued
          runs are marked halted.
        </span>
      ) : (
        <span>{error}</span>
      )}
    </div>
  );
}
