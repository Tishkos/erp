'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import styles from './admin.module.css';

/**
 * The header of a draft journal — its two dates and its description — edited
 * in the boxes where a posted entry shows them read-only.
 *
 * Saved when a box is left, not on a button: the entry opened dated today,
 * and most of the time today is right. A refusal (a date outside the entry's
 * year, a document date after the posting date) is shown beside the boxes.
 */
export function JournalHeaderForm({
  journalId,
  entryNo,
  documentDate,
  postingDate,
  description,
  labels,
  save,
}: {
  readonly journalId: string;
  readonly entryNo: string;
  readonly documentDate: string;
  readonly postingDate: string;
  readonly description: string;
  readonly labels: {
    readonly documentDate: string;
    readonly postingDate: string;
    readonly description: string;
    readonly postingDateHint: string;
  };
  readonly save: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [values, setValues] = useState({ documentDate, postingDate, description });
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (
      values.documentDate === documentDate &&
      values.postingDate === postingDate &&
      values.description === description
    ) {
      return;
    }
    const form = new FormData();
    form.set('id', journalId);
    form.set('entryNo', entryNo);
    form.set('documentDate', values.documentDate);
    form.set('postingDate', values.postingDate);
    form.set('description', values.description);
    startTransition(async () => {
      const outcome = await save(form);
      if (outcome.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(outcome.error ?? '');
      }
    });
  };

  return (
    <>
      <div className={styles.sapField}>
        <label className={styles.sapLabel} htmlFor="journal-posting-date">
          {labels.postingDate}
        </label>
        <input
          id="journal-posting-date"
          onBlur={commit}
          onChange={(event) => setValues((v) => ({ ...v, postingDate: event.target.value }))}
          title={labels.postingDateHint}
          type="date"
          value={values.postingDate}
        />
      </div>
      <div className={styles.sapField}>
        <label className={styles.sapLabel} htmlFor="journal-document-date">
          {labels.documentDate}
        </label>
        <input
          id="journal-document-date"
          onBlur={commit}
          onChange={(event) => setValues((v) => ({ ...v, documentDate: event.target.value }))}
          type="date"
          value={values.documentDate}
        />
      </div>
      <div className={`${styles.sapField} ${styles.sapWide}`}>
        <label className={styles.sapLabel} htmlFor="journal-description">
          {labels.description}
        </label>
        <input
          autoComplete="off"
          dir="auto"
          id="journal-description"
          onBlur={commit}
          onChange={(event) => setValues((v) => ({ ...v, description: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          type="text"
          value={values.description}
        />
        {error ? (
          <span className={styles.sapRowError} role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </>
  );
}
