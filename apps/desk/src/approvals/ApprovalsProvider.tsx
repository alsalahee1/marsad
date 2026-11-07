import type { ApprovalDecision, ApprovalQueueItem } from '@marsad/shared';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { describeError } from '../api/client.js';
import { decideApproval, listApprovals } from '../api/endpoints.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';

export interface ApprovalsApi {
  /** Decisions waiting, oldest first. Irreversible calls and budget holds share the queue. */
  pending: readonly ApprovalQueueItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Mint a single-use token and spend it on this decision. Resolves true when the engine took it. */
  decide: (approvalId: string, decision: ApprovalDecision) => Promise<boolean>;
  /** The approval a decision is in flight for, so its row can show it. */
  deciding: string | null;
  lastDecisionError: string | null;
}

const ApprovalsContext = createContext<ApprovalsApi | null>(null);

const EMPTY: readonly ApprovalQueueItem[] = [];

/**
 * One fetch of the pending queue for the whole desk: the Approvals screen, the badge on the
 * rail and tab bar, the desk tile and a run's detail all read the same list, refreshed by the
 * event stream.
 */
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const query = useLiveQuery((signal) => listApprovals('pending', signal), 'approvals:pending');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [lastDecisionError, setLastDecisionError] = useState<string | null>(null);
  const { refresh } = query;

  const decide = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      setDeciding(approvalId);
      setLastDecisionError(null);
      try {
        await decideApproval(approvalId, decision);
        return true;
      } catch (err) {
        setLastDecisionError(describeError(err));
        return false;
      } finally {
        setDeciding(null);
        refresh();
      }
    },
    [refresh],
  );

  const api = useMemo<ApprovalsApi>(
    () => ({
      pending: query.data ?? EMPTY,
      loading: query.loading,
      error: query.error,
      refresh,
      decide,
      deciding,
      lastDecisionError,
    }),
    [query.data, query.loading, query.error, refresh, decide, deciding, lastDecisionError],
  );
  return <ApprovalsContext.Provider value={api}>{children}</ApprovalsContext.Provider>;
}

export function useApprovals(): ApprovalsApi {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) throw new Error('useApprovals outside ApprovalsProvider');
  return ctx;
}
