import type { ReactNode } from 'react';
import { useFlashOnChange } from './useFlash.js';

interface MetricProps {
  label: string;
  /** Already formatted; rendered tabular and flashed for 600ms when it changes. */
  value: string;
  sub?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * One of the four questions, answered in one number. The value has a fixed minimum width so
 * it never moves its neighbours when it updates; the flash is the desk's only ambient motion.
 */
export function Metric({ label, value, sub, children, className = '' }: MetricProps) {
  const ref = useFlashOnChange<HTMLSpanElement>(value);
  return (
    <section className={`panel metric ${className}`.trim()} aria-label={label}>
      <h2 className="metric__label">{label}</h2>
      <p className="metric__value">
        <span ref={ref} className="num metric__number">
          {value}
        </span>
      </p>
      {sub !== undefined && <p className="metric__sub">{sub}</p>}
      {children !== undefined && <div className="metric__body">{children}</div>}
    </section>
  );
}
