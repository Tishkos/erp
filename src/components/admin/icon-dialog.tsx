'use client';

import { useId, useRef, type ReactNode } from 'react';
import { History, Paperclip, X } from 'lucide-react';
import styles from './admin.module.css';

/**
 * A small icon on the document that opens a window over it.
 *
 * The attachments of a journal are paperwork, not the journal: a paperclip
 * with a count is all the document needs to carry, and the files themselves
 * are read in a dialog that closes back onto the entry (by direction,
 * 2026-08-29). The same is true of its history — and of anything else a
 * document has but is not — so the door is one component and the icon is a
 * parameter.
 *
 * The content is a server component passed in as children, so a form inside
 * it posts to its action exactly as it did on the page.
 */
export function IconDialog({
  icon,
  count,
  label,
  title,
  closeLabel,
  children,
}: {
  readonly icon: ReactNode;
  /** Shown on the icon when there is something to count. Zero shows nothing. */
  readonly count?: number;
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Two doors on one document would otherwise share a heading id, and a
  // screen reader would announce the wrong one.
  const headingId = useId();
  const showing = typeof count === 'number' && count > 0;

  return (
    <>
      <button
        aria-label={showing ? `${label} (${count})` : label}
        className={styles.sapIconButton}
        onClick={() => ref.current?.showModal()}
        title={label}
        type="button"
      >
        {icon}
        {showing ? <span className={styles.sapIconCount}>{count}</span> : null}
      </button>
      <dialog
        aria-labelledby={headingId}
        className={styles.dialog}
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

/** The paperclip: a document's paperwork, with how many there are. */
export function AttachmentsButton(props: {
  readonly count: number;
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  return <IconDialog icon={<Paperclip aria-hidden="true" />} {...props} />;
}

/**
 * The clock: what has happened to this document.
 *
 * A record's history is a long list that belongs behind a door rather than
 * under the document — the document is the document (2026-10-03).
 */
export function HistoryButton(props: {
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  return <IconDialog icon={<History aria-hidden="true" />} {...props} />;
}
