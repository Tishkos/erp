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
import { pickOne, pickOutcome } from '@domain/pick';
import * as openItems from '@/server/services/open-items';
import * as partners from '@/server/services/partners';

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

  const { roll, chosen, items, balances } = await withCurrentUser(async (tx, request) => {
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
  const reconciled = openItems.reconcile(items, balances, asOf);
  const tie = openItems.reconciliationTotals(reconciled);
  const unexplained = reconciled.filter((row) => Number(row.unexplainedIqd) !== 0);
  const buckets = openItems.ageingWith(items, reconciled);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const total = (pick: (row: openItems.OpenItem) => string) =>
    String(items.reduce((sum, row) => sum + Number(pick(row)), 0));

  const partyColumn = side === 'customer' ? column('customer_name') : column('supplier_name');
  // Where the entries behind an unexplained balance can actually be read: the
  // statement lists them line by line, which this report deliberately does not.
  const statementRoute =
    side === 'customer' ? '/sales/customer-statements' : '/purchasing/supplier-statements';

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
            {/* The partner first: it is what the reader came to narrow, and a
                date box ahead of it asks them to confirm today's date before
                they may ask their question. Four hundred customers is not a
                drop-down anybody reads, so it is typed. Empty means everybody. */}
            <Field
              defaultValue={asked}
              label={t(`partners.role_${side}`)}
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
            <Field defaultValue={asOf} label={t('reports.as_at_label')} name="as_at" type="date" />
            <Select
              defaultValue={show}
              label={t('open_items.show')}
              name="show"
              // The default first, so the list reads in the order somebody
              // narrows: everything, then what is owed, then what is late.
              options={[
                { value: 'all', label: t('open_items.show_all') },
                { value: 'open', label: t('open_items.show_open') },
                { value: 'overdue', label: t('open_items.show_overdue') },
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
                      <bdi dir="ltr">{money(tie.ledgerIqd)}</bdi>
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        {/* ── What no invoice accounts for ──────────────────────────────
            Listed rather than netted away, because it is the part a reader
            cannot find from the invoices: an opening balance journalled in, a
            write-off, or a payment that never reached the control account.
            Without it the total below would not be the statement's. */}
        {unexplained.length > 0 ? (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{partyColumn}</th>
                  <th scope="col">{t('reconciliation.source')}</th>
                  <th scope="col">{t('reconciliation.since')}</th>
                  <th scope="col">{t('open_items.ageing')}</th>
                  <th scope="col">{t('open_items.outstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {unexplained.map((row) => (
                  <tr key={row.partyCode}>
                    <td>
                      <bdi dir="auto">{row.partyName}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.partyCode}</bdi>
                      </span>
                    </td>
                    <td>
                      <Link href={`${statementRoute}?code=${encodeURIComponent(row.partyCode)}`}>
                        {t('reconciliation.by_journal')}
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.oldestDate ? day(row.oldestDate) : '—'}</bdi>
                    </td>
                    <td>{t(`dashboard.${BUCKET_KEY[row.bucket]}`)}</td>
                    <td>
                      <strong>
                        <bdi dir="ltr">{money(row.unexplainedIqd)}</bdi>
                      </strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* ── Does it tie? ──────────────────────────────────────────────
            Stated on the report rather than left for somebody to work out
            with a calculator, because the one thing an ageing must never do
            is disagree with the statement silently. */}
        <div className={s.tieStrip} data-ties={tie.ties ? 'yes' : 'no'}>
          <span>
            {t('reconciliation.ledger')}{' '}
            <strong>
              <bdi dir="ltr">{money(tie.ledgerIqd)}</bdi>
            </strong>
          </span>
          <span>
            {t('reconciliation.invoices')}{' '}
            <strong>
              <bdi dir="ltr">{money(tie.documentsIqd)}</bdi>
            </strong>
          </span>
          <span>
            {t('reconciliation.journals')}{' '}
            <strong>
              <bdi dir="ltr">{money(tie.unexplainedIqd)}</bdi>
            </strong>
          </span>
          <span className={s.tieVerdict}>
            {tie.ties ? t('reconciliation.ties') : t('reconciliation.explained')}
          </span>
        </div>

        {items.length === 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {/* Which of the three it is: nothing matched the filters, or the
                name typed names nobody, or it names more than one. A report
                that answered "nothing outstanding" to a misspelt customer
                would be read as good news. */}
            {outcome === 'none'
              ? t('partners.statement_party_unknown', { side: t(`partners.role_${side}`) })
              : outcome === 'ambiguous'
                ? t('partners.statement_party_ambiguous', { side: t(`partners.role_${side}`) })
                : t('open_items.nothing')}
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
                {/* What these rows come to — named as the invoices' subtotal
                    rather than "Totals", because it is not the total of the
                    report. Read on its own beside a ledger balance of 700,000
                    an unlabelled "0" reads as a contradiction. */}
                <tr>
                  <td colSpan={5}>
                    <strong>{t('reconciliation.invoices')}</strong>
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
                {/* …and then the figure somebody actually came for, which is
                    the statement's closing balance and the sum of everything
                    this report has shown. */}
                {Number(tie.unexplainedIqd) !== 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <strong>{t('reconciliation.journals')}</strong>
                    </td>
                    <td colSpan={2} />
                    <td>
                      <strong>
                        <bdi dir="ltr">{money(tie.unexplainedIqd)}</bdi>
                      </strong>
                    </td>
                    <td colSpan={2} />
                  </tr>
                ) : null}
                <tr>
                  <td colSpan={5}>
                    <strong>{t('reconciliation.owed_total')}</strong>
                  </td>
                  <td colSpan={2} />
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(tie.ledgerIqd)}</bdi>
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
