import { useCallback, useRef, useState, type PointerEvent, type ReactNode } from 'react';

export type SwipeSide = 'leading' | 'trailing';

/** How far (px) a drag must travel before an action is revealed, and the open width. */
export const SWIPE_THRESHOLD_PX = 56;
export const SWIPE_OPEN_PX = 104;

/**
 * Which side a horizontal drag reveals, given its delta and the writing direction. Dragging
 * toward the end of the line uncovers the leading action; toward the start, the trailing one.
 */
export function swipeSideFor(deltaX: number, rtl: boolean): SwipeSide | null {
  if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return null;
  const towardEnd = rtl ? deltaX < 0 : deltaX > 0;
  return towardEnd ? 'leading' : 'trailing';
}

interface SwipeableProps {
  /** Rendered under the row on the leading side (uncovered by dragging toward the end). */
  leading: ReactNode;
  /** Rendered under the row on the trailing side (uncovered by dragging toward the start). */
  trailing: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}

/**
 * Phone: a row that slides to uncover one action on each side. The drag reveals; a tap on the
 * uncovered button acts. Nothing fires on release, so an irreversible approval is always two
 * deliberate gestures. Pointer events only, so it works for touch and for a mouse in tests.
 */
export function Swipeable({ leading, trailing, disabled = false, children }: SwipeableProps) {
  const [open, setOpen] = useState<SwipeSide | null>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);

  const rtl = () => (typeof document !== 'undefined' ? document.dir === 'rtl' : false);
  const sign = (side: SwipeSide) => {
    // Leading action sits at the start edge; the row moves toward the end to show it.
    const towardEnd = side === 'leading';
    return (towardEnd ? 1 : -1) * (rtl() ? -1 : 1);
  };

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    },
    [disabled],
  );
  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s?.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dy) > Math.abs(dx)) return; // a scroll, not a swipe
    setDrag(Math.max(-SWIPE_OPEN_PX, Math.min(SWIPE_OPEN_PX, dx)));
  }, []);
  const onPointerUp = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (s?.id !== e.pointerId) return;
    start.current = null;
    const dx = e.clientX - s.x;
    setDrag(0);
    setOpen(swipeSideFor(dx, rtl()));
  }, []);

  const offset = open ? sign(open) * SWIPE_OPEN_PX : drag;
  return (
    <div className="swipe" data-open={open ?? 'none'}>
      <div className="swipe__action swipe__action--leading" aria-hidden={open !== 'leading'}>
        {leading}
      </div>
      <div className="swipe__action swipe__action--trailing" aria-hidden={open !== 'trailing'}>
        {trailing}
      </div>
      <div
        className="swipe__row"
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => {
          if (open) setOpen(null);
        }}
      >
        {children}
      </div>
    </div>
  );
}
