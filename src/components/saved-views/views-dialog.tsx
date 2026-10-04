'use client';

import { useId, useRef, type ReactNode } from 'react';
import { Bookmark, X } from 'lucide-react';
import styles from '../admin/admin.module.css';

/**
 * The "Views" button beside a screen's filters, and the window it opens.
 *
 * The window is a server component passed in as children — the save form, the
 * person's views and their actions are forms posting to server actions exactly
 * as they would on the page — so this only decides when it is on screen. It
 * sits in the toolbar rather than in the filter form because a dialog holding
 * forms cannot be nested in the filters' own GET form.
 *
 * A native <dialog>, like every other window in the application: focus is
 * trapped, Escape closes it, and the page behind is inert.
 */
export function ViewsDialog({
  label,
  title,
  closeLabel,
  count,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  /** How many views the person keeps for this screen. */
  readonly count: number;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  return (
    <>
      <button
        aria-haspopup="dialog"
        className={`${styles.button} ${styles.small}`}
        onClick={() => ref.current?.showModal()}
        type="button"
      >
        <Bookmark aria-hidden="true" />
        <span>{count > 0 ? `${label} (${count})` : label}</span>
      </button>
      <dialog
        aria-labelledby={headingId}
        className={`${styles.dialog} ${styles.dialogWide}`}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id={headingId}>{title}</h2>
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
