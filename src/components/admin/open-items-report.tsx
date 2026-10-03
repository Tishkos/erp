import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportWindow } from './report-filter';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import { pickOne, pickOutcome } from '@domain/pick';
import * as openItems from '@/server/services/open-items';
import * as partners from '@/server/services/partners';
import { businessToday } from '@/server/domain/business-date';

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
  const asOf = one('as_at') || businessToday();
  /*
   * Everything by default, paid invoices included.
   *
   * An ageing that opens showing only what is still owed cannot answer "how
   * does this account actually behave" — a customer who always pays eleven
   * days late never stays on an outstanding-only list long enough to notice.
   * Narrowing to what is owed is one click; the fuller picture being one
   * click away was the wrong way round.
   */
  const show = one('show') === 'open' || one('show') === 'overdue' ? one('show') : 'all';
  const asked = one('code');

  const { roll, chosen, items, everyItem, balances } = await withCurrentUser(async (tx, request) => {
    /*
     * The whole role, not only the active part of it — an account is read
     * long after the partner stops trading, and an ageing that hid a dormant
     * customer's unpaid invoices would hide exactly the ones worth chasing.
     */
    const roll = await partners.listByRole(tx, side);

    /*
     * Resolved from what was typed rather than matched against a whole label.
     * A code wins outright; short of that, a phrase that can only be one
     * partner names them, and anything still ambiguous narrows to nobody and
     * says so. The same rule the statement screens use, so typing a name in
     * one place and the other behaves identically.
     */
    const chosen =
      pickOne(roll, asked, (row) => row.code, (row) => [row.code, row.legalName, row.tradeName]) ??
      null;

    /*
     * A name that was typed and names nobody narrows to nothing, rather than
     * falling back to everybody. Reporting the whole ledger under a misspelt
     * customer's name is how somebody reads another account's ageing as
     * theirs — and the figure would look plausible.
     */
    const unresolved = Boolean(asked) && !chosen;

    const narrow = {
      branchCode: request.scope.branchCode,
      ...(chosen ? { partyCode: chosen.code } : {}),
    };

    return {
      roll,
      chosen,
      items: unresolved
        ? []
        : await openItems.openItems(tx, request.principal, side, asOf, {
            ...narrow,
            outstandingOnly: show !== 'all',
            overdueOnly: show === 'overdue',
          }),
      /*
       * Every invoice, whatever the filter shows.
       *
       * `show` decides which rows are listed; it must not decide which
       * invoices count as accounted for. Reconciling against the filtered set
       * would attribute a hidden invoice's charge to the journals, and
       * narrowing to "overdue only" would make the report stop tying.
       */
      everyItem: unresolved
        ? []
        : await openItems.openItems(tx, request.principal, side, asOf, narrow),
      /*
       * What the control account says, read through the same table the Account
       * Statement reads. The two reports are only one report if this figure
       * and the invoices are shown together — otherwise the ageing is a
       * description of the document layer wearing the ledger's authority.
       */
      balances: unresolved
        ? []
        : await openItems.ledgerBalances(tx, request.principal, side, asOf, narrow),
    };
  });

  /*
   * Whether what was typed named anybody.
   *
   * Without this a name that matches nothing silently reports the whole
   * ledger, and a reader takes somebody else's ageing for their customer's.
   */
  const outcome = pickOutcome(
    roll,
    asked,
    (row) => row.code,
    (row) => [row.code, row.legalName, row.tradeName],
  );

  /*
   * The two figures side by side. `show` narrows which invoices are listed but
   * never which ledger entries count, so the reconciliation is always against
   * the whole account — an ageing filtered to "overdue only" that also
   * quietly dropped part of the ledger would tie to nothing.
   */
  const reconciled = openItems.reconcile(everyItem, balances);
  const tie = openItems.reconciliationTotals(reconciled);
  const creditRows = reconciled.filter((row) => Number(row.unappliedCreditsIqd) > 0);
  const nonInvoiceDebitRows = reconciled.filter((row) => Number(row.otherNonInvoiceDebitIqd) > 0);
  const position = openItems.invoicePositionTotals(everyItem);
  const buckets = openItems.ageing(everyItem);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const total = (pick: (row: openItems.OpenItem) => string) =>
    String(items.reduce((sum, row) => sum + Number(pick(row)), 0));

  const partyColumn = side === 'customer' ? column('customer_name') : column('supplier_name');
  // A non-invoice balance links to the statement where its ledger entries can
  // be read. These balances have no invoice due date and are never aged.
  const statementRoute =
    side === 'customer' ? '/sales/customer-statements' : '/payables/supplier-statements';

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

  const reportFilter = (
    <form action={route} className={s.sapFilterBar} method="get">
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{t(`partners.role_${side}`)}</span>
        <input
          autoComplete="off"
          defaultValue={asked}
          list={`${side}-ageing-parties`}
          name="code"
          placeholder={t('open_items.party_placeholder')}
        />
        <datalist id={`${side}-ageing-parties`}>
          {roll.map((row) => (
            <option key={row.code} value={row.code}>
              {row.legalName}
            </option>
          ))}
        </datalist>
      </label>
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{t('reports.as_at_label')}</span>
        <input defaultValue={asOf} name="as_at" required type="date" />
      </label>
      <label className={s.sapFilterField}>
        <span className={s.sapLabel}>{t('open_items.show')}</span>
        <select defaultValue={show} name="show">
          <option value="all">{t('open_items.show_all')}</option>
          <option value="open">{t('open_items.show_open')}</option>
          <option value="overdue">{t('open_items.show_overdue')}</option>
        </select>
      </label>
      <button className={`${s.button} ${s.primary}`} type="submit">
        {t('stock_movements.filter')}
      </button>
    </form>
  );

  const reportSummary = (
    <div className={s.sapFootTotals}>
      {([
        [side === 'customer' ? 'open_items.gross_customer' : 'open_items.gross_supplier', position.grossIqd],
        ['open_items.not_yet_due', position.notYetDueIqd],
        ['open_items.overdue_total', position.overdueIqd],
        [side === 'customer' ? 'open_items.customer_credits' : 'open_items.supplier_credits', tie.unappliedCreditsIqd],
        ['open_items.other_noninvoice_debits', tie.otherNonInvoiceDebitsIqd],
        [side === 'customer' ? 'open_items.net_customer_position' : 'open_items.net_supplier_position', tie.ledgerIqd],
        ['open_items.ledger_position', tie.ledgerIqd],
      ] as readonly (readonly [string, string])[]).map(([label, amount]) => (
        <div className={s.sapFootTotal} key={label}>
          <span>{t(label)}</span>
          <strong><bdi dir="ltr">{money(amount)}</bdi></strong>
        </div>
      ))}
    </div>
  );

  return (
    <AdminPage
      actions={<ExportMenu exportKey={exportKey} query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t(`open_items.subtitle_${side}`)}
      tabs={<SectionTabs route={route} />}
      title={page(titleKey)}
      variant="sap"
    >


      <ReportWindow
        meta={t('statement_outstanding.as_at', { date: day(asOf) })}
        title={t('statement_outstanding.title')}
        filter={reportFilter}
      >
        {items.length === 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {outcome === 'none'
              ? t('partners.statement_party_unknown', { side: t(`partners.role_${side}`) })
              : outcome === 'ambiguous'
                ? t('partners.statement_party_ambiguous', { side: t(`partners.role_${side}`) })
                : t('open_items.nothing')}
          </p>
        ) : (
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
              <thead>
                <tr>
                  <th scope="col">{partyColumn}</th>
                  <th scope="col">{column('invoice_no')}</th>
                  <th scope="col">{column('invoice_date')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th scope="col">{t('open_items.terms')}</th>
                  <th className={s.sapNum} scope="col">{column('total_price')}</th>
                  <th className={s.sapNum} scope="col">{side === 'customer' ? t('open_items.allocated_payments') : t('open_items.paid')}</th>
                  {side === 'customer' ? (
                    <>
                      <th className={s.sapNum} scope="col">{t('open_items.credits_applied')}</th>
                      <th className={s.sapNum} scope="col">{t('open_items.other_adjustments_applied')}</th>
                    </>
                  ) : null}
                  <th className={s.sapNum} scope="col">{t('open_items.outstanding')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{t('open_items.lateness')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.invoiceId}>
                    <td>
                      <bdi dir="auto">{item.partyName}</bdi>{' '}
                      <span className="muted"><bdi dir="ltr">{item.partyCode}</bdi></span>
                    </td>
                    <td className={s.sapAccountCell}>
                      <Link href={invoiceHref(item.invoiceNo)}><bdi dir="ltr">{item.invoiceNo}</bdi></Link>
                      {item.payments.length > 0 ? (
                        <div className="muted" style={{ fontSize: '0.68rem' }}>
                          {item.payments.map((payment, index) => (
                            <div key={`${payment.documentNo}-${index}`}>
                              <bdi dir="ltr">
                                {day(payment.paidOn)} ? {money(payment.amountIqd)}
                                {payment.documentNo ? ` ? ${payment.documentNo}` : ''}
                              </bdi>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td><bdi dir="ltr">{day(item.invoiceDate)}</bdi></td>
                    <td><bdi dir="ltr">{day(item.dueDate)}</bdi></td>
                    <td><bdi dir="auto">{item.paymentTermsName ?? item.paymentTermsCode ?? '?'}</bdi></td>
                    <td className={s.sapNum}><bdi dir="ltr">{money(item.totalIqd)}</bdi></td>
                    <td className={s.sapNum}><bdi dir="ltr">{money(item.paidIqd)}</bdi></td>
                    {side === 'customer' ? (
                      <>
                        <td className={s.sapNum}><bdi dir="ltr">{money(item.creditsAppliedIqd)}</bdi></td>
                        <td className={s.sapNum}><bdi dir="ltr">{money(item.otherAppliedIqd)}</bdi></td>
                      </>
                    ) : null}
                    <td className={s.sapNum}><strong><bdi dir="ltr">{money(item.outstandingIqd)}</bdi></strong></td>
                    <td>
                      <span className={`status status--${item.status}`} data-status={item.status}>
                        {item.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td>{lateness(item)}</td>
                  </tr>
                ))}
                <tr className={s.sapTotalRow} data-rule="double">
                  <td colSpan={5}><strong>{t('open_items.invoice_balances')}</strong></td>
                  <td className={s.sapNum}><strong><bdi dir="ltr">{money(total((row) => row.totalIqd))}</bdi></strong></td>
                  <td className={s.sapNum}><strong><bdi dir="ltr">{money(total((row) => row.paidIqd))}</bdi></strong></td>
                  {side === 'customer' ? (
                    <>
                      <td className={s.sapNum}><strong><bdi dir="ltr">{money(total((row) => row.creditsAppliedIqd))}</bdi></strong></td>
                      <td className={s.sapNum}><strong><bdi dir="ltr">{money(total((row) => row.otherAppliedIqd))}</bdi></strong></td>
                    </>
                  ) : null}
                  <td className={s.sapNum}><strong><bdi dir="ltr">{money(total((row) => row.outstandingIqd))}</bdi></strong></td>
                  <td colSpan={2} />
                </tr>
              </tbody>
          </table>
        )}
      </ReportWindow>

        {creditRows.length > 0 ? (
          <ReportWindow
            meta={t('statement_outstanding.as_at', { date: day(asOf) })}
            title={t(side === 'customer' ? 'open_items.credit_advance_title' : 'open_items.supplier_credit_advance_title')}
          >
              <table className={`${s.sapTable} ${s.sapReportTable}`}>
                <thead><tr>
                  <th scope="col">{partyColumn}</th>
                  <th scope="col">{t('open_items.on_account_since')}</th>
                  <th scope="col">{t('open_items.credit_advance_balance')}</th>
                </tr></thead>
                <tbody>
                  {creditRows.map((row) => (
                    <tr key={`credit-${row.partyCode}`}>
                      <td>
                        <Link href={`${statementRoute}?code=${encodeURIComponent(row.partyCode)}`}>
                          <bdi dir="auto">{row.partyName}</bdi>
                        </Link>{' '}<span className="muted"><bdi dir="ltr">{row.partyCode}</bdi></span>
                      </td>
                      <td><bdi dir="ltr">{row.oldestDate ? day(row.oldestDate) : '?'}</bdi></td>
                      <td className={s.sapNum}><strong><bdi dir="ltr">{money(row.unappliedCreditsIqd)}</bdi></strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </ReportWindow>
        ) : null}

        {nonInvoiceDebitRows.length > 0 ? (
          <ReportWindow
            meta={t('statement_outstanding.as_at', { date: day(asOf) })}
            title={t('open_items.noninvoice_debit_title')}
          >
              <table className={`${s.sapTable} ${s.sapReportTable}`}>
                <thead><tr>
                  <th scope="col">{partyColumn}</th>
                  <th scope="col">{t('open_items.on_account_since')}</th>
                  <th scope="col">{t('open_items.noninvoice_debit_balance')}</th>
                </tr></thead>
                <tbody>
                  {nonInvoiceDebitRows.map((row) => (
                    <tr key={`debit-${row.partyCode}`}>
                      <td>
                        <Link href={`${statementRoute}?code=${encodeURIComponent(row.partyCode)}`}>
                          <bdi dir="auto">{row.partyName}</bdi>
                        </Link>{' '}<span className="muted"><bdi dir="ltr">{row.partyCode}</bdi></span>
                      </td>
                      <td><bdi dir="ltr">{row.oldestDate ? day(row.oldestDate) : '?'}</bdi></td>
                      <td className={s.sapNum}><strong><bdi dir="ltr">{money(row.otherNonInvoiceDebitIqd)}</bdi></strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </ReportWindow>
        ) : null}
      <ReportWindow
        foot={reportSummary}
        meta={t('statement_outstanding.as_at', { date: day(asOf) })}
        title={t(side === 'customer'
          ? 'open_items.reconciliation_title_customer'
          : 'open_items.reconciliation_title_supplier')}
      >

        {/* Buckets are calculated from invoice balances only. */}
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
                      <bdi dir="ltr">{money(bucket.amountIqd)}</bdi>{' '}
                      <span className="muted">({bucket.invoices})</span>
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

        {/* ── Does it tie? ──────────────────────────────────────────────
            Stated on the report rather than left for somebody to work out
            with a calculator, because the one thing an ageing must never do
            is disagree with the statement silently. */}
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
