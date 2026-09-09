import { Panel } from '../lib/Panel.js';

/** Not built in this task. The shell routes here so the five destinations are real. */
export function AgentsView() {
  return (
    <div className="view">
      <Panel title="Agents">
        <p className="muted">The agent roster renders from the event stream. Next task.</p>
      </Panel>
    </div>
  );
}

export function ApprovalsView() {
  return (
    <div className="view">
      <Panel title="Approvals">
        <p className="muted">
          The approval queue (risk stripe, single-use tokens) renders from the event stream. Next
          task.
        </p>
      </Panel>
    </div>
  );
}
