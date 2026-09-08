'use client';

import { useId, useRef, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import styles from './admin.module.css';

/**
 * One line of a report's layout, opened in a dialog — new, or the one being
 * edited.
 *
 * A dialog rather than a panel below the table, so the screen reads as the
 * report it is describing: the layout, and a way to change a row of it, in
 * the place the row is. The same component does both jobs because they ask
 * the same questions; only the button that opens it differs.
 *
 * The form posts to a server action directly, so it works before the page has
 * finished hydrating and the dialog closes by the navigation that follows.
 */
export type Kind = 'line' | 'header';

export interface Choice {
  readonly value: string;
  readonly label: string;
}

export interface LineDialogLabels {
  readonly open: string;
  readonly title: string;
  readonly close: string;
  readonly name: string;
  readonly kind: string;
  readonly kindLine: string;
  readonly kindHeader: string;
  readonly parent: string;
  readonly parentTop: string;
  readonly role: string;
  readonly side: string;
  readonly activity: string;
  readonly cash: string;
  readonly save: string;
  readonly required: string;
  readonly systemLine: string;
}

export function StatementLineDialog({
  action,
  hidden,
  labels,
  statement,
  parents,
  roles,
  sides,
  activities,
  initial,
  isSystem = false,
  mode,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly hidden: Readonly<Record<string, string>>;
  readonly labels: LineDialogLabels;
  readonly statement: 'income_statement' | 'balance_sheet' | 'cash_flow' | 'changes_in_equity';
  /** Headers this line may sit under. Offered when opening a new line only. */
  readonly parents?: readonly Choice[];
  readonly roles: readonly Choice[];
  readonly sides: readonly Choice[];
  readonly activities: readonly Choice[];
  readonly initial?: {
    readonly name?: string;
    readonly kind?: Kind;
    readonly role?: string;
    readonly side?: string;
    readonly cashFlowCategory?: string;
    readonly isCash?: boolean;
  };
  /** A seeded line: it may be renamed and moved, but it stays a line. */
  readonly isSystem?: boolean;
  readonly mode: 'new' | 'edit';
}) {
  // Every row carries a dialog of its own, so the fields inside are named
  // apart: a page full of elements sharing one id is invalid, and a label
  // then points at whichever of them the browser happens to find first.
  const id = useId();
  const field = (name: string) => `${id}-${name}`;
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'line');
  const [isCash, setIsCash] = useState(initial?.isCash ?? false);

  // A grouping title carries no figure of its own, so the questions its
  // report would ask about a line do not apply to it.
  const asksVocabulary = kind === 'line';

  return (
    <>
      <button
        className={`${styles.button}${mode === 'new' ? ` ${styles.primary}` : ` ${styles.small}`}`}
        onClick={() => ref.current?.showModal()}
        type="button"
      >
        {mode === 'new' ? <Plus aria-hidden="true" /> : <Pencil aria-hidden="true" />}
        <span>{labels.open}</span>
      </button>

      <dialog
        className={styles.dialog}
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
        ref={ref}
      >
        <div className={styles.dialogBody}>
          <header className={styles.dialogHeader}>
            <h2>{labels.title}</h2>
            <button
              aria-label={labels.close}
              className={styles.dialogClose}
              onClick={() => ref.current?.close()}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </header>

          <form action={action} className={styles.form}>
            {Object.entries(hidden).map(([name, value]) => (
              <input key={name} name={name} type="hidden" value={value} />
            ))}

            <div className={styles.grid}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={field('name')}>
                  {labels.name}
                  <span aria-hidden="true" className={styles.required} title={labels.required}>
                    *
                  </span>
                </label>
                <input
                  autoComplete="off"
                  className={styles.input}
                  defaultValue={initial?.name ?? ''}
                  id={field('name')}
                  name="name"
                  required
                  type="text"
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor={field('kind')}>
                  {labels.kind}
                </label>
                <select
                  className={styles.select}
                  disabled={isSystem}
                  id={field('kind')}
                  name="kind"
                  onChange={(event) => setKind(event.target.value as Kind)}
                  value={kind}
                >
                  <option value="line">{labels.kindLine}</option>
                  <option value="header">{labels.kindHeader}</option>
                </select>
                {isSystem ? <span className={styles.hint}>{labels.systemLine}</span> : null}
                {/* A disabled select submits nothing, and a seeded line is
                    always a line, so the value is carried alongside it. */}
                {isSystem ? <input name="kind" type="hidden" value="line" /> : null}
              </div>

              {mode === 'new' && parents ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={field('parent')}>
                    {labels.parent}
                  </label>
                  <select className={styles.select} defaultValue="" id={field('parent')} name="parentId">
                    <option value="">{labels.parentTop}</option>
                    {parents.map((parent) => (
                      <option key={parent.value} value={parent.value}>
                        {parent.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {statement === 'income_statement' && asksVocabulary ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={field('role')}>
                    {labels.role}
                  </label>
                  <select
                    className={styles.select}
                    defaultValue={initial?.role ?? roles[0]?.value ?? ''}
                    id={field('role')}
                    name="role"
                    required
                  >
                    {roles.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {statement === 'balance_sheet' ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={field('side')}>
                    {labels.side}
                  </label>
                  <select
                    className={styles.select}
                    defaultValue={initial?.side ?? sides[0]?.value ?? ''}
                    id={field('side')}
                    name="side"
                    required
                  >
                    {sides.map((side) => (
                      <option key={side.value} value={side.value}>
                        {side.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {statement === 'cash_flow' && asksVocabulary ? (
                <>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={field('cash')}>
                      {labels.cash}
                    </label>
                    <select
                      className={styles.select}
                      id={field('cash')}
                      name="isCash"
                      onChange={(event) => setIsCash(event.target.value === 'yes')}
                      value={isCash ? 'yes' : 'no'}
                    >
                      <option value="no">—</option>
                      <option value="yes">{labels.cash}</option>
                    </select>
                  </div>
                  {!isCash ? (
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={field('activity')}>
                        {labels.activity}
                      </label>
                      <select
                        className={styles.select}
                        defaultValue={initial?.cashFlowCategory ?? activities[0]?.value ?? ''}
                        id={field('activity')}
                        name="cashFlowCategory"
                        required
                      >
                        {activities.map((activity) => (
                          <option key={activity.value} value={activity.value}>
                            {activity.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            <div className={styles.submitRow}>
              <button className={`${styles.button} ${styles.primary}`} type="submit">
                {labels.save}
              </button>
            </div>
          </form>
        </div>
      </dialog>
    </>
  );
}
