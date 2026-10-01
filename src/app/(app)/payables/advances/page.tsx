import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  FilterRow,
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
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as advances from '@/server/services/supplier-advance';
import { requestAdvance } from './actions';

/**
 * Supplier advances — §8.5 and REQ-AP-001 §21.1.
 *
 * Money paid to a supplier before the invoice: a deposit on an import
 * (created by confirming its payment application), or one raised here against
 * a committed purchase order. The register is drawn as Purchase Invoices is;
 * the Unapplied column is what is still the company's claim on the supplier.
 */
export const dynamic = 'force-dynamic';

const VIEWS: Readonly<Record<string, readonly string[]>> = {
  to_approve: ['draft'],
  to_pay: ['approved'],
  paid: ['posted', 'partially_executed'],
  settled: ['settled', 'closed'],
};

export default async function AdvancesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/advances')) notFound();

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.supplier_advances'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', advances.PERMISSION_OBJECT)) {
    return <Denied object={page('supplier_advances')} />;
  }
  const mayCreate = can(principal, 'create', advances.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const today = new Date().toISOString().slice(0, 10);

  const { rows, orders } = await withCurrentUser(async (tx) => ({
    rows: await advances.listForScreen(tx),
    orders: mayCreate ? await advances.orderChoices(tx) : [],
  }));
  const inView = VIEWS[viewParam];
  const shown = rows
    .filter((row) => matches(row, outcome.q))
    .filter((row) => (inView ? inView.includes(row.status) : true));
  const unapplied = (row: (typeof rows)[number]) =>
    toDecimalString(
      parseDecimal(row.amountIqd, 4n) - parseDecimal(row.settledAmountIqd, 4n) - parseDecimal(row.refundedAmountIqd, 4n),
      4n,
    );

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('new')}
            closeLabel={admin('close')}
            openOnLoad={params.advance === '1' && Boolean(outcome.error)}
            title={t('new')}
          >
            <p className="muted">{t('new_note')}</p>
            <Form action={requestAdvance}>
              <Grid>
                <Select
                  label={t('order')}
                  name="purchase_order_id"
                  options={orders.map((order) => ({
                    value: order.id,
                    label: `${order.orderNo} · ${order.supplierName}`,
                  }))}
                  required
                />
                <Field label={t('amount')} name="amount" required />
                <Field defaultValue={today} label={t('request_date')} name="request_date" required type="date" />
              </Grid>
              <Field label={t('reason')} name="reason" wide />
              <SubmitRow>
                <Submit label={t('request')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/advances" />}
      subtitle={t('subtitle')}
      title={page('supplier_advances')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="advance-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="advance-list-title">
            <span>{page('supplier_advances')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/advances"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={viewParam}
                emptyLabel={t('view_all')}
                label={t('view')}
                name="view"
                options={Object.keys(VIEWS).map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="advance-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('order')}</th>
                  <th scope="col">{t('col_supplier')}</th>
                  <th scope="col">{t('request_date')}</th>
                  <th scope="col">{t('paid_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('unapplied')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/advances/${encodeURIComponent(row.advanceNo)}`}>
                        <bdi dir="ltr">{row.advanceNo}</bdi>
                      </Link>
                      {row.payableNo ? (
                        <>
                          {' · '}
                          <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                            <bdi dir="ltr">{row.payableNo}</bdi>
                          </Link>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{row.orderNo}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.requestDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.paidDate ? formatBusinessDate(row.paidDate, locale as Locale) : '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.amountIqd, 'IQD', locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {row.paidDate ? formatMoney(unapplied(row), 'IQD', locale as Locale) : '—'}
                      </bdi>
                    </td>
                    <td>
                      <span
                        className={`status status--${row.status} ${s.sapRegisterStatus}`}
                        data-status={row.status}
                      >
                        {status(row.status)}
                      </span>
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
