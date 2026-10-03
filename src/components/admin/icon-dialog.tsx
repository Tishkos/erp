'use client';

import { useId, useRef, type ReactNode } from 'react';
import { History, MessageSquare, Paperclip, Printer, X } from 'lucide-react';
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
  wide,
  children,
}: {
  readonly icon: ReactNode;
  /** Shown on the icon when there is something to count. Zero shows nothing. */
  readonly count?: number;
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  /**
   * A table behind the door rather than a column of fields — the same
   * `dialogWide` the line-grid dialogs wear. Narrow, a table of notes had to
   * be scrolled sideways to be read (2026-10-03).
   */
  readonly wide?: boolean;
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
        className={wide ? `${styles.dialog} ${styles.dialogWide}` : styles.dialog}
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
  return <IconDialog icon={<History aria-hidden="true" />} wide {...props} />;
}

/**
 * The speech mark: what people have said about this document.
 *
 * A bill's notes are a conversation beside it — who said what, and when — and
 * like its paperwork and its history they belong behind a door rather than
 * under the lines (by direction, 2026-10-03). The count is how many have been
 * written.
 */
export function NotesButton(props: {
  readonly count: number;
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  return <IconDialog icon={<MessageSquare aria-hidden="true" />} wide {...props} />;
}

/**
 * The printer: the document's copies — PDF, Excel and Word, in English and in
 * Arabic — behind the third door in the title bar, beside the paperclip and
 * the clock (by direction, 2026-10-03: "attachment, print and audit icon as
 * other pages"). The links are the Print / Export menu's own.
 */
export function PrintButton(props: {
  readonly label: string;
  readonly title: string;
  readonly closeLabel: string;
  readonly children: ReactNode;
}) {
  return <IconDialog icon={<Printer aria-hidden="true" />} {...props} />;
}
