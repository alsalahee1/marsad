import { AgentDetail } from '../agents/AgentDetail.js';
import { ApprovalDetail } from '../approvals/ApprovalDetail.js';
import { useApprovals } from '../approvals/ApprovalsProvider.js';
import { CloseIcon } from '../lib/Icons.js';
import { EventDetail } from '../log/EventDetail.js';
import { useSelection } from '../log/EventStreamProvider.js';
import { RunDetail } from '../runs/RunDetail.js';
import { useFocus } from './routeContext.js';

/**
 * Wide (1440+): the 380px trailing pane. The most specific thing open shows here: an open run,
 * then the selected agent or decision on their screens, then the selected event.
 */
export function Inspector() {
  const { selected } = useSelection();
  const { focus, dest, closeRun } = useFocus();
  const { pending } = useApprovals();

  let title = 'Inspector';
  let body = <p className="inspector__empty">Select something to inspect it.</p>;
  let onClose: (() => void) | null = null;
  if (focus.run !== null) {
    title = 'Run';
    body = <RunDetail runId={focus.run} />;
    onClose = closeRun;
  } else if (dest === 'agents' && focus.agent !== null) {
    title = 'Agent';
    body = <AgentDetail agentId={focus.agent} viewport="wide" />;
  } else if (dest === 'approvals' && focus.approval !== null) {
    const item = pending.find((i) => i.approval.id === focus.approval);
    title = 'Decision';
    body = item ? (
      <ApprovalDetail item={item} />
    ) : (
      <p className="inspector__empty">This decision is no longer pending.</p>
    );
  } else if (selected) {
    title = 'Event';
    body = <EventDetail event={selected} />;
  }

  return (
    <aside className="app-inspector" aria-label="Inspector">
      <header className="inspector__head">
        <h2 className="inspector__title">{title}</h2>
        {onClose !== null && (
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </header>
      <div className="inspector__body">{body}</div>
    </aside>
  );
}
