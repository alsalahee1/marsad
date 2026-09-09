import type { Event } from '@marsad/shared';
import { memo } from 'react';
import { formatClockParts, shortId } from '../lib/format.js';
import { blastRadiusOf, impliedRunState, summarize } from './summarize.js';

interface EventRowProps {
  event: Event;
  top: number;
  selected: boolean;
  active: boolean;
  onSelect: (event: Event) => void;
  onOpen: (event: Event) => void;
}

export function rowDomId(eventId: string): string {
  return `event-row-${eventId}`;
}

/**
 * One line per event, fixed height, positioned by the virtualiser. Colour appears only as the
 * run-state dot; the blast radius of an action is the start-edge stripe, never a hue.
 */
export const EventRow = memo(function EventRow({
  event,
  top,
  selected,
  active,
  onSelect,
  onOpen,
}: EventRowProps) {
  const state = impliedRunState(event);
  const radius = blastRadiusOf(event);
  const segments = summarize(event);
  const clock = formatClockParts(event.at);
  return (
    <div
      id={rowDomId(event.id)}
      role="option"
      aria-selected={selected}
      className={`log-row ${radius ? `action--${radius}` : ''} ${active ? 'is-active' : ''}`.trim()}
      style={{ transform: `translateY(${top}px)` }}
      onClick={() => {
        onSelect(event);
      }}
      onDoubleClick={() => {
        onOpen(event);
      }}
    >
      <span className="log-cell log-cell--id num">{event.id}</span>
      <time className="log-cell log-cell--time" dateTime={event.at} title={event.at}>
        {clock.time}
        <span className="log-ms">{clock.ms}</span>
      </time>
      <span className="log-cell log-cell--type">
        <span className="state-dot" data-state={state ?? 'none'} aria-hidden="true" />
        {event.type}
      </span>
      <span className="log-cell log-cell--run num">
        {event.runId === undefined ? '' : shortId(event.runId)}
      </span>
      <span className="log-cell log-cell--summary">
        {segments.map((s, i) =>
          s.kind === 'num' ? (
            <span key={i} className="num">
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </div>
  );
});
