'use client';

import { useMemo, useState, type ReactNode } from 'react';
import styles from './admin.module.css';

/**
 * One report's layout, drawn as the Chart of Accounts draws the chart: a tree
 * that folds.
 *
 * The same shape for the same kind of thing. A statement layout is a
 * hierarchy of headers and the lines beneath them, exactly as the chart is a
 * hierarchy of groups and the accounts beneath them, and a person who has
 * learned to read one should not have to learn to read the other. So the
 * header carries the caret, the depth is the indent, and Expand all /
 * Collapse all sit where they sit on the chart.
 *
 * The row's own controls are handed in already rendered: they are server
 * actions and a dialog, and this component's only business is which rows are
 * showing.
 */
export interface MappingRow {
  readonly key: string;
  readonly name: string;
  readonly depth: number;
  readonly isHeader: boolean;
  /** The one thing this report needs to know about the line. */
  readonly attribute: string;
  /** How many accounts report on it; a header shows a dash. */
  readonly accounts: string;
  readonly actions: ReactNode;
}

export function StatementMappingTree({
  rows,
  labels,
  showActions,
}: {
  readonly rows: readonly MappingRow[];
  readonly labels: {
    readonly line: string;
    readonly attribute: string;
    readonly accounts: string;
    readonly actions: string;
    readonly expandAll: string;
    readonly collapseAll: string;
    readonly expand: string;
    readonly collapse: string;
    readonly empty: string;
  };
  readonly showActions: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // A folded header hides everything beneath it, however deep.
  const shown = useMemo(() => {
    const visible: MappingRow[] = [];
    const ancestors: MappingRow[] = [];
    for (const row of rows) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.depth >= row.depth) {
        ancestors.pop();
      }
      if (!ancestors.some((ancestor) => collapsed.has(ancestor.key))) visible.push(row);
      if (row.isHeader) ancestors.push(row);
    }
    return visible;
  }, [rows, collapsed]);

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const headers = rows.filter((row) => row.isHeader);

  return (
    <>
      {/* On every tab, so the four read the same before anything is grouped. */}
      <div className={`${styles.sapEntryBar} ${styles.sapBarEnd} ${styles.sapFoldBar}`}>
        <button
          className={`${styles.button} ${styles.small}`}
          onClick={() => setCollapsed(new Set())}
          type="button"
        >
          {labels.expandAll}
        </button>
        <button
          className={`${styles.button} ${styles.small}`}
          onClick={() => setCollapsed(new Set(headers.map((row) => row.key)))}
          type="button"
        >
          {labels.collapseAll}
        </button>
      </div>

      <div className={`${styles.sapTableWrap} ${styles.sapRegisterTableWrap}`}>
        <table className={`${styles.sapTable} ${styles.sapRegisterTable}`}>
          <thead>
            <tr>
              {/* The names take the slack. Without this the three narrow
                  columns sit against the left edge and the buttons against
                  the right with a wide blank between them, and a deeply
                  nested name is squeezed for room it has no need to lack. */}
              <th scope="col" style={{ width: '100%' }}>
                {labels.line}
              </th>
              <th scope="col">{labels.attribute}</th>
              <th className={styles.sapNum} scope="col">
                {labels.accounts}
              </th>
              {showActions ? (
                <th scope="col" style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
                  {labels.actions}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td className={styles.sapEmptyRow} colSpan={showActions ? 4 : 3}>
                  {labels.empty}
                </td>
              </tr>
            ) : null}
            {shown.map((row) => {
              const folded = collapsed.has(row.key);
              return (
                <tr className={row.isHeader ? styles.sapMappingHeader : undefined} key={row.key}>
                  <td style={{ paddingInlineStart: `${0.45 + row.depth * 1.1}rem` }}>
                    <span className={styles.sapTreeCell}>
                      {row.isHeader ? (
                        <button
                          aria-expanded={!folded}
                          aria-label={`${folded ? labels.expand : labels.collapse} ${row.name}`}
                          className={styles.sapTreeToggle}
                          onClick={() => toggle(row.key)}
                          type="button"
                        >
                          {folded ? '▸' : '▾'}
                        </button>
                      ) : (
                        <span aria-hidden="true" className={styles.sapTreeToggle} />
                      )}
                      <bdi dir="auto">{row.isHeader ? <strong>{row.name}</strong> : row.name}</bdi>
                    </span>
                  </td>
                  <td>{row.attribute}</td>
                  <td className={styles.sapNum}>{row.accounts}</td>
                  {showActions ? (
                    <td>
                      {/* Pushed to the right edge: the controls belong at the
                          end of the row, away from the names being read. */}
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.35rem',
                          flexWrap: 'nowrap',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                        }}
                      >
                        {row.actions}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
