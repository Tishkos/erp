'use client';

import { useId, useRef, type ReactNode } from 'react';
import { ListFilter, X } from 'lucide-react';
import styles from './admin.module.css';

/**
 * The "Filter" button of a register's toolbar and the window it opens
 * (2026-10-07, by direction: "just add filter button for it and do that for
 * table"). The form inside is a server component passed in as children
 * (`register-filter.tsx`); this only decides when it is on screen.
 *
 * A native <dialog>, as the Views window beside it: focus is trapped, Escape
 * closes it, the page behind is inert, and the date pickers open in its layer.
 * The button says how many things are asked for, and is drawn chosen while any is.
 */
export function RegisterFilterDialog({
  label,
  title,
  closeLabel,
  active,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  /** How many of from / to / oldest-first are set — 0 is the register as it comes. */
  readonly active: number;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  return (
    <>
      <button
        aria-haspopup="dialog"
        className={`${styles.button} ${styles.small}`}
        data-active={active > 0 ? 'true' : undefined}
        data-register-filter=""
        onClick={() => ref.current?.showModal()}
        type="button"
      >
        <ListFilter aria-hidden="true" />
        <span>{active > 0 ? `${label} (${active})` : label}</span>
      </button>
      <dialog
        aria-labelledby={headingId}
        className={styles.dialog}
        data-register-filter-dialog=""
        onClick={(event) => {
          // The backdrop closes it; so does following the Clear link out of it.
          const target = event.target as HTMLElement;
          if (target === ref.current || target.closest('a[href]')) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id={headingId}>{title}</h2>
            <button aria-label={closeLabel} className={styles.dialogClose} onClick={() => ref.current?.close()} type="button">
              <X aria-hidden="true" />
            </button>
          </header>
          {children}
        </div>
      </dialog>
    </>
  );
}
