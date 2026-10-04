import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessDateOf } from '@domain/business-date';
import { DUTY_TYPES, FREIGHT_TYPES, type ChargeState } from '@domain/import-logistics';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';

/**
 * The two charge registers — Customs Duties & Taxes (REQ-LOG-001 item 10)
 * and Freight & Shipping Costs (item 16) — are one screen over
 * `landed_cost_charge`, each showing its own charge types. Read only: a
 * charge is raised by the document that carries it and locked on the import
 * page. Drawn as Purchase Invoices is.
 */
const STATES = ['all', 'unlocked', 'locked', 'withdrawn'] as const;

export async function ChargeRegister({
  searchParams,
  register,
}: {
  readonly searchParams: SearchParams;
  readonly register: 'duties' | 'freight';
}) {
  const route = register === 'duties' ? '/logistics/customs-duties' : '/logistics/freight-costs';
  const object = register === 'duties' ? 'customs_duty' : 'freight_cost';
  const pageKey = register === 'duties' ? 'customs_duties' : 'freight_costs';
  const types = register === 'duties' ? DUTY_TYPES : FREIGHT_TYPES;
  if (!visibleRoute(route)) notFound();

  const [t, lc, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.landed_cost'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', object)) {
    return <Denied object={page(pageKey)} />;
  }
  const params = await searchParams;
  const state = (STATES as readonly string[]).includes(String(params.state)) ? (params.state as (typeof STATES)[number]) : 'all';

  const { result, totals } = await withCurrentUser(async (tx) => ({
    result: await (register === 'duties' ? views.dutiesRegister : views.freightRegister)(tx, {
      search: outcome.q,
      page: outcome.page,
      state: state === 'all' ? null : (state as ChargeState),
    }),
    totals: await views.chargeTotals(tx, types),
  }));
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', `state=${state}`, `page=${p}`].filter(Boolean).join('&');
  const day = (value: Date | string | null) => (value ? formatBusinessDate(typeof value === 'string' ? value : businessDateOf(value), locale as Locale) : '—');
  const typeName = (code: string, name: string) => (lc.has(`type_name.${code}`) ? lc(`type_name.${code}`) : name);
  const chip = (row: views.ChargeRow) => (row.state === 'withdrawn' ? 'cancelled' : row.state === 'locked' ? 'settled' : 'submitted');

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route={route} />} subtitle={t(`${register}_subtitle`)} title={page(pageKey)} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="charge-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="charge-list-title">
            <span>{page(pageKey)}</span>
            <span className={s.sapTitleMeta}>
              {t('totals_unlocked')} {formatMoney(totals.unlockedIqd, 'IQD', locale as Locale)} · {t('totals_locked')} {formatMoney(totals.lockedIqd, 'IQD', locale as Locale)}
            </span>
          </h2>
          <ListToolbar
            clearHref={route}
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={state} label={t('col_state')} name="state" options={STATES.map((key) => ({ value: key, label: t(`state_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="charge-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_charged_on')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('col_type')}</th>
                  <th scope="col">{t('col_source')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount_txn')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount_iqd')}
                  </th>
                  <th scope="col">{t('col_state')}</th>
                  <th scope="col">{t('col_journal')}</th>
                  {register === 'duties' ? <th scope="col">{t('customs_status')}</th> : null}
                  <th scope="col">{t('note')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={register === 'duties' ? 11 : 10}>
                      {t('no_charge_rows')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="ltr">{day(row.createdAt)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.payableNo} kind="import">
                        {row.payableNo}
                        {row.reference ? ` · ${row.reference}` : ''}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td>{typeName(row.chargeTypeCode, row.chargeTypeName)}</td>
                    <td>
                      <bdi dir="ltr">
                        {row.sourceType} {row.sourceNo ?? ''}
                      </bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.amountTxn, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.amountIqd, 'IQD', locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${chip(row)} ${s.sapRegisterStatus}`} data-status={chip(row)} title={row.cancelReason ?? undefined}>
                        {row.state === 'locked' && row.lockSequence ? t('locked_n', { sequence: row.lockSequence }) : t(`state_${row.state}`)}
                      </span>
                      {row.lockDate ? <div className="muted">{day(row.lockDate)}</div> : null}
                    </td>
                    <td>
                      <ProfileLink code={row.entryNo} kind="journal">
                        {row.entryNo ?? '—'}
                      </ProfileLink>
                    </td>
                    {register === 'duties' ? (
                      <td>
                        <bdi dir="auto">{row.pdSummary ?? '—'}</bdi>
                      </td>
                    ) : null}
                    <td>
                      <bdi dir="auto">{row.reason ?? row.note ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `${route}?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
