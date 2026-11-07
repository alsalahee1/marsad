import { DESTINATIONS, type Destination } from './navigation.js';

export type Badges = Partial<Record<Destination, number>>;

function Badge({ count, label }: { count: number | undefined; label: string }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span className="badge num" aria-label={`${count} ${label}`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

interface TabBarProps {
  current: Destination;
  onNavigate: (dest: Destination) => void;
  badges?: Badges;
}

/** Phone: exactly five tabs, 44px+ targets, safe-area padded by the shell. */
export function TabBar({ current, onNavigate, badges = {} }: TabBarProps) {
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
                <span className="tab__icon">
                  <Icon width="22" height="22" />
                  <Badge count={badges[d.id]} label="waiting" />
                </span>
                <span className="tab__label">{d.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
