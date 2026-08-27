'use client';

import { useRef } from 'react';
import { Trash2 } from 'lucide-react';
import styles from './admin.module.css';

/**
 * An action that asks first.
 *
 * Deleting a draft is the one thing in this system that removes rows rather
 * than adding a status to them, so it is the one thing that gets a question
 * before it happens. A native <dialog>: focus is trapped, Escape cancels, and
 * the page behind is inert while it is open.
 *
 * The form is a real form posting to the server action, so the confirmation is
 * the only thing this component decides. Without JavaScript the button submits
 * directly — which is the right failure: the server still checks the document
 * is a draft and that this person may edit it.
 */
export function ConfirmButton({
  action,
  hidden,
  label,
  title,
  body,
  confirmLabel,
  cancelLabel,
}: {
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly hidden: Readonly<Record<string, string>>;
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        className={`${styles.button} ${styles.danger}`}
        onClick={() => ref.current?.showModal()}
        type="button"
      >
        <Trash2 aria-hidden="true" />
        <span>{label}</span>
      </button>

      <dialog
        aria-labelledby="confirm-dialog-title"
        className={styles.dialog}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id="confirm-dialog-title">{title}</h2>
          </header>
          <p className={styles.sectionHint}>{body}</p>
          <form action={action} className={styles.confirmActions}>
            {Object.entries(hidden).map(([name, value]) => (
              <input key={name} name={name} type="hidden" value={value} />
            ))}
            <button
              className={styles.button}
              onClick={() => ref.current?.close()}
              type="button"
            >
              {cancelLabel}
            </button>
            <button className={`${styles.button} ${styles.danger}`} type="submit">
              {confirmLabel}
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
