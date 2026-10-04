import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';

/**
 * Landed Costs — REQ-LOG-001 item 21. Every import with a cost charged or a
 * container received: its charges by state, the lock and why it is where it
 * is (the import page's own `lockableState`, given the same facts), the
 * allocation, and what the goods finally cost as the layers hold it. Read
 * only — the lock is done on the import page, which every row opens.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['all', 'ready', 'waiting', 'locked'] as const;

export default async function LandedCostsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/landed-costs')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', 'landed_cost_register')) {
    return <Denied object={page('landed_costs')} />;
  }
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'all';

  const { rows: shown } = await withCurrentUser((tx) => views.landedCostsRegister(tx, { view, search: outcome.q }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const qty = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const lockChip = (state: views.LandedCostRow['state']) =>
    state === 'locked' ? 'settled' : state === 'ready' ? 'approved' : state === 'late_charges' ? 'partially_executed' : state === 'nothing_charged' ? 'draft' : 'submitted';

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route="/logistics/landed-costs" />} subtitle={t('landed_subtitle')} title={page('landed_costs')} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      <p className={s.sapNote}>
        <strong>{t('chain_title')}</strong> {t('chain')}
      </p>
      <p className={s.sapNote}>{t('final_value_note')}</p>

      <section aria-labelledby="landed-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="landed-list-title">
            <span>{page('landed_costs')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>
          <ListToolbar clearHref="/logistics/landed-costs" clearLabel={admin('clear_search')} countLabel={admin('rows_shown', { count: shown.length })} placeholder={admin('search_placeholder')} q={outcome.q} searchLabel={admin('search')} />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view} label={t('view')} name="view" options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="landed-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_charges')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_unlocked')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_locked')}
                  </th>
                  <th scope="col">{t('col_lock_state')}</th>
                  <th scope="col">{t('col_allocation')}</th>
                  <th scope="col">{t('col_customs')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_containers')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_inventory')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_cogs')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_received_qty')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_on_hand_qty')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_final_value')}
                  </th>
                  <th scope="col">{t('col_last_lock')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={15}>
                      {t('none_landed')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.payableId}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}#landed-cost`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                      {row.reference ? <div className="muted">{row.reference}</div> : null}
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.chargesIqd)}</bdi>
                      <div className="muted">{row.liveCharges}</div>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.unlockedIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.lockedIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${lockChip(row.state)} ${s.sapRegisterStatus}`} data-status={lockChip(row.state)}>
                        {t(`lr.${row.state}`)}
                      </span>
                    </td>
                    <td>{t(`alloc.${row.allocation}`)}</td>
                    <td>
                      <bdi dir="auto">{row.pdSummary ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {row.containersReceived} / {row.containerCount}
                      </bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.inventoryIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.cogsIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.receivedQty)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.onHandQty)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.finalValueIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.lastLockDate)}</bdi>
                      {row.lastEntryNo ? (
                        <div className="muted">
                          <ProfileLink code={row.lastEntryNo} kind="journal">
                            {row.lastEntryNo}
                          </ProfileLink>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
