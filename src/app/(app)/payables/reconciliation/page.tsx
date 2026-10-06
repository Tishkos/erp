import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as balances from '@/server/services/supplier-balances';
import * as openItems from '@/server/services/open-items';

/**
 * Supplier Reconciliation — REQ-PAY-001 PAY11 (2026-10-04), the Purchase
 * Invoices register's shape. Three windows, all read-only:
 *
 *   1. the supplier control accounts — the supplier subledger beside the A/P
 *      control account in the General Ledger, as of a date, and the
 *      difference (`subledger.reconciliation`, the close check's own read);
 *   2. the investigation — every journal line behind a difference, with why
 *      (a line that named no supplier, amounts that differ, a line filed under
 *      another control account, a subledger entry whose journal is not posted),
 *      each opening its journal entry;
 *   3. by supplier — the control-account balance beside the open invoices, the
 *      way the Payables Ageing ties them (`open-items.reconcile`), with the
 *      unapplied credits and the non-invoice debits that explain the rest.
 *
 * Nothing here repairs anything. A difference is fixed by somebody who opened
 * the entry and decided (owner, 4.9). Authorised on `ap_invoice` (D-PAY-5).
 */
export const dynamic = 'force-dynamic';

export default async function SupplierReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/reconciliation')) notFound();

  const [t, x, page, column, status, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.supplier_reconciliation'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', balances.RECONCILIATION_OBJECT)) {
    return <Denied object={page('ap_reconciliation')} />;
  }

  const asOf = typeof params.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.as_of) ? params.as_of : businessToday();

  const { controls, exceptions, items, ledger } = await withCurrentUser(async (tx) => ({
    controls: await balances.controlAccounts(tx, principal, asOf),
    exceptions: await balances.exceptions(tx, principal, asOf),
    items: await openItems.openItems(tx, principal, 'supplier', asOf),
    ledger: await openItems.ledgerBalances(tx, principal, 'supplier', asOf),
  }));
  const reconciled = openItems.reconcile(items, ledger);
  const tie = openItems.reconciliationTotals(reconciled);

  const money = (amount: string | bigint) =>
    formatMoney(typeof amount === 'bigint' ? toDecimalString(amount, MONEY_SCALE) : amount, 'IQD', locale as Locale);
  const sum = (pick: (row: balances.ControlRow) => bigint) => controls.reduce((total, row) => total + pick(row), 0n);
  const subledgerTotal = sum((row) => row.subledgerIqd);
  const controlTotal = sum((row) => row.generalLedgerIqd);
  const difference = sum((row) => row.differenceIqd);
  const net = (debit: string | null, credit: string | null) =>
    debit === null || credit === null ? null : parseDecimal(debit, MONEY_SCALE) - parseDecimal(credit, MONEY_SCALE);

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/payables/reconciliation" />}
      subtitle={x('subtitle')}
      title={page('ap_reconciliation')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {/* ── 1. The control accounts ──────────────────────────────────── */}
      <section aria-labelledby="ap-reconciliation-controls" className={`${s.sapDoc} ${s.sapRegister} mb-5`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="ap-reconciliation-controls">
            <span>{x('control_title')}</span>
            <span className={s.sapTitleMeta}>
              <bdi dir="ltr">{formatBusinessDate(asOf, locale as Locale)}</bdi>
            </span>
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Field defaultValue={asOf} label={x('as_of')} name="as_of" type="date" />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <p className={`${s.sapNote} m-0 px-4 py-3 sm:px-5`}>
            {difference === 0n ? x('ties', { amount: money(subledgerTotal) }) : x('does_not_tie', { amount: money(difference) })}
          </p>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="ap-reconciliation-controls" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('account_code')}</th>
                  <th scope="col">{x('account_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('subledger')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('control')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('difference')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {controls.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {x('no_control_accounts')}
                    </td>
                  </tr>
                ) : null}
                {controls.map((row) => (
                  <tr key={row.accountCode}>
                    <td className={s.sapAccountCell}>
                      <ProfileLink code={row.accountCode} kind="gl_account" />
                    </td>
                    <td>
                      <bdi dir="auto">{row.accountName}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.subledgerIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.generalLedgerIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <span className={`status status--${row.differenceIqd === 0n ? 'settled' : 'rejected'}`} data-status={row.differenceIqd === 0n ? 'settled' : 'rejected'}>
                        <bdi dir="ltr">{money(row.differenceIqd)}</bdi>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              {controls.length > 0 ? (
                <tfoot>
                  <tr className={s.sapTotalRow}>
                    <td colSpan={2}>{t('reports.totals')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(subledgerTotal)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(controlTotal)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(difference)}</bdi>
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </div>
      </section>

      {/* ── 2. The investigation ─────────────────────────────────────── */}
      <section aria-labelledby="ap-reconciliation-investigation" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="ap-reconciliation-investigation">
            <span>{x('investigation_title')}</span>
            <span className={s.sapTitleMeta}>{x('exceptions_meta', { count: exceptions.length })}</span>
          </h2>
          <p className={`${s.sapNote} m-0 px-4 py-3 sm:px-5`}>{x('no_repair')}</p>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('reason')}</th>
                  <th scope="col">{x('journal_entry')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{x('account_code')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('line_amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('subledger_amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {exceptions.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('no_exceptions')}
                    </td>
                  </tr>
                ) : null}
                {exceptions.map((row, index) => {
                  const line = net(row.lineDebitIqd, row.lineCreditIqd);
                  const sub = net(row.subledgerDebitIqd, row.subledgerCreditIqd);
                  return (
                    <tr key={`${row.entryNo}-${row.reason}-${index}`}>
                      <td>{x(`reason_${row.reason}`)}</td>
                      <td className={s.sapAccountCell}>
                        <ProfileLink code={row.entryNo} kind="journal" />
                      </td>
                      <td>
                        <bdi dir="ltr">{formatBusinessDate(row.postingDate, locale as Locale)}</bdi>
                      </td>
                      <td>
                        <span className={`status status--${row.journalStatus}`} data-status={row.journalStatus}>
                          {status(row.journalStatus)}
                        </span>
                      </td>
                      <td>
                        <ProfileLink code={row.accountCode} kind="gl_account" />
                      </td>
                      <td>{row.partyCode ? <ProfileLink code={row.partyCode} kind="supplier">{row.partyCode}</ProfileLink> : '—'}</td>
                      <td>
                        <bdi dir="auto">{row.description ?? '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{line === null ? '—' : money(line)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{sub === null ? '—' : money(sub)}</bdi>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── 3. By supplier ───────────────────────────────────────────── */}
      <section aria-labelledby="ap-reconciliation-suppliers" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="ap-reconciliation-suppliers">
            <span>{x('by_supplier_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: reconciled.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('control')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('open_documents')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('open_items.supplier_credits')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('open_items.other_noninvoice_debits')}
                  </th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {reconciled.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {x('no_suppliers')}
                    </td>
                  </tr>
                ) : null}
                {reconciled.map((row) => (
                  <tr key={row.partyCode}>
                    <td>
                      <ProfileLink code={row.partyCode} kind="supplier">
                        {row.partyCode}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.partyCode} dir="auto" kind="supplier">
                        {row.partyName}
                      </ProfileLink>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.ledgerIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.documentsIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.unappliedCreditsIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.otherNonInvoiceDebitIqd)}</bdi>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/supplier-statements?code=${encodeURIComponent(row.partyCode)}`}>
                        {x('open_statement')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              {reconciled.length > 0 ? (
                <tfoot>
                  <tr className={s.sapTotalRow}>
                    <td colSpan={2}>{t('reports.totals')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(tie.ledgerIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(tie.documentsIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(tie.unappliedCreditsIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(tie.otherNonInvoiceDebitsIqd)}</bdi>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
