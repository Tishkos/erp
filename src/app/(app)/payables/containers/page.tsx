import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  FilterRow,
  Flash,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as shipments from '@/server/services/shipments';
import { containerChip } from './status';

/**
 * Containers in transit — REQ-AP-001 §21.9 (REQ-APP-001 S5). Every container
 * on its own, the soonest ETA first: where it is, how late, what it carries,
 * and where it was received. Drawn as Purchase Invoices is.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['in_transit', 'late', 'received', 'all'] as const;

export default async function ContainersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/containers')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', shipments.CONTAINER_OBJECT)) {
    return <Denied object={page('containers')} />;
  }
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view))
    ? (params.view as (typeof VIEWS)[number])
    : 'in_transit';

  const rows = await withCurrentUser((tx) => shipments.listContainers(tx, { view }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const cs = (code: string, name: string) => (locale !== 'en' && t.has(`cs.${code}`) ? t(`cs.${code}`) : name);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/containers" />}
      subtitle={t('containers_subtitle')}
      title={page('containers')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="container-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="container-list-title">
            <span>{page('containers')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>
          <ListToolbar
            clearHref="/payables/containers"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view}
                label={t('view')}
                name="view"
                options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="container-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('container_no')}</th>
                  <th scope="col">{t('bl_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('port_of_discharge')}</th>
                  <th scope="col">{t('eta')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('days_since_eta')}
                  </th>
                  <th scope="col">{t('status')}</th>
                  <th scope="col">{t('warehouse')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('planned_received')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {t('no_containers')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/containers/${encodeURIComponent(row.containerNo)}${row.receivedOn ? `?id=${row.id}` : ''}`}
                      >
                        <bdi dir="ltr">{row.containerNo}</bdi>
                      </Link>
                      {row.sizeType ? <div className="muted">{row.sizeType}</div> : null}
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/shipments/${encodeURIComponent(row.blNo)}`}>
                        <bdi dir="ltr">{row.blNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.portName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.eta)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      {row.daysSinceEta === null ? (
                        '—'
                      ) : row.daysSinceEta > 0 ? (
                        <span className="status status--rejected" data-status="rejected">
                          {row.daysSinceEta}
                        </span>
                      ) : row.daysSinceEta < 0 ? (
                        <span className="muted">{t('eta_in_days', { count: -row.daysSinceEta })}</span>
                      ) : (
                        row.daysSinceEta
                      )}
                    </td>
                    <td>
                      <span
                        className={`status status--${containerChip(row)} ${s.sapRegisterStatus}`}
                        data-status={containerChip(row)}
                      >
                        {cs(row.statusCode, row.statusName)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.warehouseCode ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {formatQuantity(row.planned, locale as Locale)} /{' '}
                        {row.receivedOn ? formatQuantity(row.received, locale as Locale) : '—'}
                      </bdi>
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
