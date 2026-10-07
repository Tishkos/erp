'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, TriangleAlert, X } from 'lucide-react';
import styles from './admin.module.css';
import { IntentDateField } from './intent-date-field';
import { Submit } from './submit';

/**
 * "Set the due date for the balance" — the import application's question once
 * its advance is paid (2026-10-07, by direction: "once the payment
 * application is done, clicking the import application, a dialog comes up:
 * enter the due date, and it marks it").
 *
 * The house dialog (a native modal `<dialog>` in the Intent UI dress of
 * `admin.module.css`, so the date picker opens in its own top layer). It
 * opens by itself when the page asks (`autoOpen`) — once per browser tab
 * session: "Later" closes it, and it does not open by itself again in this tab
 * until the page is opened in a new one (`sessionStorage`). The banner's
 * button and the invoice record's "Set due date" open the same dialog.
 *
 * Save posts one server action that sets the date on every invoice of the
 * import still waiting for one. A refusal comes back as words and is shown
 * here, beside the field it is about; on success the page is read again.
 */
export interface BalanceDueDialogProps {
  readonly payableId: string;
  readonly autoOpen: boolean;
  /** Draw the opener button (the banner's, or the invoice record's action). */
  readonly opener?: { readonly label: string; readonly variant?: 'banner' | 'document' } | undefined;
  readonly paidLine: string;
  readonly owedText: string;
  /** The invoices the date is set on, their date and what they owe already in the reader's words. */
  readonly invoices: readonly { readonly invoiceNo: string; readonly invoiceDate: string; readonly owed: string; readonly href: string }[];
  readonly labels: {
    readonly title: string;
    readonly owed: string;
    readonly invoices: string;
    readonly invoiceNo: string;
    readonly invoiceDate: string;
    readonly field: string;
    readonly fieldHint: string;
    readonly save: string;
    readonly later: string;
    readonly close: string;
    readonly errorTitle: string;
  };
  readonly action: (formData: FormData) => Promise<{ readonly ok: boolean; readonly error?: string | undefined }>;
}

const ASKED = (payableId: string) => `erp.balance-due.asked.${payableId}`;

function askedThisTab(payableId: string): boolean {
  try {
    return window.sessionStorage.getItem(ASKED(payableId)) === '1';
  } catch {
    return false;
  }
}

function rememberAsked(payableId: string): void {
  try {
    window.sessionStorage.setItem(ASKED(payableId), '1');
  } catch {
    // A private window or blocked storage: it may ask again on the next visit, which is harmless.
  }
}

export function BalanceDueDialog({ payableId, autoOpen, opener, paidLine, owedText, invoices, labels, action }: BalanceDueDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fieldId = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!autoOpen || !dialog || dialog.open || askedThisTab(payableId)) return;
    rememberAsked(payableId);
    dialog.showModal();
  }, [autoOpen, payableId]);

  const open = () => {
    setError(null);
    ref.current?.showModal();
  };
  const later = () => {
    rememberAsked(payableId);
    ref.current?.close();
  };

  const save = async (formData: FormData) => {
    setError(null);
    const outcome = await action(formData);
    if (!outcome.ok) {
      setError(outcome.error ?? labels.errorTitle);
      return;
    }
    ref.current?.close();
    router.refresh();
  };

  return (
    <>
      {opener ? (
        <button
          className={opener.variant === 'document' ? 'action' : `${styles.button} ${styles.primary} ${styles.small}`}
          data-balance-due-open=""
          onClick={open}
          type="button"
        >
          {opener.variant === 'document' ? null : <CalendarClock aria-hidden="true" />}
          <span>{opener.label}</span>
        </button>
      ) : null}
      <dialog
        aria-labelledby={titleId}
        className={styles.dialog}
        data-balance-due-dialog=""
        onCancel={() => rememberAsked(payableId)}
        onClick={(event) => {
          // A click on the backdrop closes it, as "Later" does.
          if (event.target === ref.current) later();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2 id={titleId}>{labels.title}</h2>
            <button aria-label={labels.close} className={styles.dialogClose} onClick={later} type="button">
              <X aria-hidden="true" />
            </button>
          </header>
          <form action={save} className={styles.form}>
            <input name="payable_id" type="hidden" value={payableId} />
            <p className="text-sm text-fg" data-balance-due-paid="">
              {paidLine}
            </p>
            <p className="text-sm text-fg">
              <span className="text-muted-fg">{labels.owed}: </span>
              <strong>
                <bdi dir="ltr">{owedText}</bdi>
              </strong>
            </p>
            <div className={styles.sapTableWrap}>
              <table aria-label={labels.invoices} className={styles.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{labels.invoiceNo}</th>
                    <th scope="col">{labels.invoiceDate}</th>
                    <th className={styles.sapNum} scope="col">
                      {labels.owed}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.invoiceNo}>
                      <td className={styles.sapAccountCell}>
                        <a className={styles.sapLink} href={invoice.href}>
                          <bdi dir="ltr">{invoice.invoiceNo}</bdi>
                        </a>
                      </td>
                      <td>
                        <bdi dir="ltr">{invoice.invoiceDate}</bdi>
                      </td>
                      <td className={styles.sapNum}>
                        <bdi dir="ltr">{invoice.owed}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={fieldId}>
                {labels.field}
                <span aria-hidden="true" className={styles.required}>
                  *
                </span>
              </label>
              {/* No `min`: a date before an invoice's own is refused by the
                  service and said here in words, naming the invoice. */}
              <IntentDateField aria-describedby={`${fieldId}-hint`} id={fieldId} label={labels.field} name="due_date" required />
              <span className={styles.hint} id={`${fieldId}-hint`}>
                {labels.fieldHint}
              </span>
            </div>
            {error ? (
              <p className={`${styles.flash} ${styles.flashError}`} data-balance-due-error="" role="alert">
                <TriangleAlert aria-hidden="true" />
                <span>
                  <strong>{labels.errorTitle}</strong>
                  {error}
                </span>
              </p>
            ) : null}
            <div className={styles.submitRow}>
              <Submit label={labels.save} />
              <button className={styles.button} onClick={later} type="button">
                {labels.later}
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}
