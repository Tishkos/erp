'use client';

import { useMemo, useState } from 'react';
import styles from './admin.module.css';

/**
 * A financial statement, drawn as the layout it was mapped from — and folding
 * the same way the Statement Mapping and the Chart of Accounts fold.
 *
 * The four statements print the same kind of thing: a hierarchy of grouping
 * titles, the lines beneath them, the accounts beneath those, and computed
 * subtotals ruled in between. They differ only in how many money columns they
 * carry, so they share this and pass their own.
 *
 * A row is foldable when the row after it is deeper. That reads the shape off
 * the rows themselves rather than asking each statement to describe its own
 * nesting a second time, which is the sort of duplication that goes stale.
 */
export interface StatementRow {
  readonly key: string;
  readonly label: string;
  /** Steps into the layout; a top-level heading is 0. */
  readonly depth: number;
  /**
   * `header`   — a grouping title, carrying the sum of what is beneath it.
   * `line`     — a line of the report.
   * `account`  — one account under a line.
   * `subtotal` — a computed figure: the margin, the result, a side's total.
   */
  readonly tone: 'header' | 'line' | 'account' | 'subtotal';
  /** The money columns, already formatted. */
  readonly cells: readonly string[];
  /** Ruled above, and twice where a sum has ended. */
  readonly rule?: 'none' | 'single' | 'double';
  /** Shown in brackets after the label — "(deducted)". */
  readonly note?: string | null;
}

export function StatementTable({
  columns,
  rows,
  labels,
}: {
  /** The heading of each column: the label column first, then the figures. */
  readonly columns: readonly string[];
  readonly rows: readonly StatementRow[];
  readonly labels: {
    readonly expandAll: string;
    readonly collapseAll: string;
    readonly expand: string;
    readonly collapse: string;
    readonly empty: string;
  };
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // A row folds when the next one is deeper than it. Subtotals stand outside
  // the hierarchy — they are the answer to the rows above, not part of them.
  const foldable = useMemo(() => {
    const keys = new Set<string>();
    rows.forEach((row, index) => {
      const next = rows[index + 1];
      if (row.tone !== 'subtotal' && next && next.tone !== 'subtotal' && next.depth > row.depth) {
        keys.add(row.key);
      }
    });
    return keys;
  }, [rows]);

  const shown = useMemo(() => {
    const visible: StatementRow[] = [];
    const folds: StatementRow[] = [];
    for (const row of rows) {
      while (folds.length > 0 && folds[folds.length - 1]!.depth >= row.depth) folds.pop();
      const hidden = row.tone !== 'subtotal' && folds.some((fold) => collapsed.has(fold.key));
      if (!hidden) visible.push(row);
      if (foldable.has(row.key)) folds.push(row);
    }
    return visible;
  }, [rows, collapsed, foldable]);

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toneClass: Record<StatementRow['tone'], string | undefined> = {
    header: styles.sapStatementHeader,
    line: styles.sapLineRow,
    account: styles.sapAccountRow,
    subtotal: styles.sapSectionRow,
  };

  return (
    <>
      {foldable.size > 0 ? (
        <div className={`${styles.sapEntryBar} ${styles.sapBarEnd}`}>
          <button
            className={`${styles.button} ${styles.small}`}
            onClick={() => setCollapsed(new Set())}
            type="button"
          >
            {labels.expandAll}
          </button>
          <button
            className={`${styles.button} ${styles.small}`}
            onClick={() => setCollapsed(new Set(foldable))}
            type="button"
          >
            {labels.collapseAll}
          </button>
        </div>
      ) : null}

      <table className={`${styles.sapTable} ${styles.sapReportTable}`}>
        <thead>
          <tr>
            {columns.map((heading, index) => (
              <th className={index === 0 ? undefined : styles.sapNum} key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td className={styles.sapEmptyRow} colSpan={columns.length}>
                {labels.empty}
              </td>
            </tr>
          ) : null}
          {shown.map((row) => {
            const folds = foldable.has(row.key);
            const folded = collapsed.has(row.key);
            return (
              <tr
                className={toneClass[row.tone]}
                data-rule={row.rule && row.rule !== 'none' ? row.rule : undefined}
                key={row.key}
              >
                <td style={{ paddingInlineStart: `${0.45 + row.depth * 1.1}rem` }}>
                  <span className={styles.sapTreeCell}>
                    {folds ? (
                      <button
                        aria-expanded={!folded}
                        aria-label={`${folded ? labels.expand : labels.collapse} ${row.label}`}
                        className={styles.sapTreeToggle}
                        onClick={() => toggle(row.key)}
                        type="button"
                      >
                        {folded ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span aria-hidden="true" className={styles.sapTreeToggle} />
                    )}
                    <bdi dir="auto">{row.label}</bdi>
                    {row.note ? <span className={styles.sapNote}> ({row.note})</span> : null}
                  </span>
                </td>
                {row.cells.map((cell, index) => (
                  <td className={styles.sapNum} key={index}>
                    <bdi dir="ltr">{cell}</bdi>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
