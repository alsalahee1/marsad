import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons.js';

/** Browsers give us the top layer; a DOM without `showModal` (tests) just gets the open attribute. */
export function openModal(el: HTMLDialogElement): void {
  if (el.open) return;
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');
}

export function closeModal(el: HTMLDialogElement): void {
  if (!el.open) return;
  if (typeof el.close === 'function') el.close();
  else el.removeAttribute('open');
}

interface OverlayProps {
  /** `sheet` is the phone's full-screen surface; `dialog` is the centred one elsewhere. */
  mode: 'sheet' | 'dialog';
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Native <dialog>: focus trapping, Escape, and the top layer come from the platform. On phone
 * it is a full-screen sheet with a 44px close target under the thumb; elsewhere a dialog
 * floating at elevation 3.
 */
export function Overlay({ mode, title, onClose, children }: OverlayProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    openModal(el);
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => {
      el.removeEventListener('cancel', onCancel);
      closeModal(el);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={`overlay overlay--${mode}`}
      aria-label={title}
      onClick={(e) => {
        // Backdrop click closes the dialog; the sheet fills the screen so this never fires there.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="overlay__frame">
        <header className="overlay__head">
          <h2 className="overlay__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div className="overlay__body">{children}</div>
      </div>
    </dialog>
  );
}
