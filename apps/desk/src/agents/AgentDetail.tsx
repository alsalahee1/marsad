import type { Run } from '@marsad/shared';
import { useState, type SyntheticEvent } from 'react';
import { describeError } from '../api/client.js';
import { createRun, getAgent, getTools, updateAgent } from '../api/endpoints.js';
import { Overlay } from '../lib/Overlay.js';
import { StateChip } from '../lib/StateChip.js';
import { formatClock, formatDateTime, formatInt, formatUsd } from '../lib/format.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';
import { useFocus } from '../shell/routeContext.js';
import type { Viewport } from '../shell/viewport.js';
import { AgentForm } from './AgentForm.js';

interface AgentDetailProps {
  agentId: string;
  viewport: Viewport;
}

/** One agent: what it may call, what it did today, its recent runs, and a task box. */
export function AgentDetail({ agentId, viewport }: AgentDetailProps) {
  const query = useLiveQuery((signal) => getAgent(agentId, signal), `agent:${agentId}`);
  const tools = useLiveQuery(getTools, 'tools', ['tools.']);
  const { openRun } = useFocus();
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState<'run' | 'toggle' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!query.data) {
    return <p className="inspector__empty">{query.error ?? 'Loading agent'}</p>;
  }
  const { agent, stats, recentRuns } = query.data;
  const radiusOf = (name: string) => tools.data?.find((t) => t.name === name)?.blastRadius ?? null;

  const startRun = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = task.trim();
    if (text === '') {
      setError('Give the agent a task.');
      return;
    }
    setBusy('run');
    setError(null);
    try {
      const detail = await createRun({ agentId: agent.id, task: text });
      setTask('');
      query.refresh();
      openRun(detail.run.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async () => {
    setBusy('toggle');
    setError(null);
    try {
      await updateAgent(agent.id, { enabled: !agent.enabled });
      query.refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="agent-detail">
      <header className="detail__head">
        <StateChip status={stats.activeRun?.status ?? null} idle />
        <h3 className="detail__type">{agent.name}</h3>
        {!agent.enabled && <span className="detail__radius">disabled</span>}
      </header>
      <dl className="detail__meta">
        <dt>model</dt>
        <dd className="detail__wrap">{agent.model}</dd>
        <dt>tools</dt>
        <dd>
          {agent.tools.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            <ul className="tool-list" role="list">
              {agent.tools.map((name) => {
                const radius = radiusOf(name);
                return (
                  <li
                    key={name}
                    className={`tool-list__item ${radius ? `action--${radius}` : ''}`.trim()}
                  >
                    <span className="tool-list__name">{name}</span>
                    {radius !== null && <span className="tool-list__radius">{radius}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
        <dt>today</dt>
        <dd>
          <span className="num">{formatInt(stats.runsToday)}</span> runs ·{' '}
          <span className="num">{formatUsd(stats.spentTodayUsd)}</span> spent
        </dd>
        <dt>last run</dt>
        <dd>
          {stats.lastRunAt ? (
            <time className="num" dateTime={stats.lastRunAt}>
              {formatDateTime(stats.lastRunAt)}
            </time>
          ) : (
            '—'
          )}
        </dd>
        <dt>created</dt>
        <dd>
          <time className="num" dateTime={agent.createdAt}>
            {formatDateTime(agent.createdAt)}
          </time>
        </dd>
      </dl>

      <div className="detail__actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={busy !== null}
          onClick={() => {
            void toggleEnabled();
          }}
        >
          {busy === 'toggle' ? 'Saving' : agent.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setEditing(true);
          }}
        >
          Edit
        </button>
      </div>

      <form
        className="newrun"
        onSubmit={(e) => {
          void startRun(e);
        }}
      >
        <label className="field__label" htmlFor={`task-${agent.id}`}>
          Task
        </label>
        <textarea
          id={`task-${agent.id}`}
          className="field__input field__textarea"
          rows={3}
          value={task}
          disabled={!agent.enabled || busy !== null}
          placeholder={
            agent.enabled ? 'What should this agent do?' : 'Enable the agent to start a run.'
          }
          onChange={(e) => {
            setTask(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!agent.enabled || busy !== null || task.trim() === ''}
        >
          {busy === 'run' ? 'Starting' : 'Start run'}
        </button>
      </form>
      {error !== null && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      <section className="detail__section">
        <h4 className="detail__section-title">Recent runs</h4>
        {recentRuns.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <ul className="run-list" role="list">
            {recentRuns.map((run) => (
              <RunListItem key={run.id} run={run} onOpen={openRun} />
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <Overlay
          mode={viewport === 'phone' ? 'sheet' : 'dialog'}
          title="Edit agent"
          onClose={() => {
            setEditing(false);
          }}
        >
          <AgentForm
            initial={agent}
            onDone={() => {
              setEditing(false);
              query.refresh();
            }}
            onCancel={() => {
              setEditing(false);
            }}
          />
        </Overlay>
      )}
    </article>
  );
}

export function RunListItem({ run, onOpen }: { run: Run; onOpen: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className="run-list__item"
        onClick={() => {
          onOpen(run.id);
        }}
      >
        <StateChip status={run.status} />
        <span className="run-list__task">{run.task}</span>
        <time className="num run-list__time" dateTime={run.createdAt}>
          {formatClock(run.createdAt)}
        </time>
      </button>
    </li>
  );
}
