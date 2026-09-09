/** Formatting helpers. Every output lands in a `.num` cell, so nothing here adds a unit word. */

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** `HH:MM:SS` in the operator's zone plus the milliseconds apart, so a narrow row can drop them. */
export function formatClockParts(iso: string): { time: string; ms: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { time: '--:--:--', ms: '.---' };
  return { time: timeFormatter.format(d), ms: `.${String(d.getMilliseconds()).padStart(3, '0')}` };
}

/** `HH:MM:SS.mmm`: wide enough to order events, short enough for a row. */
export function formatClock(iso: string): string {
  const { time, ms } = formatClockParts(iso);
  return `${time}${ms}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dateTimeFormatter.format(d);
}

/** First block of a UUID: enough to tell runs apart in a row, the full id lives in the detail. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatUsd(usd: number): string {
  return usd.toFixed(4);
}

export function formatInt(n: number): string {
  return new Intl.NumberFormat(undefined, { useGrouping: true }).format(n);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
