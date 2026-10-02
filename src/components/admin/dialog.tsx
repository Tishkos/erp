'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import styles from './admin.module.css';

/**
 * "New record" — a button in the page header that opens a dialog holding the
 * form. The form itself is a server component passed in as children, so the
 * dialog adds nothing to what the action receives; it only decides when the
 * form is on screen.
 *
 * A native <dialog>: focus is trapped, Escape closes it, and the page behind
 * is inert while it is open. If the action came back with an error the page
 * reopens it, so the message is read next to the fields it is about.
 */
export function NewRecordDialog({
  buttonLabel,
  title,
  closeLabel,
  openOnLoad = false,
  wide = false,
  children,
}: {
  readonly buttonLabel: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly openOnLoad?: boolean;
  /**
   * For a form built round a grid of lines rather than a column of fields. A
   * document is read across as well as down, and 44rem cannot hold a line.
   */
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Its own title id: a page with two dialogs (Bank Deposits has a cash and an
  // other deposit) named both after the first one's title.
  const titleId = useId();

  useEffect(() => {
    if (openOnLoad && ref.current && !ref.current.open) ref.current.showModal();
  }, [openOnLoad]);

  return (
    <>
      <button
        className={`${styles.button} ${styles.primary}`}
        onClick={() => ref.current?.showModal()}
        type="button"
      >
        <Plus aria-hidden="true" />
        <span>{buttonLabel}</span>
      </button>
      <dialog
        aria-labelledby={titleId}
        className={wide ? `${styles.dialog} ${styles.dialogWide}` : styles.dialog}
        onClick={(event) => {
          // A click on the backdrop (the dialog element itself, not its content) closes it.
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id={titleId}>{title}</h2>
            <button
              aria-label={closeLabel}
              className={styles.dialogClose}
              onClick={() => ref.current?.close()}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          {children}
        </div>
      </dialog>
    </>
  );
}
