import { HaltControl } from './HaltControl.js';
import { DESTINATIONS, type Destination } from './navigation.js';

interface TopNavProps {
  current: Destination;
  onNavigate: (dest: Destination) => void;
}

/** Fold layout: one column with the destinations across the top and halt on the trailing side. */
export function TopNav({ current, onNavigate }: TopNavProps) {
  return (
    <nav className="app-topnav" aria-label="Primary">
      <span className="topnav-brand" aria-hidden="true">
        M
      </span>
      <ul className="topnav-list">
        {DESTINATIONS.map((d) => {
          const Icon = d.icon;
          return (
            <li key={d.id}>
              <button
                type="button"
                className="topnav-item"
                aria-current={d.id === current ? 'page' : undefined}
                onClick={() => {
                  onNavigate(d.id);
                }}
              >
                <Icon width="18" height="18" />
                <span>{d.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <HaltControl variant="nav" showLabel={false} />
    </nav>
  );
}
