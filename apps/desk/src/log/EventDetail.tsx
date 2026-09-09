import type { Event } from '@marsad/shared';
import { useState } from 'react';
import { CopyIcon } from '../lib/Icons.js';
import { formatDateTime } from '../lib/format.js';
import { blastRadiusOf, impliedRunState } from './summarize.js';

/** Full view of one event: envelope fields, then the payload exactly as the engine wrote it. */
export function EventDetail({ event }: { event: Event }) {
  const [copied, setCopied] = useState(false);
  const radius = blastRadiusOf(event);
  const state = impliedRunState(event);
  const text = JSON.stringify(event, null, 2);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={`detail ${radius ? `action--${radius}` : ''}`.trim()}>
      <header className="detail__head">
        <span className="state-dot" data-state={state ?? 'none'} aria-hidden="true" />
        <h3 className="detail__type">{event.type}</h3>
        {radius !== null && <span className="detail__radius">{radius}</span>}
      </header>
      <dl className="detail__meta">
        <dt>id</dt>
        <dd className="num">{event.id}</dd>
        <dt>at</dt>
        <dd>
          <time dateTime={event.at}>{formatDateTime(event.at)}</time>
        </dd>
        <dt>run</dt>
        <dd className="num detail__wrap">{event.runId ?? '—'}</dd>
      </dl>
      <div className="detail__payload-head">
        <span>payload</span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void copy();
          }}
          aria-live="polite"
        >
          <CopyIcon width="16" height="16" />
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
      </div>
      <pre className="detail__payload num">{JSON.stringify(event.payload, null, 2)}</pre>
    </article>
  );
}
