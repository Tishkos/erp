import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { Field, FilterForm, Select, Submit } from './index';

/**
 * The bar above every financial report: the dates, the currency it is read
 * in, and how far it unfolds.
 *
 * Currency — by direction (2026-08-29) the ledger is kept in IQD alone, and
 * USD is a way of *reading* it: the same posted lines at the historical rate
 * that applied when each one posted (§2.3). Choosing USD sums the other
 * column; nothing is converted at report time.
 *
 * Level — level 1 shows only the headers, level 2 the headers and their
 * sub-headers, and so on down to the accounts themselves.
 */
export async function ReportFilter({
  action,
  from,
  to,
  asAt,
  currency,
  level,
  maxLevel,
}: {
  readonly action: string;
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
    <Panel>
      <FilterForm action={action}>
        {from !== undefined ? (
          <Field defaultValue={from} label={t('reports.from')} name="from" required type="date" />
        ) : null}
        {to !== undefined ? (
          <Field defaultValue={to} label={t('reports.to')} name="to" required type="date" />
        ) : null}
        {asAt !== undefined ? (
          <Field
            defaultValue={asAt}
            hint={t('reports.as_at_hint')}
            label={t('reports.as_at_label')}
            name="to"
            required
            type="date"
          />
        ) : null}
        <Select
          defaultValue={currency}
          hint={t('reports.currency_hint')}
          label={t('reports.currency')}
          name="currency"
          options={[
            { value: 'IQD', label: 'IQD' },
            { value: 'USD', label: 'USD' },
          ]}
        />
        {level !== undefined ? (
          <Select
            defaultValue={String(level)}
            hint={t('reports.level_hint')}
            label={t('reports.level')}
            name="level"
            options={levels.map((n) => ({ value: String(n), label: t('reports.level_n', { level: n }) }))}
          />
        ) : null}
        <Submit label={t('reports.run')} />
      </FilterForm>
    </Panel>
  );
}

/** The report currency from the query string — IQD unless USD was asked for. */
export function currencyFrom(value: unknown): 'IQD' | 'USD' {
  return value === 'USD' ? 'USD' : 'IQD';
}
