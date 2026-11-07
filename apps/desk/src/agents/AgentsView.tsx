import { useState } from 'react';
import { listAgents } from '../api/endpoints.js';
import { Overlay } from '../lib/Overlay.js';
import { Panel } from '../lib/Panel.js';
import { formatInt } from '../lib/format.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';
import { useFocus } from '../shell/routeContext.js';
import type { Viewport } from '../shell/viewport.js';
import { AgentDetail } from './AgentDetail.js';
import { AgentForm } from './AgentForm.js';
import { AgentRoster } from './AgentRoster.js';

const EMPTY: never[] = [];

/**
 * The roster. Tablet and desktop pair the list with a detail pane; fold stacks them; wide hands
 * detail to the inspector; phone shows cards and opens a full-screen sheet.
 */
export function AgentsView({ viewport }: { viewport: Viewport }) {
  const query = useLiveQuery(listAgents, 'agents');
  const { focus, openAgent, closeAgent } = useFocus();
  const [creating, setCreating] = useState(false);
  const rows = query.data ?? EMPTY;
  const selected = focus.agent;
  const paned = viewport === 'fold' || viewport === 'tablet' || viewport === 'desktop';
  const sheet = viewport === 'phone';

  const actions = (
    <>
      <span className="desk-panel__meta">
        <span className="num">{formatInt(rows.length)}</span> agents
      </span>
      <button
        type="button"
        className="btn btn--sm btn--primary"
        onClick={() => {
          setCreating(true);
        }}
      >
        New agent
      </button>
    </>
  );

  return (
    <div className={`view view--agents ${paned ? 'list-detail list-detail--pane' : ''}`.trim()}>
      <Panel title="Agents" actions={actions} fill className="roster-panel">
        {rows.length === 0 ? (
          <p className="log-empty">
            {query.loading
              ? 'Loading agents'
              : (query.error ?? 'No agents yet. Create one, then give it a task.')}
          </p>
        ) : (
          <AgentRoster rows={rows} selectedId={selected} onSelect={openAgent} viewport={viewport} />
        )}
      </Panel>
      {paned && (
        <aside className="panel detail-pane" aria-label="Agent detail">
          {selected ? (
            <AgentDetail agentId={selected} viewport={viewport} />
          ) : (
            <p className="inspector__empty">Select an agent to see its runs and start one.</p>
          )}
        </aside>
      )}
      {sheet && selected !== null && (
        <Overlay mode="sheet" title="Agent" onClose={closeAgent}>
          <AgentDetail agentId={selected} viewport={viewport} />
        </Overlay>
      )}
      {creating && (
        <Overlay
          mode={sheet ? 'sheet' : 'dialog'}
          title="New agent"
          onClose={() => {
            setCreating(false);
          }}
        >
          <AgentForm
            onDone={(detail) => {
              setCreating(false);
              query.refresh();
              openAgent(detail.agent.id);
            }}
            onCancel={() => {
              setCreating(false);
            }}
          />
        </Overlay>
      )}
    </div>
  );
}
