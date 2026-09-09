import { useId } from 'react';
import { API_BASE } from '../api/base.js';
import { useSession } from '../auth/session.js';
import { Panel } from '../lib/Panel.js';
import { formatDateTime } from '../lib/format.js';
import { usePrefs, type DensityPref, type ThemePref } from '../lib/prefs.js';
import { ConnectionIndicator } from '../log/EventLogPanel.js';
import { useEventStream } from '../log/EventStreamProvider.js';
import { lastId } from '../log/eventBuffer.js';
import type { Viewport } from '../shell/viewport.js';

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const DENSITIES: { value: DensityPref; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
];

function Choice<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  note,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  note?: string;
}) {
  const id = useId();
  return (
    <fieldset className="choice">
      <legend className="field__label">{legend}</legend>
      <div className="choice__row" role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <label key={o.value} className="choice__option">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => {
                onChange(o.value);
              }}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {note && <p className="muted">{note}</p>}
    </fieldset>
  );
}

export function SettingsView({ viewport }: { viewport: Viewport }) {
  const prefs = usePrefs();
  const { expiresAt, signOut } = useSession();
  const { snapshot } = useEventStream();
  const last = lastId(snapshot.buffer);

  return (
    <div className="view view--settings">
      <Panel title="Appearance">
        <Choice
          name="theme"
          legend="Theme"
          value={prefs.theme}
          options={THEMES}
          onChange={prefs.setTheme}
        />
        <Choice
          name="density"
          legend="Density"
          value={prefs.density}
          options={DENSITIES}
          onChange={prefs.setDensity}
          {...(viewport === 'phone' ? { note: 'Phone rows are always comfortable.' } : {})}
        />
      </Panel>
      <Panel title="Session">
        <dl className="kv">
          <dt>Expires</dt>
          <dd>{expiresAt ? <time dateTime={expiresAt}>{formatDateTime(expiresAt)}</time> : '—'}</dd>
        </dl>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void signOut();
          }}
        >
          Sign out
        </button>
      </Panel>
      <Panel title="Engine">
        <dl className="kv">
          <dt>Base</dt>
          <dd className="num kv__wrap">{API_BASE}</dd>
          <dt>Stream</dt>
          <dd>
            <ConnectionIndicator state={snapshot.connection} />
          </dd>
          <dt>Last event</dt>
          <dd className="num">{last ?? '—'}</dd>
          <dt>Invalid frames</dt>
          <dd className="num">{snapshot.invalidFrames}</dd>
        </dl>
      </Panel>
    </div>
  );
}
