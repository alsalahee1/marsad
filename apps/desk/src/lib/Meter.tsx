import { formatInt } from './format.js';

export type MeterLevel = 'ok' | 'warn' | 'breach';

/** Below 75% of the cap is fine, up to the cap is a warning, at or past it is a breach. */
export function meterLevel(value: number, cap: number): MeterLevel {
  if (cap <= 0) return value > 0 ? 'breach' : 'ok';
  const ratio = value / cap;
  if (ratio >= 1) return 'breach';
  if (ratio >= 0.75) return 'warn';
  return 'ok';
}

interface MeterProps {
  label: string;
  value: number;
  cap: number;
  /** Already-formatted numbers for the readout; defaults to grouped integers. */
  format?: (n: number) => string;
  unit?: string;
}

/**
 * A ceiling or cap against its usage. The bar is a `--budget-*` token by level; the readout is
 * tabular so a live value never shifts the layout.
 */
export function Meter({ label, value, cap, format = formatInt, unit }: MeterProps) {
  const level = meterLevel(value, cap);
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : value > 0 ? 100 : 0;
  return (
    <div className="meter" data-level={level}>
      <div className="meter__row">
        <span className="meter__label">{label}</span>
        <span className="meter__readout">
          <span className="num">{format(value)}</span>
          <span className="meter__of"> / </span>
          <span className="num">{format(cap)}</span>
          {unit !== undefined && <span className="meter__unit"> {unit}</span>}
        </span>
      </div>
      <div
        className="meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(value, cap)}
      >
        <div className="meter__fill" style={{ inlineSize: `${pct}%` }} />
      </div>
    </div>
  );
}
