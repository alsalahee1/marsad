import { TERMINAL_RUN_STATUSES, type Event, type RunStatus, type ToolCall } from '@marsad/shared';
import { useState } from 'react';
import { describeError } from '../api/client.js';
import { getRun, getRunEvents, haltRun } from '../api/endpoints.js';
import { ApprovalActions } from '../approvals/ApprovalActions.js';
import { useApprovals } from '../approvals/ApprovalsProvider.js';
import { Meter } from '../lib/Meter.js';
import { StateChip } from '../lib/StateChip.js';
import { formatClockParts, formatDateTime, formatMs, formatUsd, shortId } from '../lib/format.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';
import { blastRadiusOf, impliedRunState, summarize } from '../log/summarize.js';
import { useOptionalFocus } from '../shell/routeContext.js';
import { useLimits } from '../system/limits.js';

const TIMELINE_LIMIT = 500;

function isTerminal(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

function callDuration(tc: ToolCall): string {
  if (tc.startedAt === null || tc.finishedAt === null) return '';
  return formatMs(Math.max(0, Date.parse(tc.finishedAt) - Date.parse(tc.startedAt)));
}

/**
 * One run: its state, its usage against every ceiling the engine enforces, the decision it is
 * waiting on, its tool calls, and its timeline straight from the event log. Phone opens it in
 * a full-screen sheet, wide in the inspector.
 */
export function RunDetail({ runId }: { runId: string }) {
  const detail = useLiveQuery((signal) => getRun(runId, signal), `run:${runId}`);
  const timeline = useLiveQuery(
    (signal) => getRunEvents(runId, TIMELINE_LIMIT, signal),
    `run-events:${runId}`,
  );
  const limits = useLimits();
  const { pending } = useApprovals();
  const focus = useOptionalFocus();
  const [halting, setHalting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!detail.data) return <p className="inspector__empty">{detail.error ?? 'Loading run'}</p>;
  const { run, agent, toolCalls, budget } = detail.data;
  const hold = pending.find((i) => i.run.id === run.id) ?? null;

  const halt = async () => {
    setHalting(true);
    setError(null);
    try {
      await haltRun(run.id);
      detail.refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setHalting(false);
    }
  };

  return (
    <article className="run-detail">
      <header className="detail__head">
        <StateChip status={run.status} />
        <h3 className="detail__type run-detail__task">{run.task}</h3>
      </header>
      <dl className="detail__meta">
        <dt>agent</dt>
        <dd className="detail__wrap">
          {agent && focus ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                focus.navigate('agents');
                focus.openAgent(agent.id);
              }}
            >
              {agent.name}
            </button>
          ) : (
            (agent?.name ?? shortId(run.agentId))
          )}
        </dd>
        <dt>run</dt>
        <dd className="num detail__wrap">{run.id}</dd>
        <dt>created</dt>
        <dd>
          <time className="num" dateTime={run.createdAt}>
            {formatDateTime(run.createdAt)}
          </time>
        </dd>
        {run.finishedAt !== null && (
          <>
            <dt>finished</dt>
            <dd>
              <time className="num" dateTime={run.finishedAt}>
                {formatDateTime(run.finishedAt)}
              </time>
            </dd>
          </>
        )}
        {run.statusReason !== null && (
          <>
            <dt>reason</dt>
            <dd className="detail__wrap">{run.statusReason}</dd>
          </>
        )}
      </dl>

      {limits !== null && (
        <div className="meters" aria-label="Ceilings">
          <Meter label="Steps" value={run.stepCount} cap={limits.maxSteps} />
          <Meter label="Tokens" value={run.tokensUsed} cap={limits.maxTokens} />
          <Meter
            label="Active time"
            value={run.activeMs / 1000}
            cap={limits.maxWallClockMs / 1000}
            format={(n) => n.toFixed(1)}
            unit="s"
          />
          <Meter
            label="Spend"
            value={run.costUsd}
            cap={limits.perRunUsd}
            format={formatUsd}
            unit="USD"
          />
        </div>
      )}

      {hold !== null && (
        <section
          className={`run-detail__hold ${hold.approval.kind === 'budget' ? 'action--costly' : 'action--irreversible'}`}
        >
          <p className="run-detail__hold-text">
            {hold.approval.kind === 'budget' ? 'Budget hold on ' : 'Waiting for your approval of '}
            <span className="run-detail__hold-tool">{hold.toolCall.tool}</span>
            {hold.approval.kind === 'budget' && (
              <>
                {' · est. '}
                <span className="num">{formatUsd(hold.toolCall.estimatedCostUsd)}</span>
              </>
            )}
          </p>
          <ApprovalActions item={hold} />
        </section>
      )}

      <div className="detail__actions">
        {!isTerminal(run.status) && (
          <button
            type="button"
            className="btn btn--sm"
            disabled={halting}
            onClick={() => {
              void halt();
            }}
          >
            {halting ? 'Halting' : 'Halt run'}
          </button>
        )}
        {budget !== null && (
          <span className="muted">
            run budget <span className="num">{formatUsd(budget.spentUsd)}</span> of{' '}
            <span className="num">{formatUsd(budget.capUsd)}</span> over{' '}
            <span className="num">{budget.callCount}</span> costly calls
          </span>
        )}
      </div>
      {error !== null && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}

      <section className="detail__section">
        <h4 className="detail__section-title">Tool calls</h4>
        {toolCalls.length === 0 ? (
          <p className="muted">No tool calls yet.</p>
        ) : (
          <ol className="calls" role="list">
            {toolCalls.map((tc) => (
              <li key={tc.id} className={`calls__item action--${tc.blastRadius}`}>
                <span className="num calls__step">{tc.step}</span>
                <span className="calls__tool">{tc.tool}</span>
                <span className="calls__status">{tc.status}</span>
                <span className="num calls__cost">
                  {tc.actualCostUsd !== null
                    ? formatUsd(tc.actualCostUsd)
                    : tc.estimatedCostUsd > 0
                      ? `~${formatUsd(tc.estimatedCostUsd)}`
                      : ''}
                </span>
                <span className="num calls__duration">{callDuration(tc)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="detail__section">
        <h4 className="detail__section-title">Timeline</h4>
        {timeline.data === null ? (
          <p className="muted">{timeline.error ?? 'Loading timeline'}</p>
        ) : timeline.data.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <ol className="timeline" role="list">
            {timeline.data.map((ev) => (
              <TimelineItem key={ev.id} event={ev} />
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

function TimelineItem({ event }: { event: Event }) {
  const radius = blastRadiusOf(event);
  const state = impliedRunState(event);
  const clock = formatClockParts(event.at);
  return (
    <li className={`timeline__item ${radius ? `action--${radius}` : ''}`.trim()}>
      <time className="num timeline__time" dateTime={event.at}>
        {clock.time}
        <span className="log-ms">{clock.ms}</span>
      </time>
      <span className="timeline__type">
        <span className="state-dot" data-state={state ?? 'none'} aria-hidden="true" />
        {event.type}
      </span>
      <span className="timeline__summary">
        {summarize(event).map((s, i) =>
          s.kind === 'num' ? (
            <span key={i} className="num">
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </span>
    </li>
  );
}
