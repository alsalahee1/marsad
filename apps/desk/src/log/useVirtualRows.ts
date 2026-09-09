import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface VirtualWindow {
  /** First rendered index (inclusive). */
  start: number;
  /** Last rendered index (exclusive). */
  end: number;
  totalHeight: number;
}

/** Pure window maths, so the hook stays trivial and this stays testable. */
export function virtualWindow(input: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan: number;
}): VirtualWindow {
  const { scrollTop, viewportHeight, rowHeight, count, overscan } = input;
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0, totalHeight: 0 };
  const first = Math.floor(scrollTop / rowHeight);
  const visible = Math.ceil(viewportHeight / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, totalHeight: count * rowHeight };
}

/** `--row-active` from the theme, read from the node so density and the phone override apply. */
export function readRowHeight(el: HTMLElement, fallback: number): number {
  const raw = getComputedStyle(el).getPropertyValue('--row-active').trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface VirtualRows extends VirtualWindow {
  rowHeight: number;
  /** Scroll so `index` is in view; `align: 'end'` puts it at the bottom. */
  scrollToIndex(index: number, align?: 'start' | 'end' | 'nearest'): void;
  /** True when the scroll position is within one row of the tail. */
  isAtTail(): boolean;
}

const FALLBACK_ROW = 28;

/**
 * Fixed-height row virtualisation over a scrolling container. Rows are identical in height by
 * design (one line each; detail lives in the inspector), which keeps the maths exact and the
 * follow-tail behaviour predictable.
 */
export function useVirtualRows(
  containerRef: RefObject<HTMLElement | null>,
  count: number,
  overscan = 8,
): VirtualRows {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW);
  const frame = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => {
      setViewportHeight(el.clientHeight);
      setRowHeight(readRowHeight(el, FALLBACK_ROW));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [containerRef]);

  const scrollToIndex = useCallback(
    (index: number, align: 'start' | 'end' | 'nearest' = 'nearest') => {
      const el = containerRef.current;
      if (!el) return;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      const viewTop = el.scrollTop;
      const viewBottom = viewTop + el.clientHeight;
      const target = (): number | null => {
        if (align === 'start') return top;
        if (align === 'end') return bottom - el.clientHeight;
        if (top < viewTop) return top;
        if (bottom > viewBottom) return bottom - el.clientHeight;
        return null;
      };
      const next = target();
      if (next === null) return;
      el.scrollTop = Math.max(0, next);
      setScrollTop(el.scrollTop);
    },
    [containerRef, rowHeight],
  );

  const isAtTail = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight;
  }, [containerRef, rowHeight]);

  return {
    ...virtualWindow({ scrollTop, viewportHeight, rowHeight, count, overscan }),
    rowHeight,
    scrollToIndex,
    isAtTail,
  };
}
