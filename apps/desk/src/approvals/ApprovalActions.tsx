import type { ApprovalDecision, ApprovalQueueItem } from '@marsad/shared';
import { useEffect, useState } from 'react';
import { useApprovals } from './ApprovalsProvider.js';

/** An armed irreversible approval disarms itself after this long without the confirming click. */
export const ARM_TIMEOUT_MS = 4000;

export function approveLabel(item: ApprovalQueueItem, armed: boolean, busy: boolean): string {
  if (busy) return 'Deciding';
  if (armed) return 'Confirm approve';
  return item.approval.kind === 'budget' ? 'Allow once' : 'Approve';
}

interface ApprovalActionsProps {
  item: ApprovalQueueItem;
  compact?: boolean;
  onDecided?: (decision: ApprovalDecision) => void;
}

/**
 * Reject and approve. Approving an irreversible call takes two clicks (arm, then confirm within
 * four seconds); a budget hold's "allow once" is one click, as it only spends money the operator
 * is looking at. Reject comes first in reading and tab order: it is the safe default.
 */
export function ApprovalActions({ item, compact = false, onDecided }: ApprovalActionsProps) {
  const { decide, deciding } = useApprovals();
  const [armed, setArmed] = useState(false);
  const busy = deciding === item.approval.id;
  const irreversible = item.approval.kind === 'irreversible';

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => {
      setArmed(false);
    }, ARM_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [armed]);

  const run = async (decision: ApprovalDecision) => {
    if (decision === 'approve' && irreversible && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    const ok = await decide(item.approval.id, decision);
    if (ok) onDecided?.(decision);
  };

  const size = compact ? 'btn--sm' : '';
  return (
    <div className="decide">
      <button
        type="button"
        className={`btn ${size}`.trim()}
        disabled={busy}
        onClick={() => {
          void run('reject');
        }}
      >
        Reject
      </button>
      <button
        type="button"
        className={`btn ${size} btn--primary ${armed ? 'is-armed' : ''}`.trim()}
        aria-pressed={armed}
        disabled={busy}
        onClick={() => {
          void run('approve');
        }}
      >
        {approveLabel(item, armed, busy)}
      </button>
    </div>
  );
}

/** A single full-height action for the phone's swipe reveal. */
export function SwipeDecide({
  item,
  decision,
}: {
  item: ApprovalQueueItem;
  decision: ApprovalDecision;
}) {
  const { decide, deciding } = useApprovals();
  const busy = deciding === item.approval.id;
  const label =
    decision === 'reject' ? 'Reject' : item.approval.kind === 'budget' ? 'Allow once' : 'Approve';
  return (
    <button
      type="button"
      className={`swipe-btn swipe-btn--${decision}`}
      disabled={busy}
      onClick={() => {
        void decide(item.approval.id, decision);
      }}
    >
      {busy ? 'Deciding' : label}
    </button>
  );
}
