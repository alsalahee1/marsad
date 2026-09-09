import { useEffect, useRef, type RefObject } from 'react';

/** Matches --dur-flash in marsad-theme.css. */
export const FLASH_MS = 600;

/**
 * The one ambient motion the desk allows: `[data-changed="true"]` for 600ms after a value
 * changes (never on first render). The attribute is toggled straight on the DOM node, so a
 * burst of changes does not re-render anything, and the reflow between remove and add
 * restarts the CSS animation. Under prefers-reduced-motion the theme shortens it to 1ms.
 */
export function useFlashOnChange<T extends HTMLElement>(value: unknown): RefObject<T | null> {
  const ref = useRef<T>(null);
  const previous = useRef(value);

  useEffect(() => {
    if (Object.is(previous.current, value)) return undefined;
    previous.current = value;
    const el = ref.current;
    if (!el) return undefined;
    el.removeAttribute('data-changed');
    el.getBoundingClientRect(); // flush styles so the animation restarts on re-add
    el.setAttribute('data-changed', 'true');
    const timer = setTimeout(() => {
      el.removeAttribute('data-changed');
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value]);

  return ref;
}
