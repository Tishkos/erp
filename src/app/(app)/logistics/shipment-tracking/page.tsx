import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessDateOf } from '@domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';
import { CONTAINER_OBJECT } from '@/server/services/shipments';
import { containerChip } from '../../payables/containers/status';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { savedViewsFor } from '@/server/saved-views-gate';

/**
 * Shipment Tracking — REQ-LOG-001 item 20. Read only: every container on
 * the way, the soonest ETA first — the stage it is at and since when, how
 * late it is, where customs stands, the port file, the last update, and
 * what it waits for next. The actions are on the container's own page.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['open', 'late', 'at_port', 'cleared', 'all'] as const;

export default async function ShipmentTrackingPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/shipment-tracking')) notFound();

  const [t, sh, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', CONTAINER_OBJECT)) {
    return <Denied object={page('shipment_tracking')} />;
  }
  // The person's saved views of this screen — and, on a bare arrival, their default one.
  const saved = await savedViewsFor('logistics.shipment_tracking', searchParams);
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'open';

  const { rows } = await withCurrentUser((tx) => views.shipmentTracking(tx, { view, search: outcome.q }));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const cs = (code: string, name: string) => (locale !== 'en' && sh.has(`cs.${code}`) ? sh(`cs.${code}`) : name);
  const viewLabel = (key: (typeof VIEWS)[number]) => (key === 'cleared' ? t('view_customs_cleared') : t(`view_${key}`));

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route="/logistics/shipment-tracking" />} subtitle={t('tracking_subtitle')} title={page('shipment_tracking')} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      <p className={s.sapNote}>
        <strong>{t('chain_title')}</strong> {t('chain')}
      </p>

      <section aria-labelledby="tracking-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="tracking-list-title">
            <span>{page('shipment_tracking')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: rows.length })}</span>
          </h2>
          <ListToolbar clearHref="/logistics/shipment-tracking" clearLabel={admin('clear_search')} countLabel={admin('rows_shown', { count: rows.length })} placeholder={admin('search_placeholder')} q={outcome.q} searchLabel={admin('search')}>
            <SavedViewsMenu state={saved} />
          </ListToolbar>
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view} label={t('view')} name="view" options={VIEWS.map((key) => ({ value: key, label: viewLabel(key) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="tracking-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{sh('container_no')}</th>
                  <th scope="col">{sh('bl_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{sh('port_of_discharge')}</th>
                  <th scope="col">{sh('status')}</th>
                  <th scope="col">{t('col_stage_since')}</th>
                  <th scope="col">{sh('eta')}</th>
                  <th scope="col">{t('col_delay')}</th>
                  <th scope="col">{t('col_customs')}</th>
                  <th scope="col">{t('col_customs_cleared')}</th>
                  <th scope="col">{t('col_port_file')}</th>
                  <th scope="col">{t('col_last_update')}</th>
                  <th scope="col">{t('col_next_action')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={14}>
                      {t('none_tracking')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <ProfileLink code={row.containerNo} kind="container" qualifier={row.receivedOn || row.cancelled ? { id: row.id } : {}}>
                        {row.containerNo}
                      </ProfileLink>
                      {row.sizeType ? <div className="muted">{row.sizeType}</div> : null}
                      <div className="muted">
                        <bdi dir="ltr">{formatQuantity(row.planned, locale as Locale)}</bdi>
                      </div>
                    </td>
                    <td>
                      <ProfileLink code={row.blNo} kind="bl">
                        {row.blNo}
                      </ProfileLink>
                      {row.vessel ? <div className="muted">{row.vessel}</div> : null}
                    </td>
                    <td>
                      <ProfileLink code={row.payableNo} kind="import">
                        {row.payableNo}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td>
                      <bdi dir="auto">{row.portName ?? '—'}</bdi>
                    </td>
                    <td>
                      {row.cancelled ? (
                        <span className={`status status--cancelled ${s.sapRegisterStatus}`} data-status="cancelled">
                          {sh('cancelled')}
                        </span>
                      ) : (
                        <span className={`status status--${containerChip(row)} ${s.sapRegisterStatus}`} data-status={containerChip(row)}>
                          {cs(row.statusCode, row.statusName)}
                        </span>
                      )}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.statusDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.eta)}</bdi>
                    </td>
                    <td>
                      {row.delayDays === null ? (
                        '—'
                      ) : row.delayDays > 0 ? (
                        <span className="status status--rejected" data-status="rejected">
                          {t('days_late', { count: row.delayDays })}
                        </span>
                      ) : (
                        <span className="muted">{t('on_time')}</span>
                      )}
                    </td>
                    <td>
                      <bdi dir="auto">{row.pdSummary ?? '—'}</bdi>
                      {row.declarationStatus ? <div className="muted">{t.has(`ds.${row.declarationStatus}`) ? t(`ds.${row.declarationStatus}`) : row.declarationStatus}</div> : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.customsClearedOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.portFileSentOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.lastUpdateAt ? formatBusinessDate(businessDateOf(new Date(row.lastUpdateAt)), locale as Locale) : '—'}</bdi>
                      {row.lastNote ? <div className="muted">{row.lastNote}</div> : null}
                    </td>
                    <td>{row.nextAction ? t(`na.${row.nextAction}`) : '—'}</td>
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
