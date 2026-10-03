'use client';

import { useId, useRef } from 'react';
import styles from './admin.module.css';

/** A destructive document action that requires a reason and a second click. */
export function ConfirmReasonForm({
  action,
  hidden,
  label,
  title,
  body,
  reasonLabel,
  reasonPlaceholder,
  confirmLabel,
  cancelLabel,
}: {
  readonly action: (formData: FormData) => void | Promise<void>;
  readonly hidden: Readonly<Record<string, string>>;
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly reasonLabel: string;
  readonly reasonPlaceholder?: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const reasonId = `${id}-reason`;

  return (
    <>
      <button className={`${styles.button} ${styles.danger}`} onClick={() => ref.current?.showModal()} type="button">
        {label}
      </button>
      <dialog
        aria-labelledby={titleId}
        className={styles.dialog}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id={titleId}>{title}</h2>
          </header>
          <p className={styles.sectionHint}>{body}</p>
          <form action={action} className={styles.confirmReasonForm}>
            {Object.entries(hidden).map(([name, value]) => (
              <input key={name} name={name} type="hidden" value={value} />
            ))}
            <div className={styles.field}>
              <label className={styles.label} htmlFor={reasonId}>{reasonLabel}</label>
              <input autoComplete="off" className={styles.input} id={reasonId} name="reason" placeholder={reasonPlaceholder} required />
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.button} onClick={() => ref.current?.close()} type="button">
                {cancelLabel}
              </button>
              <button className={`${styles.button} ${styles.danger}`} type="submit">
                {confirmLabel}
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}
