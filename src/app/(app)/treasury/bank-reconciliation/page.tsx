import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as rec from '@/server/services/bank-reconciliation';
import * as statements from '@/server/services/bank-statement';
import * as bankCash from '@/server/services/bank-cash-accounts';
import { openStatementAction } from './actions';
import { STAGE_CHIP } from './stage';

/**
 * Bank Reconciliation — REQ-ACC-001 Part D-3.
 *
 * One register over the bank's statements and their reconciliations, drawn
 * as Purchase Invoices is. A statement is entered from the dialog (whose
 * account, which period, the bank's own two balances); its lines, the
 * matching, the adjustments, the agreement and a reopening are all on its
 * record. The engines are Phase 07.6 and 07.7's — nothing here decides.
 */
export const dynamic = 'force-dynamic';

export default async function BankReconciliationsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/bank-reconciliation')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.bank_reconciliation'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', rec.PERMISSION_OBJECT)) {
    return <Denied object={page('bank_reconciliation')} />;
  }
  const mayCreate = can(principal, 'create', statements.PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (rec.RECONCILIATION_VIEWS as readonly string[]).includes(String(params.view))
    ? (params.view as rec.ReconciliationView)
    : null;
  const accountCode = typeof params.account === 'string' ? params.account : '';

  const { result, banks } = await withCurrentUser(async (tx, request) => {
    const ctx = { principal: request.principal, branchCode: request.scope.branchCode };
    return {
      result: await rec.listForScreen(tx, ctx, { view, accountCode, search: outcome.q, page: outcome.page }),
      // A statement comes from a bank; a cash float is counted instead.
      banks: (await bankCash.listOfKind(tx, 'bank')).filter((account) => account.active),
    };
  });
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', view ? `view=${view}` : '', accountCode ? `account=${encodeURIComponent(accountCode)}` : '', `page=${p}`]
      .filter(Boolean)
      .join('&');
  const day = (value: string) => formatBusinessDate(value, locale as Locale);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('new')}
            closeLabel={admin('close')}
            openOnLoad={params.statement === 'new' && Boolean(outcome.error)}
            title={t('new')}
          >
            <p className="muted">{t('new_note')}</p>
            <Form action={openStatementAction}>
              <Grid>
                <Select
                  label={t('account')}
                  name="bank_cash_account_id"
                  options={banks.map((account) => ({ value: account.id, label: `${account.name} (${account.code}) · ${account.currency}` }))}
                  required
                />
                <Field label={t('bank_reference')} name="bank_reference" />
                <Field label={t('period_from')} name="period_from" required type="date" />
                <Field label={t('period_to')} name="period_to" required type="date" />
                <Field hint={t('opening_hint')} label={t('opening')} name="opening" required />
                <Field hint={t('closing_hint')} label={t('closing')} name="closing" required />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/treasury/bank-reconciliation" />}
      subtitle={t('subtitle')}
      title={page('bank_reconciliation')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="reconciliation-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="reconciliation-list-title">
            <span>{page('bank_reconciliation')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/treasury/bank-reconciliation"
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
                options={rec.RECONCILIATION_VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <Select
                defaultValue={accountCode}
                emptyLabel={t('any_account')}
                label={t('account')}
                name="account"
                options={banks.map((account) => ({ value: account.code, label: `${account.name} (${account.code})` }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="reconciliation-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_statement')}</th>
                  <th scope="col">{t('account')}</th>
                  <th scope="col">{t('col_period')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('closing')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_unmatched')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('difference')}
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
                  <tr key={row.statementId}>
                    <td>
                      <Link className={s.sapLink} href={`/treasury/bank-reconciliation/${encodeURIComponent(row.statementNo)}`}>
                        <bdi dir="ltr">{row.statementNo}</bdi>
                      </Link>
                      {row.reconciliationNo ? (
                        <div className="muted">
                          <bdi dir="ltr">{row.reconciliationNo}</bdi>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <bdi dir="auto">{`${row.accountName} (${row.accountCode})`}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{`${day(row.periodFrom)} – ${day(row.periodTo)}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.closingIqd, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${row.unmatchedCount} / ${row.lineCount}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.differenceIqd === null ? '—' : formatMoney(row.differenceIqd, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${STAGE_CHIP[row.stage]} ${s.sapRegisterStatus}`} data-status={STAGE_CHIP[row.stage]}>
                        {t(`stage_${row.stage}`)}
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
              hrefFor={(p) => `/treasury/bank-reconciliation?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
