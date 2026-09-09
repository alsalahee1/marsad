import { EventDetail } from '../log/EventDetail.js';
import { useSelection } from '../log/EventStreamProvider.js';

/** Wide (1440+): the 380px trailing pane. Whatever is selected anywhere shows here. */
export function Inspector() {
  const { selected } = useSelection();
  return (
    <aside className="app-inspector" aria-label="Inspector">
      <header className="inspector__head">
        <h2 className="inspector__title">Inspector</h2>
      </header>
      <div className="inspector__body">
        {selected ? (
          <EventDetail event={selected} />
        ) : (
          <p className="inspector__empty">Select an event to inspect it.</p>
        )}
      </div>
    </aside>
  );
}
