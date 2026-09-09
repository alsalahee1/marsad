import type { Event } from '@marsad/shared';
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FollowIcon } from '../lib/Icons.js';
import { Panel } from '../lib/Panel.js';
import { formatInt } from '../lib/format.js';
import { useFlashOnChange } from '../lib/useFlash.js';
import { EventRow, rowDomId } from './EventRow.js';
import { useEventStream, useSelection } from './EventStreamProvider.js';
import type { ConnectionState } from './stream.js';
import { useVirtualRows } from './useVirtualRows.js';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

export function ConnectionIndicator({ state }: { state: ConnectionState }) {
  return (
    <span className="conn" data-state={state} role="status">
      <span className="conn__dot" aria-hidden="true" />
      {CONNECTION_LABEL[state]}
    </span>
  );
}

interface EventLogPanelProps {
  /** Called when the operator opens a row (Enter or double-click; the phone's open strip). */
  onOpen?: (event: Event) => void;
  title?: string;
}

/**
 * The event log: a virtualised stream of the append-only table. Follow-tail keeps the newest
 * row in view until the operator scrolls up; scrolling back to the bottom re-engages it.
 */
export function EventLogPanel({ onOpen, title = 'Event log' }: EventLogPanelProps) {
  const { snapshot, loadEarlier } = useEventStream();
  const { selected, select } = useSelection();
  const events = snapshot.buffer.events;
  const count = events.length;

  const listRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows(listRef, count);
  /** `pausedAt` is the row count when following was switched off: "new" rows count from it. */
  const [tail, setTail] = useState({ following: true, pausedAt: 0 });
  const { following } = tail;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const unseen = following ? 0 : Math.max(0, count - tail.pausedAt);

  const countRef = useFlashOnChange<HTMLSpanElement>(count);

  // Follow the tail: after every append, pin the scroll position to the newest row.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [count, following, virtual.rowHeight]);

  const pause = useCallback(() => {
    setTail((t) => (t.following ? { following: false, pausedAt: count } : t));
  }, [count]);

  const follow = useCallback(() => {
    setTail((t) => (t.following ? t : { following: true, pausedAt: 0 }));
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    if (virtual.isAtTail()) setTail((t) => (t.following ? t : { following: true, pausedAt: 0 }));
    else pause();
  }, [virtual, pause]);

  const open = useCallback(
    (event: Event) => {
      select(event);
      onOpen?.(event);
    },
    [select, onOpen],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = activeIndex ?? count - 1;
    const page = Math.max(1, virtual.end - virtual.start - 2);
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(count - 1, current + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, current - 1);
        break;
      case 'PageDown':
        next = Math.min(count - 1, current + page);
        break;
      case 'PageUp':
        next = Math.max(0, current - page);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      case 'Enter': {
        const ev = events[current];
        if (ev) open(ev);
        e.preventDefault();
        return;
      }
      case 'Escape':
        select(null);
        setActiveIndex(null);
        return;
      default:
        return;
    }
    e.preventDefault();
    setActiveIndex(next);
    const ev = events[next];
    if (ev) select(ev);
    virtual.scrollToIndex(next);
    // Moving onto the newest row means "show me the tail again"; anywhere else pauses it.
    if (next < count - 1) pause();
    else setTail((t) => (t.following ? t : { following: true, pausedAt: 0 }));
  };

  const activeEvent = activeIndex === null ? undefined : events[activeIndex];
  const rows = [];
  for (let i = virtual.start; i < virtual.end; i += 1) {
    const ev = events[i];
    if (!ev) continue;
    rows.push(
      <EventRow
        key={ev.id}
        event={ev}
        top={i * virtual.rowHeight}
        selected={selected?.id === ev.id}
        active={activeEvent?.id === ev.id}
        onSelect={(event) => {
          setActiveIndex(i);
          select(event);
        }}
        onOpen={open}
      />,
    );
  }

  const actions = (
    <>
      <span className="desk-panel__meta">
        <span className="num" ref={countRef}>
          {formatInt(count)}
        </span>{' '}
        rows
        {snapshot.invalidFrames > 0 && (
          <>
            {' · '}
            <span className="num">{formatInt(snapshot.invalidFrames)}</span> invalid
          </>
        )}
      </span>
      <ConnectionIndicator state={snapshot.connection} />
      <button
        type="button"
        className="btn btn--sm"
        onClick={loadEarlier}
        disabled={snapshot.loadingHistory || snapshot.historyExhausted || count === 0}
        title={snapshot.historyExhausted ? 'Beginning of the log' : 'Load earlier rows'}
      >
        {snapshot.loadingHistory ? 'Loading' : 'Earlier'}
      </button>
      <button
        type="button"
        className="btn btn--sm btn--toggle"
        aria-pressed={following}
        onClick={follow}
      >
        <FollowIcon width="16" height="16" />
        Follow
        {unseen > 0 && (
          <>
            {' · '}
            <span className="num">{formatInt(unseen)}</span> new
          </>
        )}
      </button>
    </>
  );

  return (
    <Panel title={title} actions={actions} fill className="log-panel">
      <div className="log-head" aria-hidden="true">
        <span className="log-cell log-cell--id">id</span>
        <span className="log-cell log-cell--time">time</span>
        <span className="log-cell log-cell--type">type</span>
        <span className="log-cell log-cell--run">run</span>
        <span className="log-cell log-cell--summary">summary</span>
      </div>
      <div
        ref={listRef}
        className="log-list"
        role="listbox"
        aria-label="Events"
        aria-activedescendant={activeEvent ? rowDomId(activeEvent.id) : undefined}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        {count === 0 ? (
          <p className="log-empty">
            {snapshot.connection === 'live'
              ? 'No events yet.'
              : (snapshot.lastError ?? 'Loading log')}
          </p>
        ) : (
          <div className="log-spacer" style={{ height: virtual.totalHeight }}>
            {rows}
          </div>
        )}
      </div>
      {snapshot.lastError !== null && count > 0 && (
        <p className="log-error" role="status">
          {snapshot.lastError}
        </p>
      )}
    </Panel>
  );
}
