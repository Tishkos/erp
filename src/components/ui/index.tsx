/**
 * The UI kit — the primitives every Appendix A screen is assembled from.
 *
 * Appendix A names 218 pages, which collapse into seven shapes (`screens.ts`).
 * The shapes in turn collapse into these dozen or so primitives. Designing at
 * this level rather than per page is what keeps 325 screens looking like one
 * application instead of eighteen.
 *
 * Two rules hold throughout, and both are enforced by tests rather than
 * remembered:
 *
 *   1. **No literal user-facing text.** Nothing here contains a sentence. Every
 *      string arrives as a prop from a caller that resolved it through the
 *      catalogue (`tests/unit/i18n-catalogue.test.ts`).
 *   2. **Nothing here reads data.** These are presentational. What a screen
 *      shows is decided by its caller, so a primitive cannot widen a query or
 *      leak a row past a permission check.
 */
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Info, Search, type LucideIcon } from 'lucide-react';
import styles from './ui.module.css';

export { styles as ui };
export { PreviewAction } from './preview-action';

/* -------------------------------------------------------------------------
 * Page furniture
 * ---------------------------------------------------------------------- */

export function Workspace({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return <div className={`${styles.workspace}${className ? ` ${className}` : ''}`}>{children}</div>;
}

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Buttons, rendered at the inline end. */
  readonly actions?: ReactNode;
  /** A route-owned visual treatment without widening the shared UI kit. */
  readonly className?: string | undefined;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={`${styles.pageHeader}${className ? ` ${className}` : ''}`}>
      <div className={styles.heading}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

/**
 * The marker a screen wears while it is drawn over samples.
 *
 * `role="note"` rather than `alert`: it is standing context, not an event, and
 * an alert would be announced on every navigation.
 */
export function PresentationBanner({
  badge,
  note,
}: {
  readonly badge: string;
  readonly note: string;
}) {
  return (
    <p className={styles.presentation} role="note">
      <Info aria-hidden="true" />
      <strong className={styles.presentationBadge}>{badge}</strong>
      <span aria-hidden="true">&middot;</span>
      <span>{note}</span>
    </p>
  );
}

/* -------------------------------------------------------------------------
 * Buttons
 * ---------------------------------------------------------------------- */

export interface ButtonProps {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly tone?: 'primary' | 'secondary';
  readonly href?: string;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly onClick?: () => void;
}

export function Button({
  label,
  icon: Icon,
  tone = 'secondary',
  href,
  disabled,
  title,
  onClick,
}: ButtonProps) {
  const className = `${styles.button} ${tone === 'primary' ? styles.primary : styles.secondary}`;
  const content = (
    <>
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span>{label}</span>
    </>
  );

  if (href && !disabled) {
    return (
      <Link className={className} href={href} title={title}>
        {content}
      </Link>
    );
  }

  return (
    <button className={className} disabled={disabled} onClick={onClick} title={title} type="button">
      {content}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  href,
  onClick,
}: {
  readonly icon: LucideIcon;
  /** Accessible name — the button shows only the glyph. */
  readonly label: string;
  readonly href?: string;
  readonly onClick?: () => void;
}) {
  const content = <Icon aria-hidden="true" />;
  if (href) {
    return (
      <Link aria-label={label} className={styles.iconButton} href={href}>
        {content}
      </Link>
    );
  }
  return (
    <button aria-label={label} className={styles.iconButton} onClick={onClick} type="button">
      {content}
    </button>
  );
}

export function CountBadge({ count, locale }: { readonly count: number; readonly locale: string }) {
  return (
    <span className={styles.countBadge}>
      <bdi dir="ltr">{new Intl.NumberFormat(locale).format(count)}</bdi>
    </span>
  );
}

/* -------------------------------------------------------------------------
 * Context bar — the company / branch / currency / period row from UI.png
 * ---------------------------------------------------------------------- */

export interface ContextFieldProps {
  readonly id: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly value: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly onChange?: (value: string) => void;
}

/**
 * One boxed selector. With no `options` it is a static reading of the current
 * context — the screen states what it is scoped to without implying the reader
 * may change it.
 */
export function ContextField({
  id,
  label,
  icon: Icon,
  value,
  options,
  onChange,
}: ContextFieldProps) {
  return (
    <div className={styles.contextField}>
      <label className={styles.contextLabel} htmlFor={id}>
        {Icon ? <Icon aria-hidden="true" /> : null}
        <span>{label}</span>
      </label>
      {options ? (
        <select
          className={styles.select}
          id={id}
          onChange={onChange ? (event) => onChange(event.target.value) : undefined}
          value={value}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <output className={styles.select} id={id}>
          {value}
        </output>
      )}
    </div>
  );
}

export function ContextBar({
  children,
  fieldCount,
  withSearch,
  label,
}: {
  readonly children: ReactNode;
  /** Boxed selectors before the search box, so the grid can size them. */
  readonly fieldCount?: number;
  readonly withSearch?: boolean;
  readonly label: string;
}) {
  return (
    <section
      aria-label={label}
      className={`${styles.contextBar}${withSearch ? ` ${styles.contextBarWithSearch}` : ''}`}
      style={fieldCount ? ({ '--context-fields': fieldCount } as CSSProperties) : undefined}
    >
      {children}
    </section>
  );
}

export function SearchBox({
  label,
  placeholder,
  defaultValue,
  name = 'q',
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly defaultValue?: string;
  readonly name?: string;
}) {
  return (
    <form className={styles.search} method="get" role="search">
      <input
        aria-label={label}
        className={styles.searchInput}
        defaultValue={defaultValue}
        name={name}
        placeholder={placeholder}
        type="search"
      />
      <button className={styles.searchSubmit} type="submit">
        <Search aria-hidden="true" />
        <span className={styles.srOnly}>{label}</span>
      </button>
    </form>
  );
}

/* -------------------------------------------------------------------------
 * Panels
 * ---------------------------------------------------------------------- */

export interface PanelProps {
  readonly title?: string;
  readonly icon?: LucideIcon;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  /** Removes the body padding, for a panel whose content is a table. */
  readonly flush?: boolean;
  readonly labelledBy?: string;
}

export function Panel({
  title,
  icon: Icon,
  actions,
  footer,
  children,
  flush,
  labelledBy,
}: PanelProps) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`${styles.panel}${flush ? ` ${styles.panelFlush}` : ''}`}
    >
      {title || actions ? (
        <header className={styles.panelHeader}>
          {title ? (
            <h2 className={styles.panelTitle} id={labelledBy}>
              {Icon ? <Icon aria-hidden="true" /> : null}
              <span>{title}</span>
            </h2>
          ) : (
            <span />
          )}
          {actions ? <div className={styles.panelActions}>{actions}</div> : null}
        </header>
      ) : null}
      {children}
      {footer ? <footer className={styles.panelFooter}>{footer}</footer> : null}
    </section>
  );
}

export function PeriodPill({ label, icon: Icon }: { readonly label: string; readonly icon?: LucideIcon }) {
  return (
    <span className={styles.periodPill}>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

/**
 * A document status, coloured from the `--status-*` tokens.
 *
 * The status key is validated against a pattern before it reaches a class name:
 * these values originate in the domain, but a primitive that interpolates an
 * arbitrary string into `class` is one bad caller away from a broken selector.
 */
export function StatusPill({ status, label }: { readonly status: string; readonly label: string }) {
  const safe = /^[a-z_]+$/.test(status) ? status : 'draft';
  return (
    <span className={styles.status} data-status={safe}>
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------
 * Tables
 * ---------------------------------------------------------------------- */

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  /** Right-aligns and applies tabular figures. */
  readonly numeric?: boolean;
}

export interface TableRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, ReactNode>>;
  readonly href?: string;
}

export interface TableTotals {
  readonly label: string;
  /** Preformatted totals, keyed by column. Columns without one stay blank. */
  readonly cells: Readonly<Record<string, ReactNode>>;
}

export function DataTable({
  columns,
  rows,
  caption,
  totals,
}: {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  readonly caption: string;
  /** A footer row. A report without one asks the reader to add up the page. */
  readonly totals?: TableTotals | undefined;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={`list ${styles.table}`}>
        <caption className={styles.srOnly}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                className={column.numeric ? styles.numeric : undefined}
                key={column.key}
                scope="col"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column, index) => {
                const content = row.cells[column.key] ?? '—';
                return (
                  <td className={column.numeric ? styles.numeric : undefined} key={column.key}>
                    {index === 0 && row.href ? (
                      <Link className={styles.cellLink} href={row.href}>
                        {content}
                      </Link>
                    ) : (
                      content
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {totals ? (
          <tfoot>
            <tr className={styles.totalsRow}>
              {columns.map((column, index) => (
                <td className={column.numeric ? styles.numeric : undefined} key={column.key}>
                  {index === 0 ? <strong>{totals.label}</strong> : (totals.cells[column.key] ?? null)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Pagination
 * ---------------------------------------------------------------------- */

export interface PaginationLabels {
  readonly label: string;
  readonly previous: string;
  readonly next: string;
  readonly page: (page: number) => string;
}

/** Page numbers to show: the ends, and a window around the current page. */
export function pageWindow(current: number, count: number): readonly number[] {
  const pages = new Set([1, count, current, current - 1, current + 1]);
  return [...pages].filter((page) => page >= 1 && page <= count).sort((a, b) => a - b);
}

export function Pagination({
  current,
  count,
  hrefFor,
  labels,
  locale,
}: {
  readonly current: number;
  readonly count: number;
  readonly hrefFor: (page: number) => string;
  readonly labels: PaginationLabels;
  readonly locale: string;
}) {
  if (count <= 1) return null;
  const number = new Intl.NumberFormat(locale);
  const pages = pageWindow(current, count);

  return (
    <nav aria-label={labels.label} className={styles.pagination}>
      {current > 1 ? (
        <Link aria-label={labels.previous} className={styles.pageButton} href={hrefFor(current - 1)}>
          <ChevronLeft aria-hidden="true" className={styles.directionalIcon} />
        </Link>
      ) : (
        <span aria-hidden="true" className={`${styles.pageButton} ${styles.pageDisabled}`}>
          <ChevronLeft className={styles.directionalIcon} />
        </span>
      )}
      {pages.map((page, index) => (
        <span key={page}>
          {index > 0 && pages[index - 1]! < page - 1 ? (
            <span aria-hidden="true" className={styles.pageEllipsis}>
              &hellip;
            </span>
          ) : null}
          {page === current ? (
            <span aria-current="page" className={`${styles.pageButton} ${styles.pageCurrent}`}>
              <bdi dir="ltr">{number.format(page)}</bdi>
            </span>
          ) : (
            <Link aria-label={labels.page(page)} className={styles.pageButton} href={hrefFor(page)}>
              <bdi dir="ltr">{number.format(page)}</bdi>
            </Link>
          )}
        </span>
      ))}
      {current < count ? (
        <Link aria-label={labels.next} className={styles.pageButton} href={hrefFor(current + 1)}>
          <ChevronRight aria-hidden="true" className={styles.directionalIcon} />
        </Link>
      ) : (
        <span aria-hidden="true" className={`${styles.pageButton} ${styles.pageDisabled}`}>
          <ChevronRight className={styles.directionalIcon} />
        </span>
      )}
    </nav>
  );
}

export function TableFooter({ children }: { readonly children: ReactNode }) {
  return <div className={styles.tableFooter}>{children}</div>;
}

/* -------------------------------------------------------------------------
 * Empty state
 * ---------------------------------------------------------------------- */

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly hint?: string;
}) {
  return (
    <div className={styles.empty} role="status">
      <Icon aria-hidden="true" />
      <strong className={styles.emptyTitle}>{title}</strong>
      {hint ? <span className={styles.emptyHint}>{hint}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Report parameters
 * ---------------------------------------------------------------------- */

export interface ParameterField {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options?: readonly string[];
}

/**
 * The row of choices a report is run with.
 *
 * Distinct from the context bar above it, and deliberately so: the context bar
 * states what the screen is scoped to, this states what the reader asked for.
 * Collapsing them loses the difference between "which company" and "which two
 * dates am I comparing".
 */
export function ReportParameters({
  fields,
  actions,
  label,
}: {
  readonly fields: readonly ParameterField[];
  readonly actions?: ReactNode;
  readonly label: string;
}) {
  return (
    <section aria-label={label} className={styles.parameters}>
      {fields.map((field) => (
        <label className={styles.contextField} htmlFor={field.id} key={field.id}>
          <span className={styles.contextLabel}>{field.label}</span>
          {field.options ? (
            <select className={styles.select} defaultValue={field.value} id={field.id}>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <output className={styles.select} id={field.id}>
              {field.value}
            </output>
          )}
        </label>
      ))}
      {actions ? <div className={styles.parameterActions}>{actions}</div> : null}
    </section>
  );
}

export function DrillHint({ icon: Icon, text }: { readonly icon: LucideIcon; readonly text: string }) {
  return (
    <p className={styles.drillHint}>
      <Icon aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

/* -------------------------------------------------------------------------
 * The settings save bar
 * ---------------------------------------------------------------------- */

/**
 * Sticky, so the reader can change something at the bottom of a long settings
 * page and still see how to keep it. Shown only when something is unsaved —
 * a permanently visible save button on an unchanged form trains people to
 * ignore it.
 */
export function SaveBar({
  note,
  icon: Icon,
  children,
}: {
  readonly note: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.saveBar} role="status">
      <span className={styles.saveBarNote}>
        <Icon aria-hidden="true" />
        {note}
      </span>
      <div className={styles.saveBarActions}>{children}</div>
    </div>
  );
}
