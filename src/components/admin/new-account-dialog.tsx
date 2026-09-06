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
  /** What a child of this account would be — asset, revenue, expense… */
  readonly accountType: string;
}

/** A statement line: which statement it sits on, and which types may take it. */
export interface LineOption {
  readonly value: string;
  /** Already indented to the mapping's own nesting. */
  readonly label: string;
  readonly section: 'financial_position' | 'profit_or_loss';
  readonly accountTypes: readonly string[];
  /** Shown for the shape of the report, never choosable — accounts connect to lines. */
  readonly isHeader: boolean;
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
  readonly statementMappings: string;
  readonly incomeStatementLine: string;
  readonly balanceSheetLine: string;
  readonly statementLineHint: string;
  readonly balanceSheetLineHint: string;
  readonly balanceSheetLineUnmapped: string;
  readonly statementLineDefault: string;
  readonly headerNoLine: string;
  readonly create: string;
  readonly creating: string;
  readonly errorTitle: string;
  readonly required: string;
  readonly noParent: string | null;
}

export function NewAccountDialog({
  parents,
  defaultParent,
  lines,
  labels,
  create,
}: {
  readonly parents: readonly PickerOption[];
  readonly defaultParent: string;
  readonly lines: readonly LineOption[];
  readonly labels: NewAccountLabels;
  readonly create: (formData: FormData) => Promise<{ ok: boolean; error?: string; code?: string }>;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setReady(true), []);

  // The statement line an account may report on follows its type, and its type
  // follows its parent — so the choice narrows as the parent is picked rather
  // than offering revenue lines to an account being opened under Expenses.
  const [parentId, setParentId] = useState(defaultParent);
  const [kind, setKind] = useState('posting');
  const accountType = parents.find((option) => option.value === parentId)?.accountType ?? '';
  const balanceSheetLines = lines.filter((line) => line.section === 'financial_position');
  const incomeStatementLines = lines.filter((line) => line.section === 'profit_or_loss');
  const isProfitOrLoss = accountType === 'revenue' || accountType === 'expense';
  const primaryLines = isProfitOrLoss ? incomeStatementLines : balanceSheetLines;

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
                  id="new-account-parent"
                  name="parentId"
                  onChange={(event) => setParentId(event.target.value)}
                  required
                  value={parentId}
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
                <select
                  className={styles.select}
                  id="new-account-kind"
                  name="isGroup"
                  onChange={(event) => setKind(event.target.value)}
                  value={kind}
                >
                  <option value="posting">{labels.kindPosting}</option>
                  <option value="group">{labels.kindGroup}</option>
                </select>
                <span className={styles.hint}>{labels.kindHint}</span>
              </div>

              {/* The two reports have independent mappings. Revenue and
                  expense accounts choose their Income Statement line and may
                  also choose an equity line on the Balance Sheet. */}
              {kind === 'posting' ? (
                <>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="new-account-statement-line">
                      {isProfitOrLoss ? labels.incomeStatementLine : labels.balanceSheetLine}
                    </label>
                    <select
                      className={styles.select}
                      defaultValue=""
                      id="new-account-statement-line"
                      key={`primary-${accountType}`}
                      name="statementLine"
                    >
                      <option value="">{labels.statementLineDefault}</option>
                      {primaryLines.map((line) => (
                        <option
                          disabled={line.isHeader || !line.accountTypes.includes(accountType)}
                          key={line.value}
                          value={line.value}
                        >
                          {line.label}
                        </option>
                      ))}
                    </select>
                    <span className={styles.hint}>{labels.statementLineHint}</span>
                  </div>
                  {isProfitOrLoss ? (
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor="new-account-balance-sheet-line">
                        {labels.balanceSheetLine}
                      </label>
                      <select
                        className={styles.select}
                        defaultValue=""
                        id="new-account-balance-sheet-line"
                        key={`balance-${accountType}`}
                        name="balanceSheetLine"
                      >
                        <option value="">{labels.balanceSheetLineUnmapped}</option>
                        {balanceSheetLines.map((line) => (
                          <option
                            disabled={line.isHeader || !line.accountTypes.includes(accountType)}
                            key={line.value}
                            value={line.value}
                          >
                            {line.label}
                          </option>
                        ))}
                      </select>
                      <span className={styles.hint}>{labels.balanceSheetLineHint}</span>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className={styles.field}>
                  <span className={styles.label}>{labels.statementMappings}</span>
                  <span className={styles.hint}>{labels.headerNoLine}</span>
                </div>
              )}
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
