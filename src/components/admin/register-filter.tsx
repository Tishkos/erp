import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Field, FilterRow, Hidden, Select, Submit, SubmitRow, admin as s } from './index';
import { RegisterFilterDialog } from './register-filter-dialog';
import {
  REGISTER_SORTS,
  registerDatesActive,
  registerDatesParams,
  type RegisterDates,
} from '@/server/domain/register-dates';

/**
 * Every register's "Filter" — a window of three questions: the first and the
 * last day (the register's own document date) and the order, newest first
 * unless asked otherwise (2026-10-07, by direction). It sits in the toolbar
 * beside the Views button:
 *
 *   const dates = registerDatesOf(params);
 *   <ListToolbar … hidden={{ …, ...registerDatesParams(dates) }}>
 *     <RegisterFilter dates={dates} keep={{ q: outcome.q, view }} path="/payables/invoices" />
 *     <SavedViewsMenu state={saved} />
 *   </ListToolbar>
 *   … and in the screen's own filter form: <DatesHidden dates={dates} />
 *
 * The form is a GET to the same screen, so the screen's own read answers it.
 * `keep` is what else the screen is asking (the search, the View filter) so
 * that applying the dates does not drop them; Clear goes to `path` with those
 * and without the dates. `dateLabel` names the date when the register's date
 * is not simply "Date" (ETA, posting date). A screen that already asks for its
 * own window under other names passes `names`; one whose page form already
 * holds the dates passes `fields={{ dates: false }}` and keeps only the order.
 */
export async function RegisterFilter({
  dates,
  keep = {},
  path,
  dateLabel,
  names = {},
  fields = { dates: true },
}: {
  readonly dates: RegisterDates;
  readonly keep?: Readonly<Record<string, string | null | undefined>>;
  readonly path: string;
  readonly dateLabel?: string;
  readonly names?: { readonly from?: string; readonly to?: string };
  readonly fields?: { readonly dates: boolean };
}) {
  const [t, admin] = await Promise.all([getTranslations('admin.register_filter'), getTranslations('admin')]);
  const kept = keptEntries(keep);
  const fromName = names.from ?? 'from';
  const toName = names.to ?? 'to';
  const label = dateLabel ?? t('date');
  const clearQuery = kept.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  const clearHref = clearQuery ? `${path}?${clearQuery}` : path;

  return (
    <RegisterFilterDialog active={registerDatesActive(dates)} closeLabel={admin('close')} label={t('button')} title={t('title')}>
      <form className={s.form} method="get">
        {kept.map(([name, value]) => (
          <Hidden key={name} name={name} value={value} />
        ))}
        {!fields.dates && dates.from ? <Hidden name={fromName} value={dates.from} /> : null}
        {!fields.dates && dates.to ? <Hidden name={toName} value={dates.to} /> : null}
        <FilterRow>
          {fields.dates ? (
            <>
              <Field
                defaultValue={dates.from ?? ''}
                id={`register-filter-${fromName}`}
                label={t('from', { date: label })}
                name={fromName}
                type="date"
              />
              <Field
                defaultValue={dates.to ?? ''}
                id={`register-filter-${toName}`}
                label={t('to', { date: label })}
                name={toName}
                type="date"
              />
            </>
          ) : null}
          <Select
            defaultValue={dates.sort}
            id="register-filter-sort"
            label={t('sort')}
            name="sort"
            options={REGISTER_SORTS.map((sort) => ({ value: sort, label: t(`sort_${sort}`) }))}
          />
        </FilterRow>
        <SubmitRow>
          <Submit label={t('apply')} />
          <Link className={`${s.button} ${s.small}`} data-register-filter-clear="" href={clearHref}>
            {t('clear')}
          </Link>
        </SubmitRow>
      </form>
    </RegisterFilterDialog>
  );
}

function keptEntries(keep: Readonly<Record<string, string | null | undefined>>): [string, string][] {
  return Object.entries(keep).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
}

/**
 * The Filter's window and order carried by the screen's other GET forms (the
 * View filter, a status filter), so that changing those keeps the dates.
 */
export function DatesHidden({
  dates,
  names = {},
}: {
  readonly dates: RegisterDates;
  readonly names?: { readonly from?: string; readonly to?: string };
}) {
  return (
    <>
      {Object.entries(registerDatesParams(dates, names)).map(([name, value]) => (
        <Hidden key={name} name={name} value={value} />
      ))}
    </>
  );
}
