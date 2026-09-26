import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, ChevronRight, Search, TriangleAlert } from 'lucide-react';
import { PageHeader, Panel, Workspace } from '@/components/ui';
import styles from './admin.module.css';
import { Submit } from './submit';

export { styles as admin };

/**
 * The administration screens' building blocks — Phase 0.
 *
 * Presentational, like the UI kit: no data is read here and no sentence is
 * written here. Every string is a prop the page resolved from the catalogue.
 * Forms post to server actions; there is no client state, so a screen works
 * before its JavaScript arrives and the action runs under the session cookie
 * alone.
 */

export interface Crumb {
  readonly href: string;
  readonly label: string;
}

export function AdminPage({
  title,
  subtitle,
  actions,
  back,
  trail = [],
  tabs,
  variant = 'default',
  children,
}: {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly actions?: ReactNode;
  /** Where the top-left button goes — the dashboard for a list, the list for a record. */
  readonly back?: Crumb | undefined;
  /** The path above this page, shown as a breadcrumb beside the button. */
  readonly trail?: readonly Crumb[];
  /** The section's live screens, one row of tabs (see SectionTabs). */
  readonly tabs?: ReactNode;
  /** Route-scoped document chrome; SAP is reserved for the journal workspace. */
  readonly variant?: 'default' | 'sap';
  readonly children: ReactNode;
}) {
  const sap = variant === 'sap';
  return (
    <Workspace className={sap ? styles.sapPage : undefined}>
      {back ? (
        <nav aria-label={back.label} className={styles.crumbs}>
          <Link className={styles.backButton} href={back.href}>
            <ArrowLeft aria-hidden="true" />
            <span>{back.label}</span>
          </Link>
          <span className={styles.crumbTrail}>
            {trail.map((crumb) => (
              <span key={crumb.href} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <Link href={crumb.href}>{crumb.label}</Link>
                <ChevronRight aria-hidden="true" style={{ inlineSize: '0.8rem', blockSize: '0.8rem' }} />
              </span>
            ))}
            <strong>{title}</strong>
          </span>
        </nav>
      ) : null}
      {sap ? (
        <PageHeader
          className={styles.sapPageHeader}
          title={title}
          {...(subtitle ? { subtitle } : {})}
          actions={actions}
        />
      ) : null}
      {tabs}
      {!sap ? (
        <PageHeader title={title} {...(subtitle ? { subtitle } : {})} actions={actions} />
      ) : null}
      {children}
    </Workspace>
  );
}

/** The outcome of the last action, carried in the query string. */
export function Flash({
  saved,
  error,
  savedLabel,
  errorTitle,
}: {
  readonly saved: boolean;
  readonly error: string | null;
  readonly savedLabel: string;
  readonly errorTitle: string;
}) {
  if (error) {
    return (
      <p className={`${styles.flash} ${styles.flashError}`} role="alert">
        <TriangleAlert aria-hidden="true" />
        <span>
          <strong>{errorTitle}</strong>
          {error}
        </span>
      </p>
    );
  }
  if (saved) {
    return (
      <p className={styles.flash} role="status">
        <CheckCircle2 aria-hidden="true" />
        <span>{savedLabel}</span>
      </p>
    );
  }
  return null;
}

/** A value shown once — a temporary password. */
export function Secret({
  title,
  note,
  value,
}: {
  readonly title: string;
  readonly note: string;
  readonly value: string;
}) {
  return (
    <p className={styles.flash} role="status">
      <CheckCircle2 aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        {note}
        <br />
        <code className={styles.secret}>{value}</code>
      </span>
    </p>
  );
}

export function Form({
  action,
  children,
  className,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <form action={action} className={`${styles.form}${className ? ` ${className}` : ''}`}>
      {children}
    </form>
  );
}

/**
 * The filter bar above a report.
 *
 * A plain GET form, deliberately: a report is a *place*. Running it should put
 * the dates in the address bar, so the result can be linked to, re-read
 * tomorrow, and left with the back button meaning what it says. A server
 * action would make the same screen unaddressable.
 */
export function FilterForm({
  action,
  children,
}: {
  readonly action: string;
  readonly children: ReactNode;
}) {
  return (
    <form action={action} className={styles.filterForm} method="get">
      {children}
    </form>
  );
}

export function Grid({ children }: { readonly children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

export function Inline({ children }: { readonly children: ReactNode }) {
  return <div className={styles.inline}>{children}</div>;
}

/**
 * A screen's filters: the controls at their own width with the button beside
 * them. `Grid` is for a form to fill in; a filter bar is one line to set.
 */
export function FilterRow({ children }: { readonly children: ReactNode }) {
  return <div className={styles.filterRow}>{children}</div>;
}

export interface FieldProps {
  readonly label: string;
  readonly name: string;
  readonly type?: 'text' | 'email' | 'number' | 'password' | 'textarea' | 'date' | undefined;
  readonly defaultValue?: string | number | null | undefined;
  readonly required?: boolean | undefined;
  readonly requiredLabel?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  readonly wide?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly min?: number | undefined;
  /**
   * `step` for a number field. Without it the browser assumes 1 and
   * silently refuses to submit a form holding 1250.50 — no request, no
   * message a person can act on. Money needs '0.01'; a quantity that
   * divides needs 'any'.
   */
  readonly step?: string | undefined;
  readonly max?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly pattern?: string | undefined;
  readonly autoComplete?: string | undefined;
  /**
   * The id of a `datalist` to suggest from. A filter box that searches on what
   * is typed still wants to offer the names it knows — and unlike a picker it
   * accepts a partial term, so the list suggests rather than constrains.
   */
  readonly list?: string | undefined;
  /**
   * The element id, when the field name is not unique on the page.
   *
   * Two forms on one screen may each have a `description`, and each is
   * right within its own form — but ids are the page's, not the form's, and
   * a repeated one silently hands both labels to the first input and leaves
   * the second with no accessible name at all. Nothing looks wrong; the
   * field simply stops being addressable by anyone using a screen reader.
   */
  readonly id?: string | undefined;
}

export function Field({
  label,
  name,
  type = 'text',
  defaultValue,
  required,
  requiredLabel,
  placeholder,
  hint,
  wide,
  readOnly,
  min,
  max,
  step,
  maxLength,
  pattern,
  autoComplete = 'off',
  list,
  id: idOverride,
}: FieldProps) {
  const id = idOverride ?? `f-${name}`;
  const common = {
    id,
    name,
    required,
    placeholder,
    readOnly,
    autoComplete,
    'aria-describedby': hint ? `${id}-hint` : undefined,
  };
  return (
    <div className={`${styles.field}${wide ? ` ${styles.fieldWide}` : ''}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className={styles.required} title={requiredLabel}>
            *
          </span>
        ) : null}
      </label>
      {type === 'textarea' ? (
        <textarea className={styles.textarea} defaultValue={defaultValue ?? ''} {...common} />
      ) : (
        <input
          className={`${styles.input}${type === 'date' ? ` ${styles.dateInput}` : ''}`}
          defaultValue={defaultValue ?? ''}
          max={max}
          maxLength={maxLength}
          min={min}
          pattern={pattern}
          list={list}
          step={type === 'number' ? (step ?? 'any') : undefined}
          type={type}
          {...common}
        />
      )}
      {hint ? (
        <span className={styles.hint} id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  name,
  options,
  defaultValue,
  required,
  hint,
  emptyLabel,
  multiple,
  size,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    /**
     * Shown, but not choosable.
     *
     * For a picker that has to display the shape of something — a chart of
     * accounts, where only the headers can be a parent — so a person can see
     * where a row sits and still be stopped from choosing it.
     */
    readonly disabled?: boolean;
  }[];
  readonly defaultValue?: string | readonly string[] | null | undefined;
  readonly required?: boolean | undefined;
  readonly hint?: string | undefined;
  /** A first, blank option. */
  readonly emptyLabel?: string | undefined;
  readonly multiple?: boolean | undefined;
  readonly size?: number | undefined;
}) {
  const id = `f-${name}`;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <select
        className={styles.select}
        defaultValue={(defaultValue as string | string[] | undefined) ?? (multiple ? [] : '')}
        id={id}
        multiple={multiple}
        name={name}
        required={required}
        size={size}
      >
        {emptyLabel !== undefined && !multiple ? <option value="">{emptyLabel}</option> : null}
        {options.map((option, index) => (
          <option
            disabled={option.disabled}
            key={`${option.value}-${index}`}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </div>
  );
}

export function Checkbox({
  label,
  name,
  value = '1',
  defaultChecked,
}: {
  readonly label: string;
  readonly name: string;
  readonly value?: string | undefined;
  readonly defaultChecked?: boolean | undefined;
}) {
  return (
    <label className={styles.check}>
      <input defaultChecked={defaultChecked} name={name} type="checkbox" value={value} />
      <span>{label}</span>
    </label>
  );
}

export function Hidden({ name, value }: { readonly name: string; readonly value: string }) {
  return <input name={name} type="hidden" value={value} />;
}

// The submit button lives in its own client file: it is disabled until the
// page can act on a press, which needs an effect a server component cannot run.
export { Submit } from './submit';

export function SubmitRow({ children }: { readonly children: ReactNode }) {
  return <div className={styles.submitRow}>{children}</div>;
}

export function LinkButton({
  href,
  label,
  tone = 'secondary',
  small,
}: {
  readonly href: string;
  readonly label: string;
  readonly tone?: 'primary' | 'secondary';
  readonly small?: boolean;
}) {
  const cls = [styles.button, tone === 'primary' ? styles.primary : '', small ? styles.small : '']
    .filter(Boolean)
    .join(' ');
  return (
    <Link className={cls} href={href}>
      {label}
    </Link>
  );
}

/** A one-button form with hidden fields — a row action. */
export function ActionButton({
  action,
  label,
  name,
  hidden,
  tone = 'secondary',
  small = true,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly label: string;
  /** What to call the button when `label` is a glyph rather than a word. */
  readonly name?: string | undefined;
  readonly hidden: Readonly<Record<string, string>>;
  readonly tone?: 'primary' | 'secondary' | 'danger';
  readonly small?: boolean;
}) {
  return (
    <form action={action} style={{ display: 'inline' }}>
      {Object.entries(hidden).map(([name, value]) => (
        <Hidden key={name} name={name} value={value} />
      ))}
      <Submit label={label} small={small} tone={tone} {...(name ? { name } : {})} />
    </form>
  );
}

/** A reason plus a button — deactivate, reject. */
export function ReasonForm({
  action,
  label,
  reasonLabel,
  reasonPlaceholder,
  hidden,
  tone = 'danger',
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly label: string;
  readonly reasonLabel: string;
  readonly reasonPlaceholder?: string | undefined;
  readonly hidden: Readonly<Record<string, string>>;
  readonly tone?: 'primary' | 'secondary' | 'danger' | undefined;
}) {
  // A record often offers two or three of these at once — reject, cancel,
  // reverse — and each one's field is called `reason`. Ids are the page's, not
  // the form's, so all of them would answer to `f-reason`: the first field
  // would collect every label and the rest would have no accessible name at
  // all. The label makes the id unique, because it is the one thing that
  // differs between them.
  const id = `reason-${reasonLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  return (
    <form action={action} className={styles.inline}>
      {Object.entries(hidden).map(([name, value]) => (
        <Hidden key={name} name={name} value={value} />
      ))}
      <Field
        id={id}
        label={reasonLabel}
        name="reason"
        placeholder={reasonPlaceholder}
        required
      />
      <Submit label={label} tone={tone} />
    </form>
  );
}

export function KeyValue({
  rows,
}: {
  readonly rows: readonly { readonly label: string; readonly value: ReactNode }[];
}) {
  return (
    <dl className={styles.kv}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pill({ on, label }: { readonly on: boolean | null; readonly label: string }) {
  const cls = on === null ? styles.pill : on ? `${styles.pill} ${styles.pillOn}` : `${styles.pill} ${styles.pillOff}`;
  return <span className={cls}>{label}</span>;
}

export function Mono({ children }: { readonly children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>;
}

export interface TimelineEntry {
  readonly id: string;
  readonly when: string;
  readonly action: string;
  readonly actor?: string | null;
  readonly outcome: string;
  readonly reason?: string | null;
  readonly detail?: string | null;
}

/** Record history — who, when, what (§5.4). */
export function Timeline({
  entries,
  title,
  emptyLabel,
  labelledBy,
}: {
  readonly entries: readonly TimelineEntry[];
  readonly title: string;
  readonly emptyLabel: string;
  readonly labelledBy?: string | undefined;
}) {
  return (
    <Panel {...(labelledBy ? { labelledBy } : {})} title={title}>
      {entries.length === 0 ? (
        <p className="muted">{emptyLabel}</p>
      ) : (
        <ol className={styles.timeline}>
          {entries.map((entry) => (
            <li data-outcome={entry.outcome} key={entry.id}>
              <span className={styles.timelineWhen}>{entry.when}</span>
              <span className={styles.timelineAction}>
                {entry.action}
                {entry.actor ? ` · ${entry.actor}` : ''}
              </span>
              {entry.reason || entry.detail ? (
                <span className={styles.timelineMeta}>
                  {entry.reason ? <span>{entry.reason}</span> : null}
                  {entry.reason && entry.detail ? ' · ' : null}
                  {entry.detail ? <code>{entry.detail}</code> : null}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export { NewRecordDialog } from './dialog';

/** Search + count above a list table. The search is a GET form: the URL is the state. */
export function ListToolbar({
  q,
  searchLabel,
  placeholder,
  countLabel,
  clearLabel,
  clearHref,
  children,
}: {
  readonly q: string;
  readonly searchLabel: string;
  readonly placeholder: string;
  readonly countLabel: string;
  readonly clearLabel: string;
  readonly clearHref: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={styles.toolbar}>
      <form className={styles.toolbarSearch} method="get" role="search">
        <input aria-label={searchLabel} defaultValue={q} name="q" placeholder={placeholder} type="search" />
        <button aria-label={searchLabel} type="submit">
          <Search aria-hidden="true" />
        </button>
      </form>
      <div className={styles.toolbarMeta}>
        <span>{countLabel}</span>
        {q ? (
          <Link className={styles.toolbarClear} href={clearHref}>
            {clearLabel}
          </Link>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** Case-insensitive match of a search phrase against every value of a row. */
export function matches(row: Record<string, unknown>, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return Object.values(row).some((value) => {
    if (value === null || value === undefined) return false;
    if (value instanceof Date) return false;
    return String(value).toLowerCase().includes(needle);
  });
}
