import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons.js';

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
    if (!el.open) el.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => {
      el.removeEventListener('cancel', onCancel);
      if (el.open) el.close();
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
