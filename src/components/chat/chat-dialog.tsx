'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { admin as s } from '@/components/admin';

/**
 * A dialog the chat screen opens from its own state — withdrawing a message
 * asks for a reason, and the reason belongs in a window, not in a prompt.
 *
 * The markup and classes are `NewRecordDialog`'s own (a native `<dialog>`,
 * `dialog` / `dialogBody` / `dialogHeader` / `dialogClose`); only the button
 * that opens it is missing, because here the screen decides when.
 */
export function ChatDialog({
  open,
  title,
  closeLabel,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-labelledby={titleId}
      className={s.dialog}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      onClose={onClose}
      ref={ref}
    >
      <div className={s.dialogBody}>
        <header className={s.dialogHeader}>
          <h2 id={titleId}>{title}</h2>
          <button aria-label={closeLabel} className={s.dialogClose} onClick={onClose} type="button">
            <X aria-hidden="true" />
          </button>
        </header>
        {open ? children : null}
      </div>
    </dialog>
  );
}
