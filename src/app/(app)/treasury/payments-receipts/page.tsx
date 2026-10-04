import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import { accountHref, journalHref, moneyDocumentHref, partnerHref } from '@/server/domain/accounting-links';
import * as reports from '@/server/services/treasury-reports';

/**
 * Payments & Receipts — REQ-ACC-001 Part D-4.
 *
 * One treasury register of the money that actually moved, across every bank
 * and cash account: each line the ledger holds on those accounts, with the
 * account, the party and the document behind it, each opening its own page.
 * A read, not an engine — receipts stay with Sales, payments with Payables,
 * transfers with Treasury; this shows what their postings did to the money.
 * Drawn as Purchase Invoices is: tabs, one register window, the search box,
 * the filters, the paging.
 */
export const dynamic = 'force-dynamic';

export default async function PaymentsReceiptsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/payments-receipts')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payments_receipts'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'view', reports.PERMISSION_OBJECT)) {
    return <Denied object={page('payments_receipts')} />;
  }

  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const from = one('from') || `${businessToday().slice(0, 4)}-01-01`;
  const to = one('to') || businessToday();
  const view = (reports.MONEY_VIEWS as readonly string[]).includes(one('view')) ? (one('view') as reports.MoneyView) : null;
  const accountCode = one('account');

  const { result, accounts } = await withCurrentUser(async (tx, request) => {
    const actor = { principal: request.principal, branchCode: request.scope.branchCode };
    return {
      result: await reports.moneyRegister(tx, actor, { from, to, view, accountCode, search: outcome.q, page: outcome.page }),
      accounts: await reports.positions(tx, actor, { from, to }, {}),
    };
  });
  const query = (p: number) =>
    [
      `from=${from}`,
      `to=${to}`,
      outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '',
      view ? `view=${view}` : '',
      accountCode ? `account=${encodeURIComponent(accountCode)}` : '',
      `page=${p}`,
    ]
      .filter(Boolean)
      .join('&');
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="payments_receipts" query={params} />}
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/treasury/payments-receipts" />}
      subtitle={t('subtitle')}
      title={page('payments_receipts')}
      variant="sap"
    >
      <section aria-labelledby="money-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="money-list-title">
            <span>{page('payments_receipts')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/treasury/payments-receipts"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Field defaultValue={from} label={t('from')} name="from" type="date" />
              <Field defaultValue={to} label={t('to')} name="to" type="date" />
              <Select
                defaultValue={view ?? ''}
                emptyLabel={t('view_all')}
                label={t('view')}
                name="view"
                options={reports.MONEY_VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <Select
                defaultValue={accountCode}
                emptyLabel={t('any_account')}
                label={t('account')}
                name="account"
                options={accounts.map((account) => ({ value: account.accountCode, label: `${account.accountName} (${account.accountCode})` }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="money-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('date')}</th>
                  <th scope="col">{t('document')}</th>
                  <th scope="col">{t('account')}</th>
                  <th scope="col">{t('party')}</th>
                  <th scope="col">{t('movement')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('money_in')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('money_out')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => {
                  const documentHref = moneyDocumentHref(row.documentType, row.documentNo);
                  return (
                    <tr key={row.journalLineId}>
                      <td>
                        <bdi dir="ltr">{day(row.postingDate)}</bdi>
                      </td>
                      <td>
                        {documentHref ? (
                          <Link className={s.sapLink} href={documentHref}>
                            <bdi dir="ltr">{row.documentNo}</bdi>
                          </Link>
                        ) : (
                          <bdi dir="ltr">{row.documentNo ?? '—'}</bdi>
                        )}
                        <div className="muted">
                          <Link className={s.sapLink} href={journalHref(row.entryNo)}>
                            <bdi dir="ltr">{row.entryNo}</bdi>
                          </Link>
                          {row.documentType ? ` · ${t(`type_${row.documentType}`)}` : ''}
                        </div>
                      </td>
                      <td>
                        <Link className={s.sapLink} href={accountHref(row.accountKind, row.accountCode)}>
                          <bdi dir="auto">{`${row.accountName} (${row.accountCode})`}</bdi>
                        </Link>
                      </td>
                      <td>
                        {row.partyCode ? (
                          <Link
                            className={s.sapLink}
                            href={partnerHref(row.partyCode, { isCustomer: row.partyIsCustomer, isSupplier: row.partyIsSupplier })}
                          >
                            <bdi dir="auto">{row.partyName ?? row.partyCode}</bdi>
                          </Link>
                        ) : (
                          <bdi dir="auto">{row.description ?? '—'}</bdi>
                        )}
                      </td>
                      <td>
                        {t(`kind_${row.kind}`)}
                        {row.isReversal ? <div className="muted">{t('reversal')}</div> : null}
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{row.direction === 'in' ? money(row.amountIqd) : ''}</bdi>
                        {row.direction === 'in' && row.txnCurrency !== 'IQD' ? (
                          <span className={s.sapEnteredNote}>{formatMoney(row.amountTxn, row.txnCurrency, locale as Locale)}</span>
                        ) : null}
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{row.direction === 'out' ? money(row.amountIqd) : ''}</bdi>
                        {row.direction === 'out' && row.txnCurrency !== 'IQD' ? (
                          <span className={s.sapEnteredNote}>{formatMoney(row.amountTxn, row.txnCurrency, locale as Locale)}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className={s.sapTotalRow}>
                  <td colSpan={5}>{t('totals')}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(result.totalInIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(result.totalOutIqd)}</bdi>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/treasury/payments-receipts?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
