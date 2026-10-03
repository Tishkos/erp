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
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';
import * as expenses from '@/server/services/expenses';
import * as partners from '@/server/services/partners';
import { addExpenseAction } from './actions';
import { businessToday } from '@/server/domain/business-date';

/**
 * Purchase Invoices — Operations build, block 4.
 *
 *   Header   Invoice Number (automatically generated); Posting Date; Due Date;
 *            Supplier Code; Supplier Name.
 *
 * The register shows those five and what the invoice came to, which is the
 * column a person actually scans for. The supplier's name is joined from the
 * partner rather than copied onto the invoice, so a supplier renamed this year
 * reads correctly on an invoice raised last year.
 *
 * D12 / D13 (2026-10-01) — the register is also where expenses live and where
 * imports start. "Add expense" is the quick form for the rent, the forwarder,
 * the broker, the bill; the Payment column says Unpaid / Paid / Overdue from
 * what the invoice already holds; the View filter separates imports from
 * expenses. Same register, same components — nothing new is drawn.
 */
export const dynamic = 'force-dynamic';

export default async function ApInvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/invoices')) notFound();

  const [t, x, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.expenses'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }
  const mayCreate = can(principal, 'create', ap.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const today = businessToday();

  const { rows, notes, suppliers, categories, imports } = await withCurrentUser(async (tx) => ({
    rows: await ap.list(tx),
    notes: await expenses.latestNotes(tx),
    suppliers: mayCreate ? await partners.listActiveInRole(tx, 'supplier') : [],
    categories: mayCreate ? await expenses.categories(tx) : [],
    imports: mayCreate ? await expenses.openImports(tx) : [],
  }));

  const withState = rows.map((row) => ({
    ...row,
    state: expenses.paymentState(
      {
        status: row.status,
        dueDate: row.dueDate,
        totalIqd: row.totalIqd,
        settledAmountIqd: row.settledAmountIqd,
      },
      today,
    ),
  }));
  const shown = withState
    .filter((row) => matches(row, outcome.q))
    .filter((row) =>
      viewParam === 'imports'
        ? row.isImport
        : viewParam === 'expenses'
          ? Boolean(row.expenseCategoryCode)
          : viewParam === 'overdue'
            ? row.state === 'overdue'
            : viewParam === 'unpaid'
              ? row.state === 'unpaid' || row.state === 'part_paid' || row.state === 'overdue'
              : true,
    );

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/payables/invoices/new">
            {t('ap_invoices.new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/payables/invoices" />}
      subtitle={t('ap_invoices.subtitle')}
      title={t('ap_invoices.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="ap-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="ap-list-title">
            <span>{t('ap_invoices.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/invoices"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={[
                  { value: 'imports', label: x('view_imports') },
                  { value: 'expenses', label: x('view_expenses') },
                  { value: 'unpaid', label: x('view_unpaid') },
                  { value: 'overdue', label: x('view_overdue') },
                ]}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="ap-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{x('col_payment')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('ap_invoices.none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/invoices/${encodeURIComponent(row.invoiceNo)}`}
                      >
                        <bdi dir="ltr">{row.invoiceNo}</bdi>
                      </Link>
                      {row.payableNo ? (
                        <>
                          {' · '}
                          <Link
                            className={s.sapLink}
                            href={`/payables/${encodeURIComponent(row.payableNo)}`}
                            title={x('import_tracking')}
                          >
                            <bdi dir="ltr">{row.payableNo}</bdi>
                          </Link>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.invoiceDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.dueDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.supplierCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.totalIqd, 'IQD', locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span
                        className={`status status--${row.status} ${s.sapRegisterStatus}`}
                        data-status={row.status}
                      >
                        {status(row.status)}
                      </span>
                    </td>
                    <td>
                      {row.state === 'reversed' ? (
                        '—'
                      ) : (
                        <span
                          className={`status status--${row.state === 'paid' ? 'settled' : row.state === 'overdue' ? 'rejected' : row.state === 'part_paid' ? 'partially_executed' : 'submitted'} ${s.sapRegisterStatus}`}
                          data-status={row.state === 'paid' ? 'settled' : row.state === 'overdue' ? 'rejected' : row.state === 'part_paid' ? 'partially_executed' : 'submitted'}
                        >
                          {row.state === 'overdue'
                            ? x('state_overdue_days', { days: expenses.daysBetween(row.dueDate, today) })
                            : x(`state_${row.state}`)}
                        </span>
                      )}
                      {row.state === 'overdue' && notes.get(row.id) ? (
                        <div className="muted">
                          <bdi dir="auto">{notes.get(row.id)}</bdi>
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
