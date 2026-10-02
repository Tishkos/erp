import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Grid,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as customs from '@/server/services/customs-pd';
import * as shipments from '@/server/services/shipments';
import { createBlAction } from './actions';
import { businessToday } from '@/server/domain/business-date';

/**
 * Shipments — REQ-AP-001 §21.9: the B/Ls, newest first, each with its
 * containers counted "X of Y received" and the least-advanced container's
 * status (a B/L is received only when all its containers are, §17.1). Drawn
 * as Purchase Invoices is.
 */
export const dynamic = 'force-dynamic';

export default async function ShipmentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/shipments')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', shipments.BL_OBJECT)) {
    return <Denied object={page('shipments')} />;
  }
  const mayCreate = can(principal, 'create', shipments.BL_OBJECT);
  const today = businessToday();

  const { rows, imports, ports } = await withCurrentUser(async (tx) => ({
    rows: await shipments.listBls(tx),
    imports: mayCreate ? await customs.importChoices(tx) : [],
    ports: mayCreate ? await shipments.ports(tx) : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const cs = (code: string, name: string) => (locale !== 'en' && t.has(`cs.${code}`) ? t(`cs.${code}`) : name);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('new_bl')}
            closeLabel={admin('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('new_bl')}
            wide
          >
            <p className="muted">{t('new_bl_note')}</p>
            <Form action={createBlAction}>
              <Grid>
                <Select
                  label={t('import')}
                  name="payable_id"
                  options={imports.map((row) => ({
                    value: row.id,
                    label: `${row.payableNo} · ${row.reference} · ${row.supplierName}`,
                  }))}
                  required
                />
                <Field label={t('bl_no')} name="bl_no" required />
                <Field defaultValue={today} label={t('bl_date')} name="bl_date" required type="date" />
                <Field label={t('eta')} name="eta" type="date" />
                <Field label={t('vessel')} name="vessel" />
                <Field label={t('voyage')} name="voyage" />
                <Field label={t('shipping_line')} name="shipping_line" />
                <Field label={t('port_of_loading')} name="port_of_loading" />
                <Select
                  emptyLabel="—"
                  label={t('port_of_discharge')}
                  name="port_of_discharge"
                  options={ports.map((p) => ({ value: p.code, label: p.name }))}
                />
                <Field hint={t('size_type_hint')} label={t('size_type')} name="size_type" />
              </Grid>
              <Field hint={t('containers_hint')} label={t('containers')} name="containers" type="textarea" wide />
              <Checkbox defaultChecked label={t('spread_lines')} name="spread_lines" />
              <SubmitRow>
                <Submit label={t('new_bl')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/shipments" />}
      subtitle={t('subtitle')}
      title={page('shipments')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="bl-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="bl-list-title">
            <span>{page('shipments')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>
          <ListToolbar
            clearHref="/payables/shipments"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="bl-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('bl_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('bl_date')}</th>
                  <th scope="col">{t('vessel')}</th>
                  <th scope="col">{t('port_of_discharge')}</th>
                  <th scope="col">{t('eta')}</th>
                  <th scope="col">{t('received_x_of_y')}</th>
                  <th scope="col">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('no_bls')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/shipments/${encodeURIComponent(row.blNo)}`}>
                        <bdi dir="ltr">{row.blNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                      <div className="muted">
                        <bdi dir="ltr">{row.reference}</bdi>
                      </div>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.blDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{[row.vessel, row.voyage].filter(Boolean).join(' / ') || '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.portName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.eta)}</bdi>
                    </td>
                    <td>
                      <span
                        className={`status status--${row.total > 0 && row.received === row.total ? 'settled' : row.received > 0 ? 'submitted' : 'draft'} ${s.sapRegisterStatus}`}
                        data-status={row.total > 0 && row.received === row.total ? 'settled' : row.received > 0 ? 'submitted' : 'draft'}
                      >
                        {t('x_of_y', { received: row.received, total: row.total })}
                      </span>
                    </td>
                    <td>{row.cancelledAt ? t('cancelled') : (row.leastStatusCode && row.leastStatus ? cs(row.leastStatusCode, row.leastStatus) : '—')}</td>
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
