import type { AgentRosterRow } from '@marsad/shared';
import { useRef, useState, type KeyboardEvent } from 'react';
import { StateChip } from '../lib/StateChip.js';
import { formatClock, formatInt, formatUsd } from '../lib/format.js';
import { useVirtualRows } from '../log/useVirtualRows.js';
import type { Viewport } from '../shell/viewport.js';

interface AgentRosterProps {
  rows: readonly AgentRosterRow[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  viewport: Viewport;
}

export function rosterRowDomId(agentId: string): string {
  return `agent-row-${agentId}`;
}

/**
 * Phone: one card per agent, the table is gone. Elsewhere: a virtualised table with fixed-height
 * rows (`--row-active`), every figure tabular, colour only on the state chip.
 */
export function AgentRoster({ rows, selectedId, onSelect, viewport }: AgentRosterProps) {
  if (viewport === 'phone')
    return <AgentCards rows={rows} selectedId={selectedId} onSelect={onSelect} />;
  return <AgentTable rows={rows} selectedId={selectedId} onSelect={onSelect} />;
}

function AgentCards({ rows, selectedId, onSelect }: Omit<AgentRosterProps, 'viewport'>) {
  return (
    <ul className="agent-cards" role="list">
      {rows.map(({ agent, stats }) => (
        <li key={agent.id}>
          <button
            type="button"
            className={`agent-card ${agent.enabled ? '' : 'is-disabled'} ${selectedId === agent.id ? 'is-selected' : ''}`.trim()}
            aria-pressed={selectedId === agent.id}
            onClick={() => {
              onSelect(agent.id);
            }}
          >
            <span className="agent-card__head">
              <span className="agent-card__name">{agent.name}</span>
              <StateChip status={stats.activeRun?.status ?? null} idle />
            </span>
            <span className="agent-card__figures">
              <span>
                <span className="num">{formatInt(stats.runsToday)}</span> runs today
              </span>
              <span>
                <span className="num">{formatUsd(stats.spentTodayUsd)}</span> spent
              </span>
              <span>
                {stats.lastRunAt ? (
                  <>
                    last{' '}
                    <time className="num" dateTime={stats.lastRunAt}>
                      {formatClock(stats.lastRunAt)}
                    </time>
                  </>
                ) : (
                  'no runs yet'
                )}
              </span>
            </span>
            {!agent.enabled && <span className="agent-card__note">Disabled</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentTable({ rows, selectedId, onSelect }: Omit<AgentRosterProps, 'viewport'>) {
  const listRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows(listRef, rows.length);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const current =
      activeIndex ??
      Math.max(
        0,
        rows.findIndex((r) => r.agent.id === selectedId),
      );
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(rows.length - 1, current + 1);
        break;
      case 'ArrowUp':
        next = Math.max(0, current - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'Enter':
      case ' ': {
        const row = rows[current];
        if (row) onSelect(row.agent.id);
        e.preventDefault();
        return;
      }
      default:
        return;
    }
    e.preventDefault();
    setActiveIndex(next);
    const row = rows[next];
    if (row) onSelect(row.agent.id);
    virtual.scrollToIndex(next);
  };

  const active = activeIndex === null ? undefined : rows[activeIndex];
  const rendered = [];
  for (let i = virtual.start; i < virtual.end; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const { agent, stats } = row;
    rendered.push(
      <div
        key={agent.id}
        id={rosterRowDomId(agent.id)}
        role="option"
        aria-selected={selectedId === agent.id}
        className={`roster-row ${agent.enabled ? '' : 'is-disabled'} ${active?.agent.id === agent.id ? 'is-active' : ''}`.trim()}
        style={{ transform: `translateY(${i * virtual.rowHeight}px)` }}
        onClick={() => {
          setActiveIndex(i);
          onSelect(agent.id);
        }}
      >
        <span className="roster-cell roster-cell--name">{agent.name}</span>
        <span className="roster-cell roster-cell--state">
          <StateChip status={stats.activeRun?.status ?? null} idle />
        </span>
        <span className="roster-cell roster-cell--runs num">{formatInt(stats.runsToday)}</span>
        <span className="roster-cell roster-cell--spend num">{formatUsd(stats.spentTodayUsd)}</span>
        <span className="roster-cell roster-cell--last num">
          {stats.lastRunAt ? (
            <time dateTime={stats.lastRunAt}>{formatClock(stats.lastRunAt)}</time>
          ) : (
            '—'
          )}
        </span>
        <span className="roster-cell roster-cell--enabled">{agent.enabled ? 'on' : 'off'}</span>
      </div>,
    );
  }

  return (
    <>
      <div className="roster-head" aria-hidden="true">
        <span className="roster-cell roster-cell--name">agent</span>
        <span className="roster-cell roster-cell--state">state</span>
        <span className="roster-cell roster-cell--runs">runs today</span>
        <span className="roster-cell roster-cell--spend">spent today</span>
        <span className="roster-cell roster-cell--last">last run</span>
        <span className="roster-cell roster-cell--enabled">enabled</span>
      </div>
      <div
        ref={listRef}
        className="roster-list"
        role="listbox"
        aria-label="Agents"
        aria-activedescendant={active ? rosterRowDomId(active.agent.id) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="log-spacer" style={{ height: virtual.totalHeight }}>
          {rendered}
        </div>
      </div>
    </>
  );
}
