import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, FilterRow, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as openItems from '@/server/services/open-items';

/**
 * Receivables and Payables — §15 and §16, written once.
 *
 * The two reports are the same report in a mirror, so they are the same
 * component pointed at either side. Separate screens would drift: one would
 * gain a column, the other would gain a different definition of "overdue", and
 * the day somebody compared them would be the day neither was trusted.
 *
 * Every row is one invoice, with the terms that set its due date, what has been
 * paid against it, what is left, and how late that remainder is. A settled
 * invoice stays on the list, greyed, because *"days late after payment"* is a
 * question about invoices that have been paid — and dropping them the moment
 * the balance reaches zero deletes the only evidence of how an account is
 * actually being settled.
 */

export interface OpenItemsPageProps {
  readonly side: openItems.Side;
  readonly route: string;
  readonly titleKey: string;
  readonly exportKey: 'receivables' | 'payables';
  readonly invoiceHref: (invoiceNo: string) => string;
  readonly searchParams: SearchParams;
}

export async function OpenItemsReport({
  side,
  route,
  titleKey,
  exportKey,
  invoiceHref,
  searchParams,
}: OpenItemsPageProps) {
  const [t, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', openItems.PERMISSION_OBJECT[side])) {
    return <Denied object={page(titleKey)} />;
  }

  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const asOf = one('as_at') || new Date().toISOString().slice(0, 10);
  const show = one('show') === 'all' || one('show') === 'overdue' ? one('show') : 'open';

  const items = await withCurrentUser((tx, request) =>
    openItems.openItems(tx, request.principal, side, asOf, {
      branchCode: request.scope.branchCode,
      outstandingOnly: show !== 'all',
      overdueOnly: show === 'overdue',
    }),
  );

  const buckets = openItems.ageing(items);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const total = (pick: (row: openItems.OpenItem) => string) =>
    String(items.reduce((sum, row) => sum + Number(pick(row)), 0));

  const partyColumn = side === 'customer' ? column('customer_name') : column('supplier_name');

  /**
   * How late, in words a person acts on.
   *
   * "Due in 6 days" and "11 days overdue" are different facts and read
   * differently; a single signed number makes the reader do the subtraction
   * and, on a bad day, get the sign wrong.
   */
  const lateness = (item: openItems.OpenItem) => {
    if (Number(item.outstandingIqd) <= 0) {
      return item.daysLateAtLastPayment === null ? (
        <span className="muted">{t('open_items.paid')}</span>
      ) : item.daysLateAtLastPayment > 0 ? (
        <span className="muted">
          {t('open_items.paid_late', { days: item.daysLateAtLastPayment })}
        </span>
      ) : (
        <span className="muted">{t('open_items.paid_on_time')}</span>
      );
    }
    if (item.daysOverdue > 0) {
      return <span className={s.sapWarn}>{t('open_items.overdue_by', { days: item.daysOverdue })}</span>;
    }
    return <span>{t('open_items.due_in', { days: item.daysUntilDue })}</span>;
  };

  return (
    <AdminPage
      actions={<ExportMenu exportKey={exportKey} query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t(`open_items.subtitle_${side}`)}
      tabs={<SectionTabs route={route} />}
      title={page(titleKey)}
      variant="sap"
    >
      <Panel flush>
        <form className={s.filterBar} method="get">
          <FilterRow>
            <Field defaultValue={asOf} label={t('reports.as_at_label')} name="as_at" type="date" />
            <Select
              defaultValue={show}
              label={t('open_items.show')}
              name="show"
              options={[
                { value: 'open', label: t('open_items.show_open') },
                { value: 'overdue', label: t('open_items.show_overdue') },
                { value: 'all', label: t('open_items.show_all') },
              ]}
            />
            <SubmitRow>
              <Submit label={t('stock_movements.filter')} />
            </SubmitRow>
          </FilterRow>
        </form>

        {/* The ageing, above the rows it summarises — the figure a manager
            reads first, and the rows below are its evidence. */}
        {buckets.length > 0 ? (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{t('open_items.ageing')}</th>
                  {buckets.map((bucket) => (
                    <th key={bucket.bucket} scope="col">
                      {t(`dashboard.${BUCKET_KEY[bucket.bucket]}`)}
                    </th>
                  ))}
                  <th scope="col">{t('reports.totals')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{t('open_items.outstanding')}</strong>
                  </td>
                  {buckets.map((bucket) => (
                    <td key={bucket.bucket}>
                      <bdi dir="ltr">{money(bucket.amountIqd)}</bdi>{' '}
                      <span className="muted">({bucket.invoices})</span>
                    </td>
                  ))}
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(total((row) => row.outstandingIqd))}</bdi>
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        {items.length === 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {t('open_items.nothing')}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{partyColumn}</th>
                  <th scope="col">{column('invoice_no')}</th>
                  <th scope="col">{column('invoice_date')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th scope="col">{t('open_items.terms')}</th>
                  <th scope="col">{column('total_price')}</th>
                  <th scope="col">{t('open_items.paid')}</th>
                  <th scope="col">{t('open_items.outstanding')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{t('open_items.lateness')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.invoiceId}>
                    <td>
                      <bdi dir="auto">{item.partyName}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{item.partyCode}</bdi>
                      </span>
                    </td>
                    <td className={s.sapAccountCell}>
                      <Link href={invoiceHref(item.invoiceNo)}>
                        <bdi dir="ltr">{item.invoiceNo}</bdi>
                      </Link>
                      {/* Partial payment, made legible: each payment with its
                          own date and amount, so a history is kept rather than
                          collapsed into one number. */}
                      {item.payments.length > 0 ? (
                        <div className="muted" style={{ fontSize: '0.68rem' }}>
                          {item.payments.map((payment, index) => (
                            <div key={`${payment.documentNo}-${index}`}>
                              <bdi dir="ltr">
                                {day(payment.paidOn)} · {money(payment.amountIqd)}
                                {payment.documentNo ? ` · ${payment.documentNo}` : ''}
                              </bdi>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(item.invoiceDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(item.dueDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{item.paymentTermsName ?? item.paymentTermsCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(item.totalIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(item.paidIqd)}</bdi>
                    </td>
                    <td>
                      <strong>
                        <bdi dir="ltr">{money(item.outstandingIqd)}</bdi>
                      </strong>
                    </td>
                    <td>
                      <span className={`status status--${item.status}`} data-status={item.status}>
                        {item.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td>{lateness(item)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5}>
                    <strong>{t('reports.totals')}</strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(total((row) => row.totalIqd))}</bdi>
                    </strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(total((row) => row.paidIqd))}</bdi>
                    </strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(total((row) => row.outstandingIqd))}</bdi>
                    </strong>
                  </td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </AdminPage>
  );
}

/** The dashboard already names these buckets; one wording, not two. */
const BUCKET_KEY: Record<string, string> = {
  current: 'bucket_current',
  '1-30': 'bucket_1_30',
  '31-60': 'bucket_31_60',
  '61-90': 'bucket_61_90',
  '90+': 'bucket_over_90',
};
