import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s, matches } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ports from '@/server/services/ports';
import { addPort } from './actions';

/**
 * Ports & Routes — REQ-LOG-001 item 15. The ports a B/L discharges at (the
 * `port` table, written for the first time), and under them the routes the
 * B/Ls have taken: port of loading → port of discharge, how often, what is
 * still on the way. Drawn as Purchase Invoices is; the routes are a second
 * register stacked under the first, in the supplier-statement manner.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['active', 'retired', 'all'] as const;

export default async function PortsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/ports')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', ports.PERMISSION_OBJECT)) {
    return <Denied object={page('ports_routes')} />;
  }
  const mayCreate = can(principal, 'create', ports.PERMISSION_OBJECT);
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'active';

  const { rows, routes } = await withCurrentUser(async (tx) => ({
    rows: await ports.list(tx, { view }),
    routes: await ports.routesInUse(tx),
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={t('new_port')} closeLabel={admin('close')} openOnLoad={Boolean(outcome.error)} title={t('new_port')}>
            <p className="muted">{t('new_port_note')}</p>
            <Form action={addPort}>
              <Grid>
                <Field label={t('port_name')} name="name" required />
                <Field label={t('locode')} maxLength={5} name="locode" placeholder="IQUQR" />
                <Field label={t('country')} maxLength={2} name="country" placeholder="IQ" />
              </Grid>
              <SubmitRow>
                <Submit label={t('new_port')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/logistics/ports" />}
      subtitle={t('ports_subtitle')}
      title={page('ports_routes')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="port-list-title" className={`${s.sapDoc} ${s.sapRegister} mb-5`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="port-list-title">
            <span>{page('ports_routes')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>
          <ListToolbar
            clearHref="/logistics/ports"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view} label={t('view')} name="view" options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="port-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('port_code')}</th>
                  <th scope="col">{t('port_name')}</th>
                  <th scope="col">{t('locode')}</th>
                  <th scope="col">{t('country')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_bls')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_inbound')}
                  </th>
                  <th scope="col">{t('col_last_used')}</th>
                  <th scope="col">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('no_ports')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <Link className={s.sapLink} href={`/logistics/ports/${encodeURIComponent(row.code)}`}>
                        <bdi dir="ltr">{row.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.locode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.country ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.blCount}</td>
                    <td className={s.sapNum}>{row.openContainers}</td>
                    <td>
                      <bdi dir="ltr">{day(row.lastBlDate)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.active ? 'approved' : 'cancelled'} ${s.sapRegisterStatus}`} data-status={row.active ? 'approved' : 'cancelled'}>
                        {row.active ? t('active') : t('retired')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Routes in use — what the B/Ls say (item 15) ─────────────────── */}
      <section aria-labelledby="routes-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="routes-title">
            <span>{t('routes_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: routes.length })}</span>
          </h2>
          <p className={`${s.sapNote} m-0 px-4 py-3 sm:px-5`}>{t('routes_subtitle')}</p>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="routes-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('col_from')}</th>
                  <th scope="col">{t('col_to')}</th>
                  <th scope="col">{t('col_lines')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_bls')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_inbound')}
                  </th>
                  <th scope="col">{t('col_last_used')}</th>
                </tr>
              </thead>
              <tbody>
                {routes.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {t('no_routes')}
                    </td>
                  </tr>
                ) : null}
                {routes.map((row) => (
                  <tr key={`${row.portOfLoading}→${row.dischargeCode ?? ''}`}>
                    <td>
                      <bdi dir="auto">{row.portOfLoading}</bdi>
                    </td>
                    <td>
                      {row.dischargeCode ? (
                        <Link className={s.sapLink} href={`/logistics/ports/${encodeURIComponent(row.dischargeCode)}`}>
                          <bdi dir="auto">{row.dischargeName}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <bdi dir="auto">{row.shippingLines ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.bls}</td>
                    <td className={s.sapNum}>{row.openContainers}</td>
                    <td>
                      <bdi dir="ltr">{day(row.lastBlDate)}</bdi>
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
