import { Overlay } from '../lib/Overlay.js';
import { Panel } from '../lib/Panel.js';
import { formatInt } from '../lib/format.js';
import { useFocus } from '../shell/routeContext.js';
import type { Viewport } from '../shell/viewport.js';
import { ApprovalDetail } from './ApprovalDetail.js';
import { ApprovalRow } from './ApprovalRow.js';
import { useApprovals } from './ApprovalsProvider.js';

/**
 * What is waiting for the operator, oldest first. Tablet and desktop pair the queue with a
 * detail pane; fold stacks them; wide hands detail to the inspector; phone rows swipe and open
 * a full-screen sheet.
 */
export function ApprovalsView({ viewport }: { viewport: Viewport }) {
  const approvals = useApprovals();
  const { focus, openApproval, closeApproval } = useFocus();
  const items = approvals.pending;
  const selected = items.find((i) => i.approval.id === focus.approval) ?? null;
  const paned = viewport === 'fold' || viewport === 'tablet' || viewport === 'desktop';
  const sheet = viewport === 'phone';

  const actions = (
    <span className="desk-panel__meta">
      <span className="num">{formatInt(items.length)}</span> waiting
    </span>
  );

  return (
    <div className={`view view--approvals ${paned ? 'list-detail list-detail--pane' : ''}`.trim()}>
      <Panel title="Approvals" actions={actions} fill className="queue-panel">
        {items.length === 0 ? (
          <p className="log-empty">
            {approvals.loading
              ? 'Loading queue'
              : (approvals.error ?? 'Nothing is waiting for your decision.')}
          </p>
        ) : (
          <ul className="queue" role="list">
            {items.map((item) => (
              <ApprovalRow
                key={item.approval.id}
                item={item}
                selected={item.approval.id === focus.approval}
                onSelect={openApproval}
                viewport={viewport}
              />
            ))}
          </ul>
        )}
        {approvals.lastDecisionError !== null && (
          <p className="log-error" role="alert">
            {approvals.lastDecisionError}
          </p>
        )}
      </Panel>
      {paned && (
        <aside className="panel detail-pane" aria-label="Decision detail">
          {selected ? (
            <ApprovalDetail item={selected} />
          ) : (
            <p className="inspector__empty">Select a decision to see the call and its input.</p>
          )}
        </aside>
      )}
      {sheet && selected !== null && (
        <Overlay mode="sheet" title="Decision" onClose={closeApproval}>
          <ApprovalDetail item={selected} />
        </Overlay>
      )}
    </div>
  );
}
