import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ProfileLink } from '@/components/admin/profile-link';
import { ReportWindow } from '@/components/admin/report-filter';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as reconciliation from '@/server/services/customer-reconciliation';
import * as openItems from '@/server/services/open-items';
import { IntentDateField } from '@/components/admin/intent-date-field';

/**
 * Customer Reconciliation — Receivables, 2026-10-04.
 *
 * > "Customer subledger 12,500,000 IQD; AR control account 12,500,000 IQD;
 * > Difference 0 IQD ✅. If there is a difference: Difference 250,000 IQD ⚠️.
 * > Show the investigation path/source transactions. Do not automatically
 * > repair reconciliation differences."
 *
 * A report in the ageing's manner — the report window, the as-at strip, the
 * tie verdict in its existing strip — with two registers stacked under it:
 *
 *   Control accounts   each customer control account, subledger beside G/L;
 *   Investigation      the journal lines that make any difference, each one
 *                      opening its journal entry;
 *   By customer        the subledger beside the open documents, so a
 *                      customer's unapplied credit or non-invoice balance is
 *                      seen as what it is rather than as a discrepancy.
 *
 * It reads and says; it never corrects. A difference is fixed by somebody who
 * has opened the entry and decided.
 */
export const dynamic = 'force-dynamic';

const REASONS = ['no_subledger', 'amount', 'account', 'not_posted'] as const;

export default async function CustomerReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-reconciliation')) notFound();

  const [t, admin, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin.customer_reconciliation'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', reconciliation.PERMISSION_OBJECT)) {
    return <Denied object={page('ar_reconciliation')} />;
  }

  const asked = typeof params.as_at === 'string' ? params.as_at.trim() : '';
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : businessToday();

  const { accounts, exceptions, parties } = await withCurrentUser(async (tx, request) => {
    const branchCode = request.scope.branchCode || null;
    const items = await openItems.openItems(tx, request.principal, 'customer', asOf, { branchCode });
    const balances = await openItems.ledgerBalances(tx, request.principal, 'customer', asOf, { branchCode });
    return {
      accounts: await reconciliation.controlAccounts(tx, request.principal, asOf),
      exceptions: await reconciliation.exceptions(tx, request.principal, asOf),
      parties: openItems.reconcile(items, balances),
    };
  });

  const dec = (value: string | null) => parseDecimal(value ?? '0', MONEY_SCALE);
  const str = (value: bigint) => toDecimalString(value, MONEY_SCALE);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);

  const subledgerTotal = accounts.reduce((sum, row) => sum + dec(row.subledgerIqd), 0n);
  const ledgerTotal = accounts.reduce((sum, row) => sum + dec(row.generalLedgerIqd), 0n);
  const difference = subledgerTotal - ledgerTotal;
  const ties = difference === 0n;
  const byReason = new Map(REASONS.map((reason) => [reason, exceptions.filter((row) => row.reason === reason).length]));

  const filter = (
    <form action="/sales/customer-reconciliation" className={s.sapFilterBar} method="get">
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{admin('reports.as_at_label')}</span>
        <IntentDateField defaultValue={asOf} name="as_at" required />
      </label>
      <button className={`${s.button} ${s.primary}`} type="submit">
        {admin('stock_movements.filter')}
      </button>
    </form>
  );

  const summary = (
    <div className={s.sapFootTotals}>
      {(
        [
          ['subledger_total', str(subledgerTotal)],
          ['control_total', str(ledgerTotal)],
          ['difference', str(difference)],
        ] as const
      ).map(([label, amount]) => (
        <div className={s.sapFootTotal} key={label}>
          <span>{t(label)}</span>
          <strong>
            <bdi dir="ltr">{money(amount)}</bdi>
          </strong>
        </div>
      ))}
    </div>
  );

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/sales/customer-reconciliation" />}
      title={page('ar_reconciliation')}
      variant="sap"
    >
      <ReportWindow
        filter={filter}
        foot={summary}
        meta={admin('statement_outstanding.as_at', { date: day(asOf) })}
        title={t('control_title')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('account_code')}</th>
              <th scope="col">{t('account_name')}</th>
              <th className={s.sapNum} scope="col">{t('subledger')}</th>
              <th className={s.sapNum} scope="col">{t('control')}</th>
              <th className={s.sapNum} scope="col">{t('difference')}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {t('no_control_accounts')}
                </td>
              </tr>
            ) : null}
            {accounts.map((row) => (
              <tr key={row.accountCode}>
                <td className={s.sapAccountCell}>
                  <Link
                    className={s.sapLink}
                    href={`/finance/gl-inquiry/${encodeURIComponent(row.accountCode)}?to=${asOf}`}
                  >
                    <bdi dir="ltr">{row.accountCode}</bdi>
                  </Link>
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
                  {dec(row.differenceIqd) === 0n ? (
                    <bdi dir="ltr">{money(row.differenceIqd)}</bdi>
                  ) : (
                    <strong className={s.sapWarn}>
                      <bdi dir="ltr">{money(row.differenceIqd)}</bdi>
                    </strong>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* The verdict, in the strip the ageing uses for its own tie. */}
        <div className={s.tieStrip} data-ties={ties ? 'yes' : 'no'}>
          <span className={s.tieVerdict}>
            {ties
              ? t('ties', { amount: money(str(subledgerTotal)) })
              : t('does_not_tie', { amount: money(str(difference < 0n ? -difference : difference)) })}
          </span>
        </div>
      </ReportWindow>

      <ReportWindow
        meta={t('exceptions_meta', { count: exceptions.length })}
        title={t('investigation_title')}
      >
        {exceptions.length === 0 ? (
          <p className={`${s.sapEmptyRow} m-0 grid place-items-center px-4`}>{t('no_exceptions')}</p>
        ) : (
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
            <thead>
              <tr>
                <th scope="col">{t('reason')}</th>
                <th scope="col">{column('posting_date')}</th>
                <th scope="col">{t('journal_entry')}</th>
                <th scope="col">{t('account_code')}</th>
                <th scope="col">{column('customer_code')}</th>
                <th scope="col">{column('description')}</th>
                <th className={s.sapNum} scope="col">{t('line_amount')}</th>
                <th className={s.sapNum} scope="col">{t('subledger_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((row, index) => {
                const line = dec(row.lineDebitIqd) - dec(row.lineCreditIqd);
                const ledger =
                  row.subledgerDebitIqd === null ? null : dec(row.subledgerDebitIqd) - dec(row.subledgerCreditIqd);
                return (
                  <tr key={`${row.entryNo}-${index}`}>
                    <td>
                      <span className={s.sapWarn}>{t(`reason_${row.reason}`)}</span>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.postingDate)}</bdi>
                    </td>
                    <td className={s.sapAccountCell}>
                      <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(row.entryNo)}`}>
                        <bdi dir="ltr">{row.entryNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.accountCode}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.partyCode} kind="customer">{row.partyCode ?? '—'}</ProfileLink>
                    </td>
                    <td>
                      <bdi dir="auto">{row.description ?? row.sourceModule ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(str(line))}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{ledger === null ? '—' : money(str(ledger))}</bdi>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {exceptions.length > 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {REASONS.filter((reason) => (byReason.get(reason) ?? 0) > 0)
              .map((reason) => `${t(`reason_${reason}`)}: ${byReason.get(reason)}`)
              .join(' · ')}{' '}
            — {t('no_repair')}
          </p>
        ) : null}
      </ReportWindow>

      <ReportWindow meta={admin('statement_outstanding.as_at', { date: day(asOf) })} title={t('by_customer_title')}>
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{column('customer_name')}</th>
              <th className={s.sapNum} scope="col">{t('subledger')}</th>
              <th className={s.sapNum} scope="col">{t('open_documents')}</th>
              <th className={s.sapNum} scope="col">{admin('open_items.customer_credits')}</th>
              <th className={s.sapNum} scope="col">{admin('open_items.other_noninvoice_debits')}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {parties.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={6}>
                  {t('no_customers')}
                </td>
              </tr>
            ) : null}
            {parties.map((row) => (
              <tr key={row.partyCode}>
                <td>
                  <ProfileLink code={row.partyCode} dir="auto" kind="customer">{row.partyName}</ProfileLink>{' '}
                  <span className="muted"><bdi dir="ltr">{row.partyCode}</bdi></span>
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
                  <Link className={s.sapLink} href={`/sales/customer-statements?code=${encodeURIComponent(row.partyCode)}`}>
                    {t('open_statement')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
