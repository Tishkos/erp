import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from './index';
import { ReportFilter, ReportWindow, currencyFrom } from './report-filter';
import { SearchablePicker } from './searchable-picker';
import { SectionTabs } from './section-tabs';
import type { SearchParams } from './params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
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
  const [t, page, locale, context, query] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
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
    const chosen = roll.find((row) => row.code === asked) ?? null;
    return {
      roll,
      chosen,
      account: chosen
        ? await statement.statementFor(tx, side, chosen.code, { from, to, currency })
        : null,
    };
  });

  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
  const day = (date: string) => formatBusinessDate(date, locale as Locale);

  return (
    <AdminPage
      actions={
        // A statement exists once a partner is chosen; before that there is
        // nothing to print.
        chosen ? (
          <ExportMenu exportKey={`${side}_statement`} query={query} />
        ) : undefined
      }
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
              <SearchablePicker
                bare
                label={t(`partners.role_${side}`)}
                name="code"
                options={roll.map((row) => ({
                  value: row.code,
                  label: `${row.code} · ${row.legalName}`,
                }))}
                {...(chosen ? { defaultValue: chosen.code } : {})}
              />
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
        <StatementLines
          account={account}
          choose={t(`partners.statement_choose_${side}`)}
          currency={currency}
        />
      </ReportWindow>
    </AdminPage>
  );
}

/**
 * The statement's lines — opening balance, each posting with the balance it
 * left, and the closing balance ruled twice. Shared by the customer and
 * supplier statements and by a bank or cash account's own record, which are
 * one report read three ways (blocks 2, 3 and 6).
 */
export async function StatementLines({
  account,
  currency,
  choose,
}: {
  readonly account: statement.PartnerStatement | null;
  readonly currency: 'IQD' | 'USD';
  /** What to say before a party is chosen. */
  readonly choose: string;
}) {
  const [t, locale] = await Promise.all([getTranslations('admin'), getLocale()]);
  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
  const day = (date: string) => formatBusinessDate(date, locale as Locale);
  return (
    <table className={`${s.sapTable} ${s.sapReportTable}`}>
      <thead>
        <tr>
          <th scope="col">{t('partners.statement_date')}</th>
          <th scope="col">{t('partners.statement_document')}</th>
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
            <td className={s.sapEmptyRow} colSpan={6}>
              {choose}
            </td>
          </tr>
        ) : (
          <>
            {/* What was outstanding before the first line shown. Everything
                earlier is folded into it rather than dropped, so a window
                closes where the whole account does. */}
            <tr>
              <td colSpan={3}>{t('partners.statement_opening')}</td>
              <td className={s.sapNum} />
              <td className={s.sapNum} />
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(account.opening)}</bdi>
              </td>
            </tr>
            {account.lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={6}>
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
              <td colSpan={3}>{t('partners.statement_closing')}</td>
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
  );
}
