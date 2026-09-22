import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { admin as s } from './index';

/**
 * A financial report, drawn as the same window every document in the system
 * is drawn in: a titled bar, a strip of labelled boxes for the parameters,
 * the ruled grid, and a foot for what the report comes to.
 */
export function ReportWindow({
  title,
  meta,
  filter,
  foot,
  children,
}: {
  readonly title: string;
  readonly meta?: ReactNode;
  readonly filter?: ReactNode;
  readonly foot?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={s.sapDoc}>
      <section className={s.sapWindow}>
        <h2 className={s.sapTitle}>
          <span>{title}</span>
          {meta ? <span className={s.sapTitleMeta}>{meta}</span> : null}
        </h2>
        {filter}
        <div className={`${s.sapTableWrap} ${s.sapReportWrap}`}>{children}</div>
        {foot ? <div className={s.sapFoot}>{foot}</div> : null}
      </section>
    </div>
  );
}

/**
 * The parameter strip above every financial report: the dates, the currency
 * it is read in, and how far it unfolds.
 *
 * Currency — by direction (2026-08-29) the ledger is kept in IQD alone, and
 * USD is a way of *reading* it: the same posted lines at the historical rate
 * that applied when each one posted (§2.3). Choosing USD sums the other
 * column; nothing is converted at report time.
 *
 * Level — level 1 shows only the headers, level 2 the headers and their
 * sub-headers, and so on down to the accounts themselves.
 *
 * A plain GET form: a report is a place, so running it puts the parameters
 * in the address bar and the result can be linked to and re-read.
 */
export async function ReportFilter({
  action,
  hiddenFields = {},
  from,
  to,
  asAt,
  currency,
  level,
  maxLevel,
}: {
  readonly action: string;
  readonly hiddenFields?: Readonly<Record<string, string>>;
  /** A period report carries both; a position report carries `asAt` alone. */
  readonly from?: string;
  readonly to?: string;
  readonly asAt?: string;
  readonly currency: 'IQD' | 'USD';
  readonly level?: number;
  readonly maxLevel?: number;
}) {
  const t = await getTranslations('admin');
  const levels = Array.from({ length: Math.max(1, maxLevel ?? 1) }, (_, i) => i + 1);

  return (
    <form action={action} className={s.sapFilterBar} method="get">
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      {from !== undefined ? (
        <label className={s.sapFilterField}>
          <span className={s.sapLabel}>{t('reports.from')}</span>
          <input defaultValue={from} name="from" required type="date" />
        </label>
      ) : null}
      {to !== undefined ? (
        <label className={s.sapFilterField}>
          <span className={s.sapLabel}>{t('reports.to')}</span>
          <input defaultValue={to} name="to" required type="date" />
        </label>
      ) : null}
      {asAt !== undefined ? (
        <label className={s.sapFilterField} title={t('reports.as_at_hint')}>
          <span className={s.sapLabel}>{t('reports.as_at_label')}</span>
          <input defaultValue={asAt} name="to" required type="date" />
        </label>
      ) : null}
      <label className={s.sapFilterField} title={t('reports.currency_hint')}>
        <span className={s.sapLabel}>{t('reports.currency')}</span>
        <select defaultValue={currency} name="currency">
          <option value="IQD">IQD</option>
          <option value="USD">USD</option>
        </select>
      </label>
      {level !== undefined ? (
        <label className={s.sapFilterField} title={t('reports.level_hint')}>
          <span className={s.sapLabel}>{t('reports.level')}</span>
          <select defaultValue={String(level)} name="level">
            {levels.map((n) => (
              <option key={n} value={String(n)}>
                {t('reports.level_n', { level: n })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button className={`${s.button} ${s.primary}`} type="submit">
        {t('reports.run')}
      </button>
    </form>
  );
}

/** The report currency from the query string — IQD unless USD was asked for. */
export function currencyFrom(value: unknown): 'IQD' | 'USD' {
  return value === 'USD' ? 'USD' : 'IQD';
}
