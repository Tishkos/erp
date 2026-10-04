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
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as notes from '@/server/services/customer-notes';

/**
 * Credit Notes / Debit Notes — Receivables, 2026-10-04.
 *
 * The Purchase Invoices' register, holding every adjustment to a customer's
 * account that is not a receipt: credit notes and debit notes raised here,
 * and the credit memos the Sales Return raises for returned goods, listed
 * beside them so "what has this customer been credited or charged?" has one
 * answer. A memo opens read-only — its return is where it is worked.
 */
export const dynamic = 'force-dynamic';

const KINDS = ['credit_note', 'debit_note', 'credit_memo'] as const;

export default async function CreditNotesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/credit-notes')) notFound();

  const [t, admin, page, column, status, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.customer_notes'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', notes.PERMISSION_OBJECT)) {
    return <Denied object={page('customer_credit_memos')} />;
  }
  const mayCreate = can(principal, 'create', notes.PERMISSION_OBJECT);

  const kind = typeof params.kind === 'string' && (KINDS as readonly string[]).includes(params.kind) ? params.kind : '';
  const rows = await withCurrentUser((tx) => notes.list(tx));
  const shown = rows
    .filter((row) => !kind || row.kind === kind)
    .filter((row) => matches(row as unknown as Record<string, unknown>, outcome.q));

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <>
            <Link className="action action--primary" href="/sales/credit-notes/new?kind=credit">
              {t('new_credit')}
            </Link>
            <Link className="action action--primary" href="/sales/credit-notes/new?kind=debit">
              {t('new_debit')}
            </Link>
          </>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/sales/credit-notes" />}
      title={page('customer_credit_memos')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="notes-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="notes-list-title">
            <span>{page('customer_credit_memos')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/sales/credit-notes"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={kind}
                emptyLabel={t('all_kinds')}
                label={t('kind')}
                name="kind"
                options={KINDS.map((value) => ({ value, label: t(`register_${value}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="notes-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{t('kind')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th scope="col">{column('customer_code')}</th>
                  <th scope="col">{column('customer_name')}</th>
                  <th scope="col">{column('invoice_no')}</th>
                  <th className={s.sapNum} scope="col">{column('amount')}</th>
                  <th className={s.sapNum} scope="col">{t('applied_or_received')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>
                      <Link className={s.sapLink} href={`/sales/credit-notes/${encodeURIComponent(row.documentNo)}`}>
                        <bdi dir="ltr">{row.documentNo}</bdi>
                      </Link>
                    </td>
                    <td>{t(`register_${row.kind}`)}</td>
                    <td>
                      <bdi dir="ltr">{day(row.documentDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.kind === 'debit_note' ? day(row.dueDate) : '—'}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.customerCode} kind="customer">{row.customerCode}</ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.customerCode} dir="auto" kind="customer">{row.customerName}</ProfileLink>
                    </td>
                    <td>
                      {row.invoiceNo ? (
                        <Link className={s.sapLink} href={`/sales/ar-invoices/${encodeURIComponent(row.invoiceNo)}`}>
                          <bdi dir="ltr">{row.invoiceNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.allocatedIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status.has(row.status) ? status(row.status) : row.status}
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
