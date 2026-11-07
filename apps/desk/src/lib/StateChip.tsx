import type { RunStatus } from '@marsad/shared';

/**
 * The one place uppercase is allowed: a machine state. Colour comes from the matching
 * `--state-*` token and is spent on nothing else in the desk.
 */
export function StateChip({ status, idle = false }: { status: RunStatus | null; idle?: boolean }) {
  if (status === null) {
    return (
      <span className="chip-state" data-state="none">
        {idle ? 'idle' : '—'}
      </span>
    );
  }
  return (
    <span className="chip-state" data-state={status}>
      {status}
    </span>
  );
}
