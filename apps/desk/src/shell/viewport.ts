import { useSyncExternalStore } from 'react';

/** CLAUDE.md §5 breakpoints. The CSS media queries use the same numbers; both must agree. */
export type Viewport = 'phone' | 'fold' | 'tablet' | 'desktop' | 'wide';

const QUERIES = {
  fold: '(min-width: 600px)',
  tablet: '(min-width: 768px)',
  desktop: '(min-width: 1024px)',
  wide: '(min-width: 1440px)',
} as const;

export function classifyWidth(width: number): Viewport {
  if (width >= 1440) return 'wide';
  if (width >= 1024) return 'desktop';
  if (width >= 768) return 'tablet';
  if (width >= 600) return 'fold';
  return 'phone';
}

function current(): Viewport {
  if (typeof matchMedia !== 'function') return 'desktop';
  if (matchMedia(QUERIES.wide).matches) return 'wide';
  if (matchMedia(QUERIES.desktop).matches) return 'desktop';
  if (matchMedia(QUERIES.tablet).matches) return 'tablet';
  if (matchMedia(QUERIES.fold).matches) return 'fold';
  return 'phone';
}

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const lists = Object.values(QUERIES).map((q) => matchMedia(q));
  for (const l of lists) l.addEventListener('change', onChange);
  return () => {
    for (const l of lists) l.removeEventListener('change', onChange);
  };
}

export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, current, () => 'desktop');
}
