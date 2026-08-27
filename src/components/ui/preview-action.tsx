'use client';

import { useRef, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';
import styles from './ui.module.css';

/**
 * An action button on a screen that is not wired to anything yet.
 *
 * Every button on all 213 preview screens did nothing when clicked. That is
 * worse than it sounds: a reader cannot tell a button that is *not built* from
 * one that is *broken*, so the first thing they do is doubt the rest of the
 * screen. Answering the click — and saying plainly that nothing was written —
 * turns the same screen from a picture into something you can walk through.
 *
 * A native `<dialog>` with `showModal()`, so focus is trapped, Escape closes,
 * and the backdrop comes from the platform rather than from a div pretending
 * to be one. `closedby="any"` lets a click outside dismiss it where supported;
 * the explicit Close button is there for everywhere else.
 */
export function PreviewAction({
  label,
  icon,
  tone = 'secondary',
  noticeTitle,
  noticeBody,
  badge,
  close,
}: {
  readonly label: string;
  /*
   * A rendered element, not a component. Lucide icons are functions, and a
   * function cannot cross the server/client boundary — passing one threw
   * "Functions cannot be passed directly to Client Components". An element is
   * serialisable, so the server renders the glyph and this only places it.
   */
  readonly icon?: ReactNode;
  readonly tone?: 'primary' | 'secondary';
  readonly noticeTitle: string;
  readonly noticeBody: string;
  readonly badge: string;
  readonly close: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        className={`${styles.button} ${tone === 'primary' ? styles.primary : styles.secondary}`}
        onClick={() => dialog.current?.showModal()}
        type="button"
      >
        {icon}
        <span>{label}</span>
      </button>

      <dialog className={styles.dialog} ref={dialog}>
        <div className={styles.dialogHead}>
          <h2>{label}</h2>
          <button
            aria-label={close}
            className={styles.dialogClose}
            onClick={() => dialog.current?.close()}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <p className={styles.dialogNotice}>
          <Info aria-hidden="true" />
          <span>
            <strong>{noticeTitle}</strong>
            {noticeBody}
          </span>
        </p>

        <div className={styles.dialogActions}>
          <span className={styles.dialogBadge}>{badge}</span>
          <button
            className={`${styles.button} ${styles.primary}`}
            onClick={() => dialog.current?.close()}
            type="button"
          >
            {close}
          </button>
        </div>
      </dialog>
    </>
  );
}
