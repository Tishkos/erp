'use client';

import { useRef, type ReactNode } from 'react';
import { Paperclip, X } from 'lucide-react';
import styles from './admin.module.css';

/**
 * A small icon on the document that opens a window over it.
 *
 * The attachments of a journal are paperwork, not the journal: a paperclip
 * with a count is all the document needs to carry, and the files themselves
 * are read in a dialog that closes back onto the entry (by direction,
 * 2026-08-29). The content is a server component passed in as children, so
 * the upload form posts to its action exactly as it did on the page.
 */
export function AttachmentsButton({
  count,
  label,
  title,
  closeLabel,
  children,
}: {
  readonly count: number;
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        aria-label={count > 0 ? `${label} (${count})` : label}
        className={styles.sapIconButton}
        onClick={() => ref.current?.showModal()}
        title={label}
        type="button"
      >
        <Paperclip aria-hidden="true" />
        {count > 0 ? <span className={styles.sapIconCount}>{count}</span> : null}
      </button>
      <dialog
        aria-labelledby="attachments-dialog-title"
        className={styles.dialog}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id="attachments-dialog-title">{title}</h2>
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
