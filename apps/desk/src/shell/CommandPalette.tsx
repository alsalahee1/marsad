import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { listAgents, listRuns } from '../api/endpoints.js';
import { useApprovals } from '../approvals/ApprovalsProvider.js';
import { closeModal, openModal } from '../lib/Overlay.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';
import { useSystem } from '../system/systemState.js';
import { DESTINATIONS } from './navigation.js';
import { useFocus } from './routeContext.js';

export type PaletteGroup = 'Go to' | 'Actions' | 'Agents' | 'Approvals' | 'Runs';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  run: () => void;
}

export const PALETTE_LIMIT = 40;

/** Case-insensitive substring match on label and hint; an empty query lists everything (capped). */
export function filterItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const hits =
    q === ''
      ? [...items]
      : items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q));
  return hits.slice(0, PALETTE_LIMIT);
}

function truncate(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * ⌘K / Ctrl+K. Destinations, the two system actions, agents, pending decisions and recent runs,
 * filtered as you type. Keyboard only by design; the phone has the tab bar instead.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { navigate, openRun, openAgent, openApproval } = useFocus();
  const { state, halt, resume } = useSystem();
  const { pending } = useApprovals();
  const roster = useLiveQuery(listAgents, 'agents');
  const runs = useLiveQuery((signal) => listRuns({ limit: 20 }, signal), 'runs:recent');

  useEffect(() => {
    const el = dialogRef.current;
    if (el) openModal(el);
    inputRef.current?.focus();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el?.addEventListener('cancel', onCancel);
    return () => {
      el?.removeEventListener('cancel', onCancel);
      if (el) closeModal(el);
    };
  }, [onClose]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = DESTINATIONS.map((d) => ({
      id: `go:${d.id}`,
      group: 'Go to',
      label: d.label,
      run: () => {
        navigate(d.id);
      },
    }));
    list.push(
      state?.halted === true
        ? {
            id: 'act:resume',
            group: 'Actions',
            label: 'Resume all',
            hint: 'release the global halt',
            run: () => void resume(),
          }
        : {
            id: 'act:halt',
            group: 'Actions',
            label: 'Halt all',
            hint: 'stop every worker',
            run: () => void halt(),
          },
    );
    for (const row of roster.data ?? []) {
      list.push({
        id: `agent:${row.agent.id}`,
        group: 'Agents',
        label: row.agent.name,
        hint: row.stats.activeRun ? row.stats.activeRun.status : 'idle',
        run: () => {
          navigate('agents');
          openAgent(row.agent.id);
        },
      });
    }
    for (const item of pending) {
      list.push({
        id: `approval:${item.approval.id}`,
        group: 'Approvals',
        label: `${item.toolCall.tool} · ${item.agent?.name ?? 'agent'}`,
        hint: item.approval.kind === 'budget' ? 'budget hold' : 'needs approval',
        run: () => {
          navigate('approvals');
          openApproval(item.approval.id);
        },
      });
    }
    for (const run of runs.data?.runs ?? []) {
      list.push({
        id: `run:${run.id}`,
        group: 'Runs',
        label: truncate(run.task, 60),
        hint: run.status,
        run: () => {
          openRun(run.id);
        },
      });
    }
    return list;
  }, [
    navigate,
    openAgent,
    openApproval,
    openRun,
    state,
    halt,
    resume,
    roster.data,
    pending,
    runs.data,
  ]);

  const filtered = useMemo(() => filterItems(items, query), [items, query]);
  const clamped = Math.min(active, Math.max(0, filtered.length - 1));

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(filtered.length - 1, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Enter':
        e.preventDefault();
        pick(filtered[clamped]);
        break;
      default:
        break;
    }
  };

  const rows = filtered.map((item, i) => ({
    item,
    header: i === 0 || filtered[i - 1]?.group !== item.group ? item.group : null,
  }));
  return (
    <dialog ref={dialogRef} className="overlay palette" aria-label="Command palette">
      <input
        ref={inputRef}
        className="palette__input"
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={filtered[clamped] ? `palette-${filtered[clamped].id}` : undefined}
        aria-autocomplete="list"
        placeholder="Go to, act, or find an agent, decision or run"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul id="palette-list" className="palette__list" role="listbox">
        {filtered.length === 0 && <li className="palette__empty">No matches.</li>}
        {rows.map(({ item, header }, i) => {
          return (
            <li key={item.id} role="presentation">
              {header !== null && <div className="palette__group">{header}</div>}
              <button
                type="button"
                id={`palette-${item.id}`}
                role="option"
                aria-selected={i === clamped}
                className={`palette__item ${i === clamped ? 'is-active' : ''}`.trim()}
                onMouseEnter={() => {
                  setActive(i);
                }}
                onClick={() => {
                  pick(item);
                }}
              >
                <span className="palette__label">{item.label}</span>
                {item.hint !== undefined && <span className="palette__hint">{item.hint}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
