import type { Event } from '@marsad/shared';
import { useCallback, useState } from 'react';
import { Overlay } from '../lib/Overlay.js';
import { EventDetail } from '../log/EventDetail.js';
import { EventLogPanel } from '../log/EventLogPanel.js';
import { useSelection } from '../log/EventStreamProvider.js';
import type { Viewport } from '../shell/viewport.js';

/**
 * The log, full height. Tablet and desktop pair the list with a detail pane; fold stacks them;
 * wide hands detail to the inspector; phone opens a full-screen sheet.
 */
export function LogView({ viewport }: { viewport: Viewport }) {
  const { selected, select } = useSelection();
  const [sheet, setSheet] = useState<Event | null>(null);
  const onOpen = useCallback(
    (event: Event) => {
      if (viewport === 'phone') setSheet(event);
    },
    [viewport],
  );
  const closeSheet = useCallback(() => {
    setSheet(null);
  }, []);
  const paned = viewport === 'fold' || viewport === 'tablet' || viewport === 'desktop';

  return (
    <div className={`view view--log ${paned ? 'list-detail' : ''}`.trim()}>
      <EventLogPanel onOpen={onOpen} />
      {paned && (
        <aside className="panel detail-pane" aria-label="Event detail">
          {selected ? (
            <EventDetail event={selected} />
          ) : (
            <p className="inspector__empty">Select an event to see its payload.</p>
          )}
        </aside>
      )}
      {viewport === 'phone' && sheet !== null && (
        <Overlay mode="sheet" title="Event" onClose={closeSheet}>
          <EventDetail event={sheet} />
        </Overlay>
      )}
      {viewport === 'phone' && selected !== null && sheet === null && (
        <div className="tap-strip" role="status">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setSheet(selected);
            }}
          >
            Open event
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              select(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
