import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from './index';
import { ReportFilter, ReportWindow, currencyFrom } from './report-filter';
import { SectionTabs } from './section-tabs';
import type { SearchParams } from './params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import { pickOne, pickOutcome } from '@domain/pick';
import { daysBetween } from '@domain/ageing';
import * as partners from '@/server/services/partners';
import * as statement from '@/server/services/partner-statement';

/**
 * The Account Statement — Operations build, blocks 2 and 3.
 *
 * One screen, instantiated twice: under Sales for a customer and under
 * Purchasing for a supplier, because that is where each partner already lives.
 * The two are mirrors, and the sponsor described them as such:
 *
 *   a customer   sales are Debit; receipts and credits are Credit
 *   a supplier   purchases are Credit; payments and credits are Debit
 *
 * so one component takes the side and the direction comes with it. Written
 * twice they would be two screens that drift, and a customer statement that
 * disagreed with a supplier statement about what a balance means.
 *
 * The balance runs in the direction money is owed, which is why either one
 * ends at a positive figure when something is outstanding. A partner who is
 * both is read as a customer here and as a supplier there; netting the two
 * would answer a question nobody asked.
 *
 * Choose the partner, choose the period, press Run. The parameters go in the
 * address bar, so a statement is a place: it can be linked to, sent to a
 * colleague, and re-read at the same figures.
 */
const SIDE = {
  customer: {
    route: '/sales/customer-statements',
    page: 'ar_statements',
    back: '/master-data/customers',
  },
  supplier: {
    route: '/purchasing/supplier-statements',
    page: 'ap_statements',
    back: '/master-data/suppliers',
  },
} as const;

/**
 * Where each document is read.
 *
 * A credit memo has no screen of its own yet, so its number is stated and not
 * linked — an address that refuses is worse than plain text. The line is on the
 * statement either way, because the money moved either way.
 */
const DOCUMENT_ROUTE: Readonly<Record<statement.DocumentKind, string | null>> = {
  ar_invoice: '/sales/ar-invoices',
  customer_receipt: '/sales/customer-receipts',
  customer_credit_memo: null,
  ap_invoice: '/purchasing/ap-invoices',
  supplier_payment: '/purchasing/supplier-payments',
  goods_return: '/purchasing/goods-returns',
};

export async function AccountStatement({
  side,
  searchParams,
}: {
  readonly side: partners.PartnerRole;
  readonly searchParams: SearchParams;
}) {
  const screen = SIDE[side];
  const [t, page, column, locale, context, query] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', partners.PERMISSION_OBJECT)) {
    return <Denied object={page(screen.page)} />;
  }

  const year = new Date().getFullYear();
  const from = typeof query.from === 'string' ? query.from : `${year}-01-01`;
  const to = typeof query.to === 'string' ? query.to : `${year}-12-31`;
  const currency = currencyFrom(query.currency);
  const asked = typeof query.code === 'string' ? query.code : '';

  // The whole role, not only the active part of it: a partner stops trading
  // long before their account stops needing to be read.
  const { roll, chosen, account } = await withCurrentUser(async (tx) => {
    const roll = await partners.listByRole(tx, side);
    /* Resolved from what was typed, not matched against the whole label.
       The box used to carry the partner's code in a hidden field, set only when
       the text matched "CODE · Legal Name" exactly — so typing the name, or the
       code, or picking from the list and then editing it, left nothing to submit
       and the screen said "choose a customer" with no reason given. A code wins
       outright; short of that, anything that can only be one partner names them. */
    const chosen =
      pickOne(roll, asked, (row) => row.code, (row) => [row.code, row.legalName, row.tradeName]) ??
      null;
    return {
      roll,
      chosen,
      account: chosen
        ? await statement.statementFor(tx, side, chosen.code, { from, to, currency })
        : null,
    };
  });

  const outcome = pickOutcome(
    roll,
    asked,
    (row) => row.code,
    (row) => [row.code, row.legalName, row.tradeName],
  );

  /*
   * The day the lines are aged against.
   *
   * The statement's own closing date, so a copy printed for August ages its
   * lines as at August and still says the same thing when it is re-printed in
   * November — a statement in a file has to keep agreeing with itself.
   *
   * But never later than today. A statement run to the end of the year would
   * otherwise declare an invoice due last week "95 days overdue", which is a
   * fact about a future that has not happened.
   */
  const today = new Date().toISOString().slice(0, 10);
  const agedAt = account && account.to > today ? today : (account?.to ?? today);

  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
  const day = (date: string) => formatBusinessDate(date, locale as Locale);

  return (
    <AdminPage
      actions={chosen ? <ExportMenu exportKey={`${side}_statement`} query={query} /> : undefined}
      back={{ href: screen.back, label: t('back') }}
      subtitle={t(`partners.statement_subtitle_${side}`)}
      tabs={<SectionTabs route={screen.route} />}
      title={page(screen.page)}
      variant="sap"
    >
      <ReportWindow
        filter={
          <ReportFilter action={screen.route} currency={currency} from={from} to={to}>
            <label className={s.sapFilterField}>
              <span className={s.sapLabel}>{t(`partners.role_${side}`)}</span>
              <input
                aria-label={t(`partners.role_${side}`)}
                autoComplete="off"
                defaultValue={asked}
                list={`${side}-statement-parties`}
                name="code"
              />
              <datalist id={`${side}-statement-parties`}>
                {roll.map((row) => (
                  <option key={row.code} value={row.code}>
                    {row.legalName}
                  </option>
                ))}
              </datalist>
            </label>
          </ReportFilter>
        }
        // A closing balance is only shown once there is an account to close.
        // Nought against an empty screen reads as "this customer owes nothing",
        // which is a different answer from "no customer was chosen".
        {...(account
          ? {
              foot: (
                <div className={s.sapFootTotals}>
                  <div className={s.sapFootTotal}>
                    <span>{t('partners.statement_closing')}</span>
                    <strong>
                      <bdi dir="ltr">{money(account.closing)}</bdi>
                    </strong>
                  </div>
                </div>
              ),
            }
          : {})}
        meta={t('reports.for_the_period', { from: day(from), to: day(to) })}
        title={chosen ? `${chosen.code} · ${chosen.legalName}` : t('partners.statement')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('partners.statement_date')}</th>
              <th scope="col">{t('partners.statement_document')}</th>
              <th scope="col">{column('due_date')}</th>
              <th scope="col">{t('open_items.ageing')}</th>
              <th scope="col">{t('journals.description')}</th>
              <th className={s.sapNum} scope="col">
                {`${t('partners.statement_debit')} · ${currency}`}
              </th>
              <th className={s.sapNum} scope="col">
                {`${t('partners.statement_credit')} · ${currency}`}
              </th>
              <th className={s.sapNum} scope="col">
                {`${t('partners.statement_balance')} · ${currency}`}
              </th>
            </tr>
          </thead>
          <tbody>
            {account === null ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={8}>
                  {/* Which of the three it is: nothing typed, nothing found, or
                      too much found. "Choose a customer" for a name that was
                      typed and not recognised reads as though the box had been
                      ignored. */}
                  {outcome === 'none'
                    ? t('partners.statement_party_unknown', { side: t(`partners.role_${side}`) })
                    : outcome === 'ambiguous'
                      ? t('partners.statement_party_ambiguous', { side: t(`partners.role_${side}`) })
                      : t(`partners.statement_choose_${side}`)}
                </td>
              </tr>
            ) : (
              <>
                {/* What was outstanding before the first line shown. Everything
                    earlier is folded into it rather than dropped, so a window
                    closes where the whole account does. */}
                <tr>
                  <td colSpan={5}>{t('partners.statement_opening')}</td>
                  <td className={s.sapNum} />
                  <td className={s.sapNum} />
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(account.opening)}</bdi>
                  </td>
                </tr>
                {account.lines.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('partners.statement_empty')}
                    </td>
                  </tr>
                ) : null}
                {account.lines.map((line, index) => {
                  const route = line.document ? DOCUMENT_ROUTE[line.document.kind] : null;
                  return (
                    <tr key={`${line.entryNo}-${index}`}>
                      <td>
                        <bdi dir="ltr">{day(line.postingDate)}</bdi>
                      </td>
                      <td>
                        {line.document === null ? (
                          <Link
                            className={s.sapLink}
                            href={`/finance/journals/${encodeURIComponent(line.entryNo)}`}
                          >
                            <bdi dir="ltr">{line.entryNo}</bdi>
                          </Link>
                        ) : route === null ? (
                          <bdi dir="ltr">{line.document.number}</bdi>
                        ) : (
                          <Link
                            className={s.sapLink}
                            href={`${route}/${encodeURIComponent(line.document.number)}`}
                          >
                            <bdi dir="ltr">{line.document.number}</bdi>
                          </Link>
                        )}
                      </td>
                      <td>
                        <bdi dir="ltr">
                          {line.document?.dueDate ? day(line.document.dueDate) : '—'}
                        </bdi>
                      </td>
                      <td>
                        {/* How old the document is as at the statement's own
                            closing date — not today's. A statement printed for
                            August must age its lines as at August, or a copy
                            re-printed in November would quietly disagree with
                            the one already in the file. */}
                        {line.document?.dueDate ? (
                          (() => {
                            const late = daysBetween(line.document.dueDate, agedAt);
                            return late > 0 ? (
                              <span className={s.sapWarn}>
                                {t('open_items.overdue_by', { days: late })}
                              </span>
                            ) : (
                              <span className="muted">{t('open_items.due_in', { days: -late })}</span>
                            );
                          })()
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <bdi dir="auto">{line.description ?? '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{Number(line.debit) === 0 ? '' : money(line.debit)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{Number(line.credit) === 0 ? '' : money(line.credit)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(line.balance)}</bdi>
                      </td>
                    </tr>
                  );
                })}
                {/* The two totals and what the account stands at — ruled twice,
                    the way a statement ends. */}
                <tr data-rule="double">
                  <td colSpan={5}>{t('partners.statement_closing')}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(account.totalDebit)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(account.totalCredit)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(account.closing)}</bdi>
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
