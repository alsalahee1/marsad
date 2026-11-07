import type { ApprovalQueueItem } from '@marsad/shared';
import type { KeyboardEvent } from 'react';
import { Swipeable } from '../lib/Swipeable.js';
import { formatClock, formatUsd, shortId } from '../lib/format.js';
import type { Viewport } from '../shell/viewport.js';
import { ApprovalActions, SwipeDecide } from './ApprovalActions.js';

export function kindLabel(item: ApprovalQueueItem): string {
  return item.approval.kind === 'budget' ? 'Budget hold' : 'Needs approval';
}

/** The stripe class for a queue item: structure, never a hue. */
export function stripeFor(item: ApprovalQueueItem): string {
  return item.approval.kind === 'budget' ? 'action--costly' : 'action--irreversible';
}

function truncate(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface ApprovalRowProps {
  item: ApprovalQueueItem;
  selected: boolean;
  onSelect: (approvalId: string) => void;
  viewport: Viewport;
}

/**
 * One decision in the queue. Desktop rows carry their buttons; the phone row is swipeable
 * (toward the end uncovers Reject, toward the start uncovers Approve) and a tap opens the sheet.
 */
export function ApprovalRow({ item, selected, onSelect, viewport }: ApprovalRowProps) {
  const { approval, toolCall, run, agent } = item;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(approval.id);
    }
  };
  const body = (
    <div
      className={`queue-row ${stripeFor(item)} ${selected ? 'is-selected' : ''}`.trim()}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => {
        onSelect(approval.id);
      }}
      onKeyDown={onKeyDown}
    >
      <div className="queue-row__main">
        <span className="queue-row__tool">{toolCall.tool}</span>
        <span className="queue-row__kind">{kindLabel(item)}</span>
        <span className="queue-row__agent">{agent?.name ?? shortId(run.agentId)}</span>
      </div>
      <div className="queue-row__sub">
        <span className="queue-row__task">{truncate(run.task, 90)}</span>
        <span className="queue-row__meta">
          step <span className="num">{toolCall.step}</span>
          {' · '}
          <time className="num" dateTime={approval.createdAt}>
            {formatClock(approval.createdAt)}
          </time>
          {approval.kind === 'budget' && (
            <>
              {' · est. '}
              <span className="num">{formatUsd(toolCall.estimatedCostUsd)}</span>
            </>
          )}
        </span>
      </div>
      {viewport !== 'phone' && (
        <div
          className="queue-row__actions"
          onClick={(e) => {
            e.stopPropagation();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
          }}
        >
          <ApprovalActions item={item} compact />
        </div>
      )}
    </div>
  );
  if (viewport === 'phone') {
    return (
      <li className="queue__item">
        <Swipeable
          leading={<SwipeDecide item={item} decision="reject" />}
          trailing={<SwipeDecide item={item} decision="approve" />}
        >
          {body}
        </Swipeable>
      </li>
    );
  }
  return <li className="queue__item">{body}</li>;
}
