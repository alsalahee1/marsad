import type { Run } from '@marsad/shared';
import { getBudgetToday, listAgents, listRuns } from '../api/endpoints.js';
import { useApprovals } from '../approvals/ApprovalsProvider.js';
import { Meter } from '../lib/Meter.js';
import { Metric } from '../lib/Metric.js';
import { StateChip } from '../lib/StateChip.js';
import { formatUsd } from '../lib/format.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';
import { useFocus } from '../shell/routeContext.js';
import { useLimits } from '../system/limits.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function truncate(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Failed, or halted by a ceiling, within the last day: "what broke". */
export function brokeRuns(runs: readonly Run[], now: number): Run[] {
  const since = now - DAY_MS;
  return runs
    .filter((r) => {
      const at = Date.parse(r.finishedAt ?? r.createdAt);
      if (!(at >= since)) return false;
      if (r.status === 'failed') return true;
      return r.status === 'halted' && (r.statusReason ?? '').startsWith('ceiling.');
    })
    .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
}

/**
 * The four questions, answered first. Everything here is a projection of the same rows the
 * other screens read, refreshed by the event stream.
 */
export function DeskTiles() {
  const roster = useLiveQuery(listAgents, 'agents');
  const budget = useLiveQuery(getBudgetToday, 'budget:today');
  const broke = useLiveQuery(async (signal) => {
    const [failed, halted] = await Promise.all([
      listRuns({ status: 'failed', limit: 100 }, signal),
      listRuns({ status: 'halted', limit: 100 }, signal),
    ]);
    return brokeRuns([...failed.runs, ...halted.runs], Date.now());
  }, 'runs:broke');
  const { pending } = useApprovals();
  const limits = useLimits();
  const { openRun, navigate } = useFocus();

  const running = (roster.data ?? []).filter((r) => r.stats.activeRun?.status === 'running');
  const brokeList = broke.data ?? [];
  const spent = budget.data?.budget?.spentUsd ?? 0;
  const cap = budget.data?.caps.usd ?? limits?.perDayUsd ?? 0;

  return (
    <div className="tiles">
      <Metric
        label="Running"
        value={String(running.length)}
        sub={
          running.length === 0
            ? 'No agent is running'
            : truncate(running.map((r) => r.agent.name).join(', '), 80)
        }
        className="tile"
      />
      <Metric
        label="Spent today"
        value={formatUsd(spent)}
        sub={
          <>
            of <span className="num">{formatUsd(cap)}</span> day cap
          </>
        }
        className="tile"
      >
        {cap > 0 && <Meter label="Day budget" value={spent} cap={cap} format={formatUsd} />}
      </Metric>
      <Metric
        label="Waiting for you"
        value={String(pending.length)}
        sub={pending.length === 0 ? 'Nothing waiting' : 'Decisions in the approval queue'}
        className="tile"
      >
        {pending.length > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              navigate('approvals');
            }}
          >
            Open queue
          </button>
        )}
      </Metric>
      <Metric
        label="Broke in 24h"
        value={String(brokeList.length)}
        sub={brokeList.length === 0 ? 'Nothing broke' : 'Failed, or stopped by a ceiling'}
        className="tile"
      >
        {brokeList.length > 0 && (
          <ul className="tile-list" role="list">
            {brokeList.slice(0, 3).map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="link tile-list__item"
                  onClick={() => {
                    openRun(run.id);
                  }}
                >
                  <StateChip status={run.status} />
                  <span className="tile-list__text">{truncate(run.task, 48)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Metric>
    </div>
  );
}
