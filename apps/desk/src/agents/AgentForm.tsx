import {
  CreateAgentRequestSchema,
  type Agent,
  type AgentDetailResponse,
  type UpdateAgentRequest,
} from '@marsad/shared';
import { useId, useState, type SyntheticEvent } from 'react';
import { ApiRequestError, describeError } from '../api/client.js';
import { createAgent, getTools, updateAgent } from '../api/endpoints.js';
import { useLiveQuery } from '../lib/useLiveQuery.js';

interface AgentFormProps {
  /** Present when editing; absent when creating. */
  initial?: Agent;
  onDone: (detail: AgentDetailResponse) => void;
  onCancel: () => void;
}

/**
 * Create or edit an agent. Tools are picked from the registry snapshot; each shows its blast
 * radius as the start-edge stripe and as a word, never as a colour. The system prompt is
 * instructions for the model and nothing more: every limit lives in the engine.
 */
export function AgentForm({ initial, onDone, onCancel }: AgentFormProps) {
  const ids = { name: useId(), model: useId(), prompt: useId(), tools: useId(), error: useId() };
  const tools = useLiveQuery(getTools, 'tools', ['tools.']);
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial?.tools ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  const toggle = (toolName: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  const submit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = { name, model, systemPrompt, tools: [...picked].sort() };
    const parsed = CreateAgentRequestSchema.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? '')] = issue.message;
      setIssues(next);
      return;
    }
    setIssues({});
    setBusy(true);
    setError(null);
    try {
      if (initial) {
        const patch: UpdateAgentRequest = {};
        if (parsed.data.name !== initial.name) patch.name = parsed.data.name;
        if (parsed.data.model !== initial.model) patch.model = parsed.data.model;
        if (parsed.data.systemPrompt !== initial.systemPrompt)
          patch.systemPrompt = parsed.data.systemPrompt;
        if (parsed.data.tools.join('\n') !== [...initial.tools].sort().join('\n'))
          patch.tools = parsed.data.tools;
        if (Object.keys(patch).length === 0) {
          onCancel();
          return;
        }
        onDone(await updateAgent(initial.id, patch));
      } else {
        onDone(await createAgent(parsed.data));
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'name_taken')
        setError('That name is taken.');
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const activeTools = (tools.data ?? []).filter((t) => t.active);

  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        void submit(e);
      }}
      aria-describedby={error ? ids.error : undefined}
    >
      <div className="field">
        <label className="field__label" htmlFor={ids.name}>
          Name
        </label>
        <input
          id={ids.name}
          className="field__input"
          value={name}
          maxLength={120}
          required
          aria-invalid={'name' in issues}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        {issues['name'] && <p className="field__error">{issues['name']}</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={ids.model}>
          Model
        </label>
        <input
          id={ids.model}
          className="field__input"
          value={model}
          maxLength={120}
          required
          placeholder="claude-sonnet-5"
          aria-invalid={'model' in issues}
          onChange={(e) => {
            setModel(e.target.value);
          }}
        />
        {issues['model'] && <p className="field__error">{issues['model']}</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor={ids.prompt}>
          System prompt
        </label>
        <textarea
          id={ids.prompt}
          className="field__input field__textarea"
          rows={5}
          value={systemPrompt}
          onChange={(e) => {
            setSystemPrompt(e.target.value);
          }}
        />
        <p className="muted">Instructions only. Limits and approvals are enforced by the engine.</p>
      </div>
      <fieldset className="field choice" aria-describedby={ids.tools}>
        <legend className="field__label">Tools</legend>
        <p id={ids.tools} className="muted">
          The stripe is the blast radius: none for reversible, amber for costly, red for
          irreversible.
        </p>
        {tools.data === null ? (
          <p className="muted">{tools.error ?? 'Loading tools'}</p>
        ) : (
          <ul className="tool-picker" role="list">
            {activeTools.map((tool) => (
              <li key={tool.name} className={`tool-picker__item action--${tool.blastRadius}`}>
                <label className="tool-picker__label">
                  <input
                    type="checkbox"
                    checked={picked.has(tool.name)}
                    onChange={() => {
                      toggle(tool.name);
                    }}
                  />
                  <span className="tool-picker__name">{tool.name}</span>
                  <span className="tool-picker__radius">{tool.blastRadius}</span>
                  <span className="tool-picker__desc">{tool.description}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error !== null && (
        <p id={ids.error} className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="form__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Saving' : initial ? 'Save changes' : 'Create agent'}
        </button>
      </div>
    </form>
  );
}
