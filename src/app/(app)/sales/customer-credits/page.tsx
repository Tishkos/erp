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
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as credits from '@/server/services/customer-credits';
import * as openItems from '@/server/services/open-items';
import { applyCredit } from './actions';

/**
 * Customer Credits & Advances — Receivables, 2026-10-04.
 *
 * > "Customer pays 5,000,000 IQD but there is no invoice yet. The system
 * > should show Customer Credit / Advance = 5,000,000 IQD. Do NOT create a
 * > fake invoice. Later, the credit can be allocated against a real invoice."
 *
 * A list screen in the Purchase Invoices' manner, with two further registers
 * stacked under it in the supplier-statement manner:
 *
 *   Credits      every credit a customer holds — a receipt's remainder (an
 *                advance when none of it was applied, an overpayment when
 *                some was), a credit memo's, a credit note's;
 *   By customer  outstanding documents, receipts applied, credits unapplied,
 *                and the net — the three the sponsor asked to keep distinct;
 *   Apply        the chosen credit against the customer's open invoices and
 *                debit notes, one amount box per row, as the receipt does.
 *
 * Every figure is read off the documents that posted to the subledger, so
 * the net here is the statement's balance and the ageing's net position.
 */
export const dynamic = 'force-dynamic';

const KIND_ROUTE: Readonly<Record<credits.CreditRow['kind'], string>> = {
  receipt: '/sales/customer-receipts',
  credit_memo: '/sales/credit-notes',
  credit_note: '/sales/credit-notes',
};

const DEBT_ROUTE: Readonly<Record<credits.OpenDebt['kind'], string>> = {
  invoice: '/sales/ar-invoices',
  debit_note: '/sales/credit-notes',
};

export default async function CustomerCreditsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-credits')) notFound();

  const [t, admin, page, column, status, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.customer_credits'),
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
  if (!can(principal, 'view', 'customer_receipt')) {
    return <Denied object={page('ar_allocations')} />;
  }

  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const customerCode = one('code');
  const show = one('show') === 'all' ? 'all' : 'open';
  const creditNo = one('credit');
  const today = businessToday();

  const data = await withCurrentUser(async (tx, request) => {
    // The branch the reader is working in, as the ageing and the statement
    // read it — so the net here is the net there.
    const branchCode = request.scope.branchCode || null;
    const everyCredit = await credits.register(tx, { openOnly: false, branchCode });
    const customers = new Map(everyCredit.map((row) => [row.customerCode, row.customerName]));
    const chosenCustomer = everyCredit.find((row) => row.customerCode === customerCode) ?? null;
    const rows = everyCredit.filter(
      (row) =>
        (!customerCode || row.customerCode === customerCode) &&
        (show === 'all' || parseDecimal(row.unappliedIqd, MONEY_SCALE) > 0n),
    );
    const chosen = creditNo ? (everyCredit.find((row) => row.documentNo === creditNo) ?? null) : null;
    const debts = chosen ? await credits.openDebtsFor(tx, chosen.customerId) : [];
    const items = can(request.principal, 'view', openItems.PERMISSION_OBJECT.customer)
      ? await openItems.openItems(tx, request.principal, 'customer', today, {
          branchCode,
          ...(chosenCustomer ? { partyCode: chosenCustomer.customerCode } : {}),
        })
      : [];
    const receipts = await credits.receiptTotals(tx, { branchCode });
    return { everyCredit, customers, rows, chosen, debts, items, receipts };
  });

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const dec = (value: string) => parseDecimal(value, MONEY_SCALE);
  const str = (value: bigint) => toDecimalString(value, MONEY_SCALE);
  const shown = data.rows.filter((row) => matches(row as unknown as Record<string, unknown>, outcome.q));

  /** An advance is money nothing was applied to; an overpayment is what is left after something was. */
  const kindLabel = (row: credits.CreditRow) =>
    row.kind === 'receipt'
      ? dec(row.appliedIqd) === 0n
        ? t('kind_advance')
        : t('kind_unapplied_receipt')
      : t(`kind_${row.kind}`);

  // ── By customer: what they owe, what they paid, what they hold ─────────────
  interface Position {
    name: string;
    outstanding: bigint;
    received: bigint;
    applied: bigint;
    unapplied: bigint;
  }
  const positions = new Map<string, Position>();
  const at = (code: string, name: string) => {
    const held = positions.get(code) ?? { name, outstanding: 0n, received: 0n, applied: 0n, unapplied: 0n };
    positions.set(code, held);
    return held;
  };
  for (const item of data.items) {
    const outstanding = dec(item.outstandingIqd);
    if (outstanding > 0n) at(item.partyCode, item.partyName).outstanding += outstanding;
  }
  for (const row of data.everyCredit) {
    if (customerCode && row.customerCode !== customerCode) continue;
    at(row.customerCode, row.customerName).unapplied += dec(row.unappliedIqd);
  }
  const idToCode = new Map(data.everyCredit.map((row) => [row.customerId, row.customerCode]));
  for (const total of data.receipts) {
    const code = idToCode.get(total.customerId);
    const held = code ? positions.get(code) : undefined;
    if (!held) continue;
    held.received += dec(total.receivedIqd);
    held.applied += dec(total.appliedIqd);
  }
  const byCustomer = [...positions].filter(([, row]) => row.outstanding !== 0n || row.unapplied !== 0n);

  const totalUnapplied = shown.reduce((sum, row) => sum + dec(row.unappliedIqd), 0n);

  const chosen = data.chosen;
  const remaining = chosen ? dec(chosen.unappliedIqd) : 0n;
  const mayApply =
    chosen !== null &&
    remaining > 0n &&
    can(principal, 'execute', chosen.kind === 'receipt' ? 'customer_receipt' : 'customer_credit_memo');

  // Oldest due first, as the receipt's own plan does: the boxes add up to the credit.
  let left = remaining;
  const proposal = new Map<string, bigint>();
  for (const debt of data.debts) {
    const owed = dec(debt.outstandingIqd);
    const share = left < owed ? left : owed;
    proposal.set(debt.id, share > 0n ? share : 0n);
    left -= share > 0n ? share : 0n;
  }

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/sales/customer-credits" />}
      title={page('ar_allocations')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="credits-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="credits-list-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/sales/customer-credits"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: shown.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={customerCode}
                emptyLabel={t('all_customers')}
                label={column('customer_name')}
                name="code"
                options={[...data.customers].map(([code, name]) => ({ value: code, label: `${code} · ${name}` }))}
              />
              <Select
                defaultValue={show}
                label={t('show')}
                name="show"
                options={[
                  { value: 'open', label: t('show_open') },
                  { value: 'all', label: t('show_all') },
                ]}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="credits-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{t('kind')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('customer_code')}</th>
                  <th scope="col">{column('customer_name')}</th>
                  <th scope="col">{t('source_invoice')}</th>
                  <th className={s.sapNum} scope="col">{column('amount')}</th>
                  <th className={s.sapNum} scope="col">{t('applied')}</th>
                  <th className={s.sapNum} scope="col">{t('unapplied')}</th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={11}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>
                      <Link className={s.sapLink} href={`${KIND_ROUTE[row.kind]}/${encodeURIComponent(row.documentNo)}`}>
                        <bdi dir="ltr">{row.documentNo}</bdi>
                      </Link>
                    </td>
                    <td>{kindLabel(row)}</td>
                    <td>
                      <bdi dir="ltr">{day(row.documentDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.customerCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.customerName}</bdi>
                    </td>
                    <td>
                      {row.sourceInvoiceNo ? (
                        <Link className={s.sapLink} href={`/sales/ar-invoices/${encodeURIComponent(row.sourceInvoiceNo)}`}>
                          <bdi dir="ltr">{row.sourceInvoiceNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.appliedIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <strong>
                        <bdi dir="ltr">{money(row.unappliedIqd)}</bdi>
                      </strong>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status.has(row.status) ? status(row.status) : row.status}
                      </span>
                    </td>
                    <td>
                      {dec(row.unappliedIqd) > 0n ? (
                        <Link
                          className={s.sapLink}
                          href={`/sales/customer-credits?credit=${encodeURIComponent(row.documentNo)}#apply`}
                        >
                          {t('apply')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {shown.length > 0 ? (
                  <tr className={s.sapTotalRow}>
                    <td colSpan={8}>
                      <strong>{t('total_unapplied')}</strong>
                    </td>
                    <td className={s.sapNum}>
                      <strong>
                        <bdi dir="ltr">{money(str(totalUnapplied))}</bdi>
                      </strong>
                    </td>
                    <td colSpan={2} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {chosen ? (
        <section aria-labelledby="credits-apply-title" className={s.sapDoc} id="apply">
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="credits-apply-title">
              <span>{t('apply_title', { number: chosen.documentNo })}</span>
              <span className={s.sapTitleMeta}>
                {t('apply_meta', { customer: chosen.customerName, amount: money(chosen.unappliedIqd) })}
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="credits-apply-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('reference')}</th>
                    <th scope="col">{t('kind')}</th>
                    <th scope="col">{column('due_date')}</th>
                    <th className={s.sapNum} scope="col">{column('total_price')}</th>
                    <th className={s.sapNum} scope="col">{admin('open_items.outstanding')}</th>
                    {mayApply ? <th scope="col" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.debts.length === 0 || remaining === 0n ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={mayApply ? 6 : 5}>
                        {remaining === 0n ? t('nothing_left') : t('nothing_owed')}
                      </td>
                    </tr>
                  ) : (
                    data.debts.map((debt) => (
                      <tr key={`${debt.kind}-${debt.id}`}>
                        <td className={s.sapAccountCell}>
                          <Link className={s.sapLink} href={`${DEBT_ROUTE[debt.kind]}/${encodeURIComponent(debt.documentNo)}`}>
                            <bdi dir="ltr">{debt.documentNo}</bdi>
                          </Link>
                        </td>
                        <td>{t(`debt_${debt.kind}`)}</td>
                        <td>
                          <bdi dir="ltr">{day(debt.dueDate)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(debt.totalIqd)}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(debt.outstandingIqd)}</bdi>
                        </td>
                        {mayApply ? (
                          <td>
                            <form action={applyCredit} className={s.fieldWithAction}>
                              <input name="credit_no" type="hidden" value={chosen.documentNo} />
                              <input name="source_kind" type="hidden" value={chosen.kind} />
                              <input name="source_id" type="hidden" value={chosen.id} />
                              <input name="target_kind" type="hidden" value={debt.kind} />
                              <input name="target_id" type="hidden" value={debt.id} />
                              <input
                                aria-label={`${t('apply')} ${debt.documentNo}`}
                                className={s.sapCellField}
                                defaultValue={String(Number(str(proposal.get(debt.id) ?? 0n)))}
                                inputMode="decimal"
                                name="amount_iqd"
                              />
                              <Submit label={t('apply')} tone="secondary" variant="document" />
                            </form>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="credits-customers-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="credits-customers-title">
            <span>{t('by_customer')}</span>
            <span className={s.sapTitleMeta}>{admin('statement_outstanding.as_at', { date: day(today) })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="credits-customers-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('customer_name')}</th>
                  <th className={s.sapNum} scope="col">{t('outstanding_documents')}</th>
                  <th className={s.sapNum} scope="col">{t('received')}</th>
                  <th className={s.sapNum} scope="col">{t('applied_receipts')}</th>
                  <th className={s.sapNum} scope="col">{t('unapplied')}</th>
                  <th className={s.sapNum} scope="col">{t('net_position')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {byCustomer.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none_by_customer')}
                    </td>
                  </tr>
                ) : null}
                {byCustomer.map(([code, row]) => (
                  <tr key={code}>
                    <td>
                      <bdi dir="auto">{row.name}</bdi> <span className="muted"><bdi dir="ltr">{code}</bdi></span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(str(row.outstanding))}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(str(row.received))}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(str(row.applied))}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(str(row.unapplied))}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <strong>
                        <bdi dir="ltr">{money(str(row.outstanding - row.unapplied))}</bdi>
                      </strong>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/sales/receivables?code=${encodeURIComponent(code)}`}>
                        {t('open_ageing')}
                      </Link>
                      {' · '}
                      <Link className={s.sapLink} href={`/sales/customer-statements?code=${encodeURIComponent(code)}`}>
                        {t('open_statement')}
                      </Link>
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
