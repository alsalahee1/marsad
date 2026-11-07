import { CollapseIcon, ExpandIcon } from '../lib/Icons.js';
import { usePrefs } from '../lib/prefs.js';
import { HaltControl } from './HaltControl.js';
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

interface RailProps {
  current: Destination;
  onNavigate: (dest: Destination) => void;
  /** Tablet keeps the rail icon-only; desktop may expand it to 240px. */
  expandable: boolean;
  /** Counts shown on a destination: decisions waiting on Approvals. */
  badges?: Badges;
}

/** The icon rail: 56px, expands to 240px on request. Halt sits at the bottom, one tap away. */
export function Rail({ current, onNavigate, expandable, badges = {} }: RailProps) {
  const { railExpanded, setRailExpanded } = usePrefs();
  const expanded = expandable && railExpanded;
  return (
    <nav className="app-rail" aria-label="Primary" data-expanded={expanded}>
      <div className="rail-brand" aria-hidden="true">
        <span className="rail-brand__mark">M</span>
        <span className="rail-item__label">MARSAD</span>
      </div>
      <ul className="rail-list">
        {DESTINATIONS.map((d) => {
          const Icon = d.icon;
          const active = d.id === current;
          return (
            <li key={d.id}>
              <button
                type="button"
                className="rail-item"
                aria-current={active ? 'page' : undefined}
                aria-label={expanded ? undefined : d.label}
                title={expanded ? undefined : d.label}
                onClick={() => {
                  onNavigate(d.id);
                }}
              >
                <span className="rail-item__icon">
                  <Icon />
                  <Badge count={badges[d.id]} label="waiting" />
                </span>
                <span className="rail-item__label">{d.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="rail-foot">
        <HaltControl variant="rail" showLabel={expanded} />
        {expandable && (
          <button
            type="button"
            className="rail-item rail-item--toggle"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse rail' : 'Expand rail'}
            title={expanded ? 'Collapse rail' : 'Expand rail'}
            onClick={() => {
              setRailExpanded(!expanded);
            }}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
            <span className="rail-item__label">Collapse</span>
          </button>
        )}
      </div>
    </nav>
  );
}
