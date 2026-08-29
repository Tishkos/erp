'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Plus, TriangleAlert, X } from 'lucide-react';
import styles from './admin.module.css';

/**
 * "New account" — the dialog, and the form inside it, in one client piece.
 *
 * The earlier form was a server-action form inside a client dialog, and a
 * press made before the page had finished hydrating was dropped without a
 * word: the page refreshed, the dialog closed, and everything typed was gone
 * — the "does not work from the first try" of 2026-08-29. Two things fix it:
 *
 *   - the Create button cannot be pressed until the component has mounted,
 *     which is the earliest moment the action can run;
 *   - the action returns rather than redirects, so a refusal is shown beside
 *     the fields with everything still in them, and success moves to the
 *     account from here.
 */
export interface PickerOption {
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

export interface NewAccountLabels {
  readonly button: string;
  readonly title: string;
  readonly close: string;
  readonly parent: string;
  readonly parentHint: string;
  readonly name: string;
  readonly kind: string;
  readonly kindHint: string;
  readonly kindPosting: string;
  readonly kindGroup: string;
  readonly description: string;
  readonly create: string;
  readonly creating: string;
  readonly errorTitle: string;
  readonly required: string;
  readonly noParent: string | null;
}

export function NewAccountDialog({
  parents,
  defaultParent,
  labels,
  create,
}: {
  readonly parents: readonly PickerOption[];
  readonly defaultParent: string;
  readonly labels: NewAccountLabels;
  readonly create: (formData: FormData) => Promise<{ ok: boolean; error?: string; code?: string }>;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setReady(true), []);

  return (
    <>
      <button
        className={`${styles.button} ${styles.primary}`}
        onClick={() => ref.current?.showModal()}
        type="button"
      >
        <Plus aria-hidden="true" />
        <span>{labels.button}</span>
      </button>
      <dialog
        aria-labelledby="new-account-title"
        className={styles.dialog}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id="new-account-title">{labels.title}</h2>
            <button
              aria-label={labels.close}
              className={styles.dialogClose}
              onClick={() => ref.current?.close()}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>

          {error ? (
            <p className={`${styles.flash} ${styles.flashError}`} role="alert">
              <TriangleAlert aria-hidden="true" />
              <span>
                <strong>{labels.errorTitle}</strong>
                {error}
              </span>
            </p>
          ) : null}

          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              startTransition(async () => {
                const outcome = await create(form);
                if (outcome.ok && outcome.code) {
                  setError(null);
                  ref.current?.close();
                  router.push(`/master-data/chart-of-accounts/${encodeURIComponent(outcome.code)}`);
                } else {
                  setError(outcome.error ?? '');
                }
              });
            }}
          >
            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-account-parent">
                  {labels.parent}
                </label>
                <select
                  className={styles.select}
                  defaultValue={defaultParent}
                  id="new-account-parent"
                  name="parentId"
                  required
                >
                  {parents.map((option) => (
                    <option disabled={option.disabled} key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className={styles.hint}>{labels.parentHint}</span>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-account-name">
                  {labels.name}
                  <span aria-hidden="true" className={styles.required} title={labels.required}>
                    *
                  </span>
                </label>
                <input
                  autoComplete="off"
                  className={styles.input}
                  id="new-account-name"
                  name="name"
                  required
                  type="text"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="new-account-kind">
                  {labels.kind}
                </label>
                <select className={styles.select} defaultValue="posting" id="new-account-kind" name="isGroup">
                  <option value="posting">{labels.kindPosting}</option>
                  <option value="group">{labels.kindGroup}</option>
                </select>
                <span className={styles.hint}>{labels.kindHint}</span>
              </div>
              <div className={`${styles.field} ${styles.fieldWide}`}>
                <label className={styles.label} htmlFor="new-account-description">
                  {labels.description}
                </label>
                <textarea className={styles.textarea} id="new-account-description" name="description" />
              </div>
            </div>
            <div className={styles.submitRow}>
              <button className={`${styles.button} ${styles.primary}`} disabled={!ready || pending} type="submit">
                {pending ? labels.creating : labels.create}
              </button>
            </div>
          </form>
          {labels.noParent ? <p className={styles.sectionHint}>{labels.noParent}</p> : null}
        </div>
      </dialog>
    </>
  );
}
