import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportWindow } from './report-filter';
import { ProfileLink } from './profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { requireContext, withCurrentUser } from '@/server/session';
import { pickOne, pickOutcome } from '@domain/pick';
import * as openItems from '@/server/services/open-items';
import * as partners from '@/server/services/partners';
import * as branches from '@/server/services/branches';
import * as rates from '@/server/services/exchange-rates';
import { businessToday } from '@/server/domain/business-date';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { savedViewsFor } from '@/server/saved-views-gate';

/**
 * Receivables Ageing — Receivables, 2026-10-04.
 *
 * > "Who owes us money, how much, and how overdue is it?"
 *
 * The same report as before, read through the same service (`open-items.ts`)
 * that the Payables ageing, the statement, the invoice's own settlement panel
 * and the morning's due notices read — so none of them can disagree about a
 * due date or a balance. What Receivables adds is what the sponsor asked for:
 *
 *   · the five figures at the top — gross receivables, not yet due, overdue,
 *     unapplied customer credits, and the net position — the credits kept
 *     apart rather than netted into a negative invoice;
 *   · filters for the customer, the branch, the as-at date, the currency and
 *     the state (open, part paid, paid, overdue, all);
 *   · debit notes beside invoices, because they are owed and age the same way;
 *   · the way down: the customer's own ageing, their statement, their credits;
 *     each invoice, each receipt and each credit opens its own document.
 *
 * Kept apart from the shared `OpenItemsReport` so the Payables screen is not
 * touched by any of it (2026-10-04, merging with the Payables work).
 */
export async function ReceivablesAgeing({ searchParams }: { readonly searchParams: SearchParams }) {
  const [t, r, page, column, status, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.receivables_ageing'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', openItems.PERMISSION_OBJECT.customer)) {
    return <Denied object={page('ar_open_items')} />;
  }

  const route = '/sales/receivables';
  // The person's saved views of this screen — and, on a bare arrival, their default one.
  const saved = await savedViewsFor('sales.receivables', searchParams);
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(one('as_at')) ? one('as_at') : businessToday();
  const show = openItems.showFrom(one('show') || 'all');
  const asked = one('code');
  const currency = /^[A-Z]{3}$/.test(one('currency')) ? one('currency') : '';
  const branchAsked = one('branch');

  const { roll, chosen, everyItem, balances, branchCode, branchRows, currencies } = await withCurrentUser(
    async (tx, request) => {
      const roll = await partners.listByRole(tx, 'customer');
      const chosen =
        pickOne(roll, asked, (row) => row.code, (row) => [row.code, row.legalName, row.tradeName]) ?? null;
      const unresolved = Boolean(asked) && !chosen;
      const branchCode = openItems.branchFrom(branchAsked, request.principal.branchCodes, request.scope.branchCode);
      const narrow = { branchCode, ...(chosen ? { partyCode: chosen.code } : {}) };
      return {
        roll,
        chosen,
        branchCode,
        branchRows: (await branches.listAll(tx)).filter((row) => request.principal.branchCodes.includes(row.code)),
        currencies: (await rates.currencies(tx)).filter((row) => row.isActive),
        // Every item, whatever the filter shows: the filter chooses what is
        // listed, never what counts toward the tie.
        everyItem: unresolved ? [] : await openItems.openItems(tx, request.principal, 'customer', asOf, narrow),
        balances: unresolved ? [] : await openItems.ledgerBalances(tx, request.principal, 'customer', asOf, narrow),
      };
    },
  );

  const outcome = pickOutcome(roll, asked, (row) => row.code, (row) => [row.code, row.legalName, row.tradeName]);
  const items = openItems.narrowList(everyItem, { show, currency: currency || null });
  const reconciled = openItems.reconcile(everyItem, balances);
  const tie = openItems.reconciliationTotals(reconciled);
  const creditRows = reconciled.filter((row) => parseDecimal(row.unappliedCreditsIqd, MONEY_SCALE) > 0n);
  const debitRows = reconciled.filter((row) => parseDecimal(row.otherNonInvoiceDebitIqd, MONEY_SCALE) > 0n);
  const position = openItems.invoicePositionTotals(everyItem);
  const buckets = openItems.ageing(everyItem);

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const total = (pick: (row: openItems.OpenItem) => string) =>
    toDecimalString(
      items.reduce((sum, row) => sum + parseDecimal(pick(row), MONEY_SCALE), 0n),
      MONEY_SCALE,
    );
  const documentHref = (item: openItems.OpenItem) =>
    `${item.documentKind === 'debit_note' ? '/sales/credit-notes' : '/sales/ar-invoices'}/${encodeURIComponent(item.invoiceNo)}`;
  const narrowedHref = (code: string) => {
    const query = new URLSearchParams({ code, as_at: asOf, show });
    if (branchAsked) query.set('branch', branchAsked);
    if (currency) query.set('currency', currency);
    return `${route}?${query.toString()}`;
  };
  const statusLabel = (value: string) => (status.has(value) ? status(value) : value);

  /** "Due in 6 days", "11 days overdue", "Paid 3 days late" — what a person acts on. */
  const lateness = (item: openItems.OpenItem) => {
    if (parseDecimal(item.outstandingIqd, MONEY_SCALE) <= 0n) {
      return item.daysLateAtLastPayment === null ? (
        <span className="muted">{t('open_items.paid')}</span>
      ) : item.daysLateAtLastPayment > 0 ? (
        <span className="muted">{t('open_items.paid_late', { days: item.daysLateAtLastPayment })}</span>
      ) : (
        <span className="muted">{t('open_items.paid_on_time')}</span>
      );
    }
    if (item.daysOverdue > 0) {
      return <span className={s.sapWarn}>{t('open_items.overdue_by', { days: item.daysOverdue })}</span>;
    }
    return <span>{t('open_items.due_in', { days: item.daysUntilDue })}</span>;
  };

  const reportFilter = (
    <form action={route} className={s.sapFilterBar} method="get">
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{t('partners.role_customer')}</span>
        <input
          autoComplete="off"
          defaultValue={asked}
          list="customer-ageing-parties"
          name="code"
          placeholder={t('open_items.party_placeholder')}
        />
        <datalist id="customer-ageing-parties">
          {roll.map((row) => (
            <option key={row.code} value={row.code}>
              {row.legalName}
            </option>
          ))}
        </datalist>
      </label>
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{column('branch_code')}</span>
        <select defaultValue={branchAsked === '*' ? '*' : (branchCode ?? '*')} name="branch">
          <option value="*">{r('all_branches')}</option>
          {branchRows.map((row) => (
            <option key={row.code} value={row.code}>
              {`${row.code} · ${row.name}`}
            </option>
          ))}
        </select>
      </label>
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{t('reports.as_at_label')}</span>
        <input defaultValue={asOf} name="as_at" required type="date" />
      </label>
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{r('currency')}</span>
        <select defaultValue={currency} name="currency">
          <option value="">{r('all_currencies')}</option>
          {currencies.map((row) => (
            <option key={row.code} value={row.code}>
              {row.code}
            </option>
          ))}
        </select>
      </label>
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{t('open_items.show')}</span>
        <select defaultValue={show} name="show">
          {openItems.SHOW_VALUES.map((value) => (
            <option key={value} value={value}>
              {r(`show_${value}`)}
            </option>
          ))}
        </select>
      </label>
      <button className={`${s.button} ${s.primary}`} type="submit">
        {t('stock_movements.filter')}
      </button>
    </form>
  );

  // The five the sponsor asked for, at the top. Credits stay apart: a
  // customer with a 100,000 invoice and a 5,000,000 advance has a gross
  // receivable of 100,000 and a net position of -4,900,000, never a
  // -4,900,000 invoice.
  const headline: readonly (readonly [string, string])[] = [
    [r('gross'), position.grossIqd],
    [r('not_yet_due'), position.notYetDueIqd],
    [r('overdue'), position.overdueIqd],
    [r('unapplied_credits'), tie.unappliedCreditsIqd],
    [r('net_position'), tie.ledgerIqd],
  ];

  const reportSummary = (
    <div className={s.sapFootTotals}>
      {(
        [
          ['open_items.gross_customer', position.grossIqd],
          ['open_items.not_yet_due', position.notYetDueIqd],
          ['open_items.overdue_total', position.overdueIqd],
          ['open_items.customer_credits', tie.unappliedCreditsIqd],
          ['open_items.other_noninvoice_debits', tie.otherNonInvoiceDebitsIqd],
          ['open_items.net_customer_position', tie.ledgerIqd],
          ['open_items.ledger_position', tie.ledgerIqd],
        ] as readonly (readonly [string, string])[]
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
      actions={
        <>
          <SavedViewsMenu state={saved} />
          <ExportMenu exportKey="receivables" query={params} />
        </>
      }
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('open_items.subtitle_customer')}
      tabs={<SectionTabs route={route} />}
      title={page('ar_open_items')}
      variant="sap"
    >
      <div className={s.statRow}>
        {headline.map(([label, amount]) => (
          <div className={s.stat} key={label}>
            <div>
              <strong>
                <bdi dir="ltr">{money(amount)}</bdi>
              </strong>
              <span>{label}</span>
            </div>
          </div>
        ))}
      </div>

      <ReportWindow
        filter={reportFilter}
        meta={t('statement_outstanding.as_at', { date: day(asOf) })}
        title={t('statement_outstanding.title')}
      >
        {chosen ? (
          // The way down from one customer: their record, their statement,
          // and the credits they hold.
          <p className={s.sapTitleMeta} style={{ padding: '0 1rem' }}>
            <ProfileLink code={chosen.code} dir="auto" kind="customer">{chosen.legalName}</ProfileLink>{' '}
            <span className="muted">
              <bdi dir="ltr">{chosen.code}</bdi>
            </span>
            {' · '}
            <ProfileLink code={chosen.code} dir="auto" kind="customer">{r('customer_record')}</ProfileLink>
            {' · '}
            <Link className={s.sapLink} href={`/sales/customer-statements?code=${encodeURIComponent(chosen.code)}`}>
              {r('statement')}
            </Link>
            {' · '}
            <Link className={s.sapLink} href={`/sales/customer-credits?code=${encodeURIComponent(chosen.code)}`}>
              {r('credits')}
            </Link>
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {outcome === 'none'
              ? t('partners.statement_party_unknown', { side: t('partners.role_customer') })
              : outcome === 'ambiguous'
                ? t('partners.statement_party_ambiguous', { side: t('partners.role_customer') })
                : t('open_items.nothing')}
          </p>
        ) : (
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
            <thead>
              <tr>
                <th scope="col">{column('customer_name')}</th>
                <th scope="col">{column('invoice_no')}</th>
                <th scope="col">{column('invoice_date')}</th>
                <th scope="col">{column('due_date')}</th>
                <th scope="col">{t('open_items.terms')}</th>
                <th className={s.sapNum} scope="col">{column('total_price')}</th>
                <th className={s.sapNum} scope="col">{t('open_items.allocated_payments')}</th>
                <th className={s.sapNum} scope="col">{t('open_items.credits_applied')}</th>
                <th className={s.sapNum} scope="col">{t('open_items.other_adjustments_applied')}</th>
                <th className={s.sapNum} scope="col">{t('open_items.outstanding')}</th>
                <th scope="col">{column('status')}</th>
                <th scope="col">{t('open_items.lateness')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.invoiceId}>
                  <td>
                    {/* The name narrows the ageing to this customer; the code opens their profile. */}
                    <Link className={s.sapLink} href={narrowedHref(item.partyCode)}>
                      <bdi dir="auto">{item.partyName}</bdi>
                    </Link>{' '}
                    <span className="muted">
                      <ProfileLink code={item.partyCode} kind="customer">{item.partyCode}</ProfileLink>
                    </span>
                  </td>
                  <td className={s.sapAccountCell}>
                    <Link className={s.sapLink} href={documentHref(item)}>
                      <bdi dir="ltr">{item.invoiceNo}</bdi>
                    </Link>
                    {item.documentKind === 'debit_note' ? <div className="muted">{r('debit_note')}</div> : null}
                    {item.payments.map((payment, index) => (
                      <div className="muted" key={`p-${payment.documentNo}-${index}`}>
                        <bdi dir="ltr">
                          {day(payment.paidOn)} · {money(payment.amountIqd)}
                          {payment.documentNo ? ' · ' : ''}
                        </bdi>
                        {payment.documentNo ? (
                          <Link
                            className={s.sapLink}
                            href={`/sales/customer-receipts/${encodeURIComponent(payment.documentNo)}`}
                          >
                            <bdi dir="ltr">{payment.documentNo}</bdi>
                          </Link>
                        ) : null}
                      </div>
                    ))}
                    {item.credits.map((credit, index) => (
                      <div className="muted" key={`c-${credit.documentNo}-${index}`}>
                        <bdi dir="ltr">
                          {day(credit.appliedOn)} · {money(credit.amountIqd)} ·{' '}
                        </bdi>
                        <Link className={s.sapLink} href={`/sales/credit-notes/${encodeURIComponent(credit.documentNo)}`}>
                          <bdi dir="ltr">{credit.documentNo}</bdi>
                        </Link>
                      </div>
                    ))}
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
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(item.totalIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(item.paidIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(item.creditsAppliedIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(item.otherAppliedIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <strong>
                      <bdi dir="ltr">{money(item.outstandingIqd)}</bdi>
                    </strong>
                  </td>
                  <td>
                    <span className={`status status--${item.status}`} data-status={item.status}>
                      {statusLabel(item.status)}
                    </span>
                  </td>
                  <td>{lateness(item)}</td>
                </tr>
              ))}
              <tr className={s.sapTotalRow} data-rule="double">
                <td colSpan={5}>
                  <strong>{t('open_items.invoice_balances')}</strong>
                </td>
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(total((row) => row.totalIqd))}</bdi>
                  </strong>
                </td>
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(total((row) => row.paidIqd))}</bdi>
                  </strong>
                </td>
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(total((row) => row.creditsAppliedIqd))}</bdi>
                  </strong>
                </td>
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(total((row) => row.otherAppliedIqd))}</bdi>
                  </strong>
                </td>
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(total((row) => row.outstandingIqd))}</bdi>
                  </strong>
                </td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </ReportWindow>

      {creditRows.length > 0 ? (
        <ReportWindow
          meta={t('statement_outstanding.as_at', { date: day(asOf) })}
          title={t('open_items.credit_advance_title')}
        >
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
            <thead>
              <tr>
                <th scope="col">{column('customer_name')}</th>
                <th scope="col">{t('open_items.on_account_since')}</th>
                <th className={s.sapNum} scope="col">{t('open_items.credit_advance_balance')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {creditRows.map((row) => (
                <tr key={`credit-${row.partyCode}`}>
                  <td>
                    <Link className={s.sapLink} href={narrowedHref(row.partyCode)}>
                      <bdi dir="auto">{row.partyName}</bdi>
                    </Link>{' '}
                    <span className="muted">
                      <bdi dir="ltr">{row.partyCode}</bdi>
                    </span>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.oldestDate ? day(row.oldestDate) : '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <strong>
                      <bdi dir="ltr">{money(row.unappliedCreditsIqd)}</bdi>
                    </strong>
                  </td>
                  <td>
                    <Link className={s.sapLink} href={`/sales/customer-credits?code=${encodeURIComponent(row.partyCode)}`}>
                      {r('credits')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReportWindow>
      ) : null}

      {debitRows.length > 0 ? (
        <ReportWindow
          meta={t('statement_outstanding.as_at', { date: day(asOf) })}
          title={t('open_items.noninvoice_debit_title')}
        >
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
            <thead>
              <tr>
                <th scope="col">{column('customer_name')}</th>
                <th scope="col">{t('open_items.on_account_since')}</th>
                <th className={s.sapNum} scope="col">{t('open_items.noninvoice_debit_balance')}</th>
              </tr>
            </thead>
            <tbody>
              {debitRows.map((row) => (
                <tr key={`debit-${row.partyCode}`}>
                  <td>
                    <Link className={s.sapLink} href={`/sales/customer-statements?code=${encodeURIComponent(row.partyCode)}`}>
                      <bdi dir="auto">{row.partyName}</bdi>
                    </Link>{' '}
                    <span className="muted">
                      <bdi dir="ltr">{row.partyCode}</bdi>
                    </span>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.oldestDate ? day(row.oldestDate) : '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <strong>
                      <bdi dir="ltr">{money(row.otherNonInvoiceDebitIqd)}</bdi>
                    </strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReportWindow>
      ) : null}

      <ReportWindow
        foot={reportSummary}
        meta={t('statement_outstanding.as_at', { date: day(asOf) })}
        title={t('open_items.reconciliation_title_customer')}
      >
        {buckets.length > 0 ? (
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
            <thead>
              <tr>
                <th scope="col">{t('open_items.ageing')}</th>
                {buckets.map((bucket) => (
                  <th className={s.sapNum} key={bucket.bucket} scope="col">
                    {t(`dashboard.${BUCKET_KEY[bucket.bucket]}`)}
                  </th>
                ))}
                <th className={s.sapNum} scope="col">{t('reports.totals')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>{t('open_items.invoice_balances')}</strong>
                </td>
                {buckets.map((bucket) => (
                  <td className={s.sapNum} key={bucket.bucket}>
                    <bdi dir="ltr">{money(bucket.amountIqd)}</bdi> <span className="muted">({bucket.invoices})</span>
                  </td>
                ))}
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(position.grossIqd)}</bdi>
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
        ) : null}
        <div className={s.tieStrip} data-ties={tie.ties ? 'yes' : 'no'}>
          <span className={s.tieVerdict}>
            {tie.ties ? t('reconciliation.ties') : t('reconciliation.explained')}
          </span>
        </div>
      </ReportWindow>
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
