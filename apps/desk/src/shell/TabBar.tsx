import { DESTINATIONS, type Destination } from './navigation.js';

interface TabBarProps {
  current: Destination;
  onNavigate: (dest: Destination) => void;
}

/** Phone: exactly five tabs, 44px+ targets, safe-area padded by the shell. */
export function TabBar({ current, onNavigate }: TabBarProps) {
  return (
    <nav className="app-tabbar" aria-label="Primary">
      <ul className="tabbar-list" role="tablist" aria-orientation="horizontal">
        {DESTINATIONS.map((d) => {
          const Icon = d.icon;
          const active = d.id === current;
          return (
            <li key={d.id} role="presentation">
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={active}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  onNavigate(d.id);
                }}
              >
                <Icon width="22" height="22" />
                <span className="tab__label">{d.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
