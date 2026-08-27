import { getLocale, getTranslations } from 'next-intl/server';
import type { ColumnDefinition, ListQuery } from '@domain/list-view';
import {
  formatBusinessDate,
  formatMoney,
  formatQuantity,
  type Locale,
} from '@/i18n/config';

/**
 * The list framework's rendering half — Phase 01.12, Appendix A rule 1.
 *
 * Which rows appear was decided by `services/list.ts`; this only draws them.
 * The separation matters for the 01.12 gate: the export takes the same rows
 * from the same service, so there is no rendering path that could add or
 * withhold a row on its own.
 *
 * Formatting is explicit — `Intl` with a stated locale — never `toFixed` or a
 * bare `toLocaleString`. An amount whose grouping depends on the server's
 * environment cannot be reconciled against a statement (§1.1).
 */
export interface DataListProps {
  readonly columns: readonly ColumnDefinition[];
  readonly rows: readonly Record<string, unknown>[];
  readonly query: ListQuery;
  readonly total: number | null;
  /** Where a row leads. Absent for lists that are read-only summaries. */
  readonly hrefFor?: (row: Record<string, unknown>) => string | null;
  /** Which currency a money column is in. Money is never assumed (§1.1). */
  readonly currencyFor?: (columnKey: string) => 'IQD' | 'USD';
}

function cellText(
  column: ColumnDefinition,
  value: unknown,
  currencyFor: (key: string) => 'IQD' | 'USD',
  locale: Locale,
): string {
  if (value === null || value === undefined) return '—';

  switch (column.kind) {
    case 'money':
      return formatMoney(value as string, currencyFor(column.key), locale);
    case 'number':
      return formatQuantity(value as string, locale);
    case 'date':
      // An ISO business date string, formatted as UTC — never parsed into a
      // local Date, which can shift it a day and so a period (TECHSTACK A10).
      return formatBusinessDate(String(value), locale);
    case 'boolean':
      return value ? '✓' : '—';
    default:
      return String(value);
  }
}

export async function DataList({
  columns,
  rows,
  query,
  total,
  hrefFor,
  currencyFor = () => 'IQD',
}: DataListProps) {
  const t = await getTranslations('list');
  const status = await getTranslations('status');
  const label = await getTranslations('column');
  const locale = (await getLocale()) as Locale;

  if (rows.length === 0) {
    return (
      <div className="table-wrap">
        <p className="empty">
          {t('no_rows')}
          <span className="empty__hint">{t('no_rows_hint')}</span>
        </p>
      </div>
    );
  }

  const shown = columns.filter((c) => query.columns.includes(c.key));

  return (
    <>
      <div className="table-wrap">
        <table className="list">
          <thead>
            <tr>
              {shown.map((column) => (
                <th
                  key={column.key}
                  className={column.kind === 'money' || column.kind === 'number' ? 'numeric' : ''}
                  scope="col"
                >
                  {label(column.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const href = hrefFor?.(row) ?? null;
              return (
                <tr key={String(row.id ?? index)}>
                  {shown.map((column, columnIndex) => {
                    const value = row[column.key];
                    const isStatus = column.key === 'status';
                    const content = isStatus ? (
                      <span className={`status status--${String(value)}`}>
                        {status(String(value))}
                      </span>
                    ) : (
                      cellText(column, value, currencyFor, locale)
                    );

                    return (
                      <td
                        key={column.key}
                        className={
                          column.kind === 'money' || column.kind === 'number' ? 'numeric' : ''
                        }
                      >
                        {columnIndex === 0 && href ? <a href={href}>{content}</a> : content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBlockStart: '0.5rem', fontSize: '0.8125rem' }}>
        {t('row_count', { count: total ?? rows.length })}
      </p>
    </>
  );
}
