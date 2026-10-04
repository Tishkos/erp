import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, Hidden, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as treasury from '@/server/services/treasury';
import * as bankCash from '@/server/services/bank-cash-accounts';
import { createTransferAction } from './actions';

/**
 * Internal Transfers — REQ-ACC-001 Part D-2.
 *
 * The company's own money moving between its own bank and cash accounts:
 * bank to bank, bank to cash, cash to bank, cash to cash. One register over
 * `bank_transfer`, drawn as Purchase Invoices is — the section's tabs, one
 * register window, the search box and one filter, the status chip last.
 * Raised from the dialog, approved by somebody else, posted and, when wrong,
 * reversed on its record.
 */
export const dynamic = 'force-dynamic';

export default async function TransfersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/transfers')) notFound();

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.internal_transfers'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', treasury.PERMISSION_OBJECT)) {
    return <Denied object={page('bank_transfers')} />;
  }
  const mayCreate = can(principal, 'create', treasury.PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (treasury.TRANSFER_VIEWS as readonly string[]).includes(String(params.view))
    ? (params.view as treasury.TransferView)
    : null;
  const accountCode = typeof params.account === 'string' ? params.account : '';

  const { result, accounts } = await withCurrentUser(async (tx, request) => {
    const ctx = { principal: request.principal, branchCode: request.scope.branchCode };
    return {
      result: await treasury.listTransfers(tx, ctx, { view, accountCode, search: outcome.q, page: outcome.page }),
      // Only the accounts Master Data keeps open: the transfer screen never
      // creates an account (REQ-ACC-001 Part A).
      accounts: [...(await bankCash.listOfKind(tx, 'bank')), ...(await bankCash.listOfKind(tx, 'cash'))].filter(
        (account) => account.active,
      ),
    };
  });
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', view ? `view=${view}` : '', accountCode ? `account=${encodeURIComponent(accountCode)}` : '', `page=${p}`]
      .filter(Boolean)
      .join('&');
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const accountOptions = accounts.map((account) => ({
    value: account.id,
    label: `${account.name} (${account.code}) · ${account.currency}`,
  }));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('new')}
            closeLabel={admin('close')}
            openOnLoad={params.transfer === 'new' && Boolean(outcome.error)}
            title={t('new')}
          >
            <p className="muted">{t('new_note')}</p>
            <Form action={createTransferAction}>
              <Hidden name="document_id" value={randomUUID()} />
              <Grid>
                <Select label={t('from')} name="from_account_id" options={accountOptions} required />
                <Select label={t('to')} name="to_account_id" options={accountOptions} required />
                <Field defaultValue={businessToday()} label={t('date')} name="transfer_date" required type="date" />
                <Field hint={t('amount_hint')} label={t('amount')} name="amount" required />
                <Field hint={t('received_hint')} label={t('received')} name="received_amount" />
                <Field hint={t('rate_hint')} label={t('rate')} name="fx_rate" />
                <Field label={t('reference')} name="bank_reference" />
              </Grid>
              <Field label={t('purpose')} name="note" wide />
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/treasury/transfers" />}
      subtitle={t('subtitle')}
      title={page('bank_transfers')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="transfer-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="transfer-list-title">
            <span>{page('bank_transfers')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/treasury/transfers"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view ?? ''}
                emptyLabel={t('view_all')}
                label={t('view')}
                name="view"
                options={treasury.TRANSFER_VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <Select
                defaultValue={accountCode}
                emptyLabel={t('any_account')}
                label={t('account')}
                name="account"
                options={accounts.map((account) => ({ value: account.code, label: `${account.name} (${account.code})` }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="transfer-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('date')}</th>
                  <th scope="col">{t('from')}</th>
                  <th scope="col">{t('to')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('received')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
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
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/treasury/transfers/${encodeURIComponent(row.transferNo)}`}>
                        <bdi dir="ltr">{row.transferNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.transferDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{`${row.fromName} (${row.fromCode})`}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{`${row.toName} (${row.toCode})`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.amount, row.fromCurrency, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.receivedAmount, row.toCurrency, locale as Locale)}</bdi>
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
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/treasury/transfers?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
