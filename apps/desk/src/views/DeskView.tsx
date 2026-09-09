import type { Event } from '@marsad/shared';
import { useCallback, useState } from 'react';
import { API_BASE } from '../api/base.js';
import { useSession } from '../auth/session.js';
import { Overlay } from '../lib/Overlay.js';
import { Panel } from '../lib/Panel.js';
import { formatClock, formatDateTime } from '../lib/format.js';
import { useFlashOnChange } from '../lib/useFlash.js';
import { EventDetail } from '../log/EventDetail.js';
import { ConnectionIndicator, EventLogPanel } from '../log/EventLogPanel.js';
import { useEventStream, useSelection } from '../log/EventStreamProvider.js';
import { HaltControl } from '../shell/HaltControl.js';
import type { Viewport } from '../shell/viewport.js';
import { useSystem } from '../system/systemState.js';

function SystemPanel() {
  const { state, error } = useSystem();
  const { snapshot } = useEventStream();
  const { expiresAt } = useSession();
  const haltedFlash = useFlashOnChange<HTMLSpanElement>(state?.halted);
  return (
    <Panel title="System" className="system-panel">
      <dl className="kv">
        <dt>Global halt</dt>
        <dd>
          <span ref={haltedFlash} className="kv__value">
            {state === null
              ? (error ?? 'Reading')
              : state.halted
                ? `Halted${state.reason ? ` · ${state.reason}` : ''}`
                : 'Not halted'}
          </span>
          {state?.haltedAt && (
            <span className="kv__sub">
              since <time dateTime={state.haltedAt}>{formatDateTime(state.haltedAt)}</time>
            </span>
          )}
        </dd>
        <dt>Stream</dt>
        <dd>
          <ConnectionIndicator state={snapshot.connection} />
        </dd>
        <dt>Engine</dt>
        <dd className="num kv__wrap">{API_BASE}</dd>
        <dt>Session</dt>
        <dd>
          {expiresAt ? (
            <>
              until <time dateTime={expiresAt}>{formatClock(expiresAt)}</time>
            </>
          ) : (
            'open'
          )}
        </dd>
      </dl>
      <div className="system-panel__action">
        <HaltControl variant="panel" />
      </div>
    </Panel>
  );
}

/**
 * Home. The log is the foundation, so it takes most of the grid; the system panel answers
 * "is anything stopped" and holds the halt switch.
 */
export function DeskView({ viewport }: { viewport: Viewport }) {
  const { selected, select } = useSelection();
  const [openEvent, setOpenEvent] = useState<Event | null>(null);
  const onOpen = useCallback(
    (event: Event) => {
      if (viewport !== 'wide') setOpenEvent(event);
    },
    [viewport],
  );
  const close = useCallback(() => {
    setOpenEvent(null);
  }, []);
  const tapOpens = viewport === 'phone';

  return (
    <div className="view view--desk">
      <SystemPanel />
      <EventLogPanel onOpen={onOpen} />
      {openEvent !== null && viewport !== 'wide' && (
        <Overlay mode={tapOpens ? 'sheet' : 'dialog'} title="Event" onClose={close}>
          <EventDetail event={openEvent} />
        </Overlay>
      )}
      {tapOpens && selected !== null && openEvent === null && (
        <TapToOpen
          onOpen={() => {
            setOpenEvent(selected);
          }}
          onDismiss={() => {
            select(null);
          }}
        />
      )}
    </div>
  );
}

/** Phone: a selected row shows this strip so a single tap opens the sheet. */
function TapToOpen({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="tap-strip" role="status">
      <button type="button" className="btn btn--primary" onClick={onOpen}>
        Open event
      </button>
      <button type="button" className="btn" onClick={onDismiss}>
        Clear
      </button>
    </div>
  );
}
