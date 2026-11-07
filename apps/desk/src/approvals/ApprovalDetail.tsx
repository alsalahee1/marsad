import type { ApprovalQueueItem } from '@marsad/shared';
import { formatDateTime, formatUsd } from '../lib/format.js';
import { useOptionalFocus } from '../shell/routeContext.js';
import { ApprovalActions } from './ApprovalActions.js';
import { kindLabel, stripeFor } from './ApprovalRow.js';

/** Everything behind one decision: the call, its input, the run and agent it belongs to. */
export function ApprovalDetail({ item }: { item: ApprovalQueueItem }) {
  const { approval, toolCall, run, agent } = item;
  const focus = useOptionalFocus();
  return (
    <article className={`detail ${stripeFor(item)}`}>
      <header className="detail__head">
        <h3 className="detail__type">{toolCall.tool}</h3>
        <span className="detail__radius">{kindLabel(item)}</span>
      </header>
      <dl className="detail__meta">
        <dt>blast radius</dt>
        <dd>{toolCall.blastRadius}</dd>
        <dt>agent</dt>
        <dd className="detail__wrap">{agent?.name ?? run.agentId}</dd>
        <dt>task</dt>
        <dd className="detail__wrap">{run.task}</dd>
        <dt>step</dt>
        <dd className="num">{toolCall.step}</dd>
        <dt>requested</dt>
        <dd>
          <time className="num" dateTime={approval.createdAt}>
            {formatDateTime(approval.createdAt)}
          </time>
        </dd>
        {approval.kind === 'budget' && (
          <>
            <dt>estimate</dt>
            <dd className="num">{formatUsd(toolCall.estimatedCostUsd)}</dd>
          </>
        )}
      </dl>
      {approval.kind === 'budget' ? (
        <p className="muted">
          This call would pass a spend cap. Allowing it runs this one call past the cap and records
          the spend; the cap itself does not change, and the next call over it stops again.
        </p>
      ) : (
        <p className="muted">
          Irreversible. Nothing runs until you approve; approving takes two clicks.
        </p>
      )}
      <div className="detail__payload-head">
        <span>input</span>
      </div>
      <pre className="detail__payload num">{JSON.stringify(toolCall.input, null, 2)}</pre>
      {toolCall.error !== null && <p className="muted">{toolCall.error}</p>}
      <div className="detail__actions detail__actions--decide">
        {focus && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              focus.openRun(run.id);
            }}
          >
            Open run
          </button>
        )}
        <ApprovalActions
          item={item}
          onDecided={() => {
            focus?.closeApproval();
          }}
        />
      </div>
    </article>
  );
}
