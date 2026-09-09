import { useId, type ReactNode } from 'react';

interface PanelProps {
  title: string;
  /** Header controls: buttons, toggles, live counters. */
  actions?: ReactNode;
  /** Fill the grid cell and let the body scroll instead of growing. */
  fill?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A panel resting on the desk: hairline border, no shadow (elevation is for things that
 * float), sentence-case title. Every view is a grid of these.
 */
export function Panel({ title, actions, fill = false, className = '', children }: PanelProps) {
  const headingId = useId();
  return (
    <section
      className={`panel desk-panel ${fill ? 'desk-panel--fill' : ''} ${className}`.trim()}
      aria-labelledby={headingId}
    >
      <header className="desk-panel__head">
        <h2 id={headingId} className="desk-panel__title">
          {title}
        </h2>
        {actions !== undefined && <div className="desk-panel__actions">{actions}</div>}
      </header>
      <div className="desk-panel__body">{children}</div>
    </section>
  );
}
