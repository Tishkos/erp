import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  Calculator,
  Download,
  Inbox,
  Info,
  Landmark,
  Printer,
  ReceiptText,
  Scale,
  ScrollText,
  TrendingUp,
  WalletCards,
  type LucideIcon,
} from 'lucide-react';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { cn } from '@/components/intent/cn';
import { TONE_CHIP, toneBadge, toneOf } from '@/components/chart-of-accounts-tones';
import { visibleRoute } from '@/server/delivered';
import { RecordPage } from '@/components/record-page';
import { registerAllRecords } from '@/server/records';
import { RecordNotFoundError, view } from '@/server/services/record';
import { PermissionDeniedError, can } from '@domain/permissions';
import { withCurrentUser } from '@/server/session';
import {
  AccountControls,
  ControlAccountDesignation,
  MAPPING_STATEMENTS,
} from '@/components/admin/account-controls';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import type { AccountType } from '@domain/accounts';
import * as coa from '@/server/services/chart-of-accounts';
import * as trialBalance from '@/server/services/trial-balance';
import * as statementLines from '@/server/services/statement-lines';

/**
 * One account — its details, its balance and the journals posted to it, on
 * the account itself (by direction, 2026-08-29: the chart is only the tree;
 * everything about an account is shown when the account is opened).
 *
 * Left: who it is (the hero card), its facts, the print and export of the
 * account, and its controls. Right: the most recent journals posted to it,
 * then the balance summary they add up to — the opening balance at the start
 * of the year, the year's debits and credits, and the closing balance, all
 * read from the posted journal lines — and the record's approvals and audit
 * timeline.
 */
export const dynamic = 'force-dynamic';

const ICONS: Readonly<Record<AccountType, LucideIcon>> = {
  asset: Landmark,
  liability: Scale,
  equity: WalletCards,
  revenue: TrendingUp,
  expense: ReceiptText,
};

/** The most recent postings shown on the account itself. */
const RECENT = 8;

/*
 * The account's cards, in Intent UI's terms (the redesign, 2026-10-06): a
 * rounded card on the overlay with a hairline under its title, a table that
 * runs to the card's edges, an outline button for print and export. They are
 * Tailwind utilities rather than the old `.coa-*` rules because the window's
 * own section and header rules (`.sapDoc section`) are stronger than a plain
 * class, and utilities sit in the layer above every hand-written rule.
 */
const CARD = 'min-w-0 overflow-hidden rounded-xl border border-border bg-overlay p-0 text-overlay-fg shadow-xs';
const CARD_HEADER =
  'm-0 flex min-h-13 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-none border-0 border-b border-border bg-transparent px-5 py-3';
const CARD_TITLE = 'm-0 flex items-center gap-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-fg';
const CARD_FOOTER ='flex flex-wrap items-center gap-2 border-t border-border px-5 py-3';
const FLUSH_TABLE = 'rounded-none border-0';
const OUTLINE_BUTTON =
  'inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-overlay px-3 text-sm font-medium text-fg no-underline shadow-xs transition-colors hover:bg-secondary hover:text-fg hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-fg';
/** The balance's hairlines: two by two on a phone, four across from `sm`. */
const STAT_RULES = ['', 'border-s', 'border-t sm:border-t-0 sm:border-s', 'border-s border-t sm:border-t-0'] as const;
const FACT = 'flex items-start justify-between gap-4 border-t border-border py-2.5 first:border-t-0';
const FACT_TERM = 'shrink-0 text-muted-fg text-sm';
const FACT_VALUE = 'm-0 min-w-0 text-end font-medium text-fg text-sm break-words';

export default async function AccountRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/chart-of-accounts')) notFound();
  registerAllRecords();

  const [{ code: raw }, outcome, t, chart, column, status, page, locale] = await Promise.all([
    params,
    outcomeOf(searchParams),
    getTranslations('admin'),
    getTranslations('chart'),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('page'),
    getLocale(),
  ]);
  const code = decodeURIComponent(raw);

  const record = await withCurrentUser((tx, context) =>
    view(tx, context.principal, 'chart_of_account', code),
  ).catch((error) => {
    if (error instanceof RecordNotFoundError) notFound();
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  });
  if (!record) notFound();

  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const data = await withCurrentUser(async (tx, context) => {
    // The record framework addresses an account by its code, which is what a
    // person knows; the service takes the id.
    const node = await coa.loadAccountByCode(tx, code).catch(() => null);
    if (!node) return null;
    const parent = node.parentId ? await coa.loadAccount(tx, node.parentId).catch(() => null) : null;
    // Every posting from the beginning: the balance is a position, and the
    // year's movement is read out of the same rows.
    const activity = node.isGroup
      ? []
      : await trialBalance.accountActivity(tx, code, {
          from: '0001-01-01',
          to: '9999-12-31',
          allPermittedBranches: true,
        });
    return {
      node,
      parent,
      activity,
      mapping: await statementLines.pickerLines(tx),
      mayApprove: can(context.principal, 'approve', 'chart_of_account'),
      mayConfigure: can(context.principal, 'configure', 'chart_of_account'),
      mayPrint: can(context.principal, 'print', 'chart_of_account'),
      mayExport: can(context.principal, 'export', 'chart_of_account'),
    };
  });
  if (!data) notFound();
  const { node, parent, activity, mapping, mayApprove, mayConfigure, mayPrint, mayExport } = data;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const dec = (value: string) => parseDecimal(value, MONEY_SCALE);
  let opening = 0n;
  let debits = 0n;
  let credits = 0n;
  for (const row of activity) {
    const net = dec(row.debitIqd) - dec(row.creditIqd);
    if (row.postingDate < yearStart) opening += net;
    else {
      debits += dec(row.debitIqd);
      credits += dec(row.creditIqd);
    }
  }
  const closing = opening + debits - credits;
  const figure = (value: bigint) => money(toDecimalString(value, MONEY_SCALE));
  const recent = [...activity].reverse().slice(0, RECENT);
  const Icon = ICONS[node.accountType] ?? Landmark;
  const tone = toneOf(node.accountType);
  const address = `/master-data/chart-of-accounts/${encodeURIComponent(code)}`;
  const mappingLabel = (code: string | null, fallback: string) =>
    code ? (mapping.find((entry) => entry.code === code)?.name ?? code) : fallback;

  return (
    <AdminPage
      back={{ href: '/master-data/chart-of-accounts', label: t('back') }}
      title={`${node.code} · ${node.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      {/* An action that was refused says so. The record framework decides which
          buttons to *offer* from status and permission; whether the workflow
          will accept the decision — self-approval, for one — is only known when
          it is tried, and the person needs to read the answer. */}
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={`${s.sapDoc} ${s.profileGrid}`}>
        <div className={s.profileStack}>
          <section aria-labelledby="account-details-title" className={CARD}>
            <header className={CARD_HEADER}>
              <h2 className={CARD_TITLE} id="account-details-title">
                <Info aria-hidden="true" />
                <span>{chart('account_details')}</span>
              </h2>
            </header>
            <div className="flex items-center gap-3 px-5 pt-4 pb-3">
              <span className={cn('grid size-11 shrink-0 place-items-center rounded-lg', TONE_CHIP[tone])}>
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <strong className="break-words font-semibold text-base text-fg leading-snug">
                  <bdi dir="auto">{node.name}</bdi>
                </strong>
                <span className="text-muted-fg text-xs tabular-nums">
                  <bdi dir="ltr">{node.code}</bdi>
                </span>
              </div>
              <span className={`status status--${node.approvalStatus} ${s.sapRegisterStatus}`} data-status={node.approvalStatus}>
                {status(node.approvalStatus)}
              </span>
            </div>
            {/* Intent's description list: the term at the start, its value at
                the end, a hairline between each pair. */}
            <dl className="m-0 px-5 pb-2">
              <div className={FACT}>
                <dt className={FACT_TERM}>{column('code')}</dt>
                <dd className={FACT_VALUE}>
                  <bdi dir="ltr">{node.code}</bdi>
                </dd>
              </div>
              <div className={FACT}>
                <dt className={FACT_TERM}>{column('account_type')}</dt>
                <dd className={FACT_VALUE}>
                  <span className={toneBadge(tone)}>{chart(`account_types.${node.accountType}`)}</span>
                </dd>
              </div>
              <div className={FACT}>
                <dt className={FACT_TERM}>{chart('parent_account')}</dt>
                <dd className={FACT_VALUE}>
                  {parent ? (
                    <Link
                      className={cn(s.sapLink, 'inline-flex flex-col items-end gap-0 text-end')}
                      href={`/master-data/chart-of-accounts/${encodeURIComponent(parent.code)}`}
                    >
                      <bdi className="tabular-nums" dir="ltr">
                        {parent.code}
                      </bdi>
                      <span className="font-normal text-muted-fg text-xs">{parent.name}</span>
                    </Link>
                  ) : (
                    <span className="font-normal text-muted-fg">{chart('not_available')}</span>
                  )}
                </dd>
              </div>
              <div className={FACT}>
                <dt className={FACT_TERM}>{column('is_group')}</dt>
                <dd className={FACT_VALUE}>{chart(node.isGroup ? 'group_account' : 'posting_account')}</dd>
              </div>
              <div className={FACT}>
                <dt className={FACT_TERM}>{column('is_active')}</dt>
                <dd className={FACT_VALUE}>
                  <span className={toneBadge(node.isActive ? 'success' : 'secondary')}>
                    {chart(node.isActive ? 'active' : 'inactive')}
                  </span>
                </dd>
              </div>
              {/* One row per report: where this account prints on each. */}
              {MAPPING_STATEMENTS.map((entry) => (
                <div className={FACT} key={entry.statement}>
                  <dt className={FACT_TERM}>{page(entry.page)}</dt>
                  <dd className={cn(FACT_VALUE, node.mapping[entry.statement] ? undefined : 'font-normal text-muted-fg')}>
                    {mappingLabel(
                      node.mapping[entry.statement],
                      t('accounts.statement_line_default'),
                    )}
                  </dd>
                </div>
              ))}
              {node.controlAccount ? (
                <div className={FACT}>
                  <dt className={FACT_TERM}>{column('control_account')}</dt>
                  <dd className={FACT_VALUE}>{chart(`control_accounts.${node.controlAccount}`)}</dd>
                </div>
              ) : null}
            </dl>
            {/* Paper and file, offered only to those who may take them. Print
                opens the statement in its own tab; export is a route handler
                that streams the CSV, so a press is a download, not a form. */}
            {mayPrint || mayExport ? (
              <div className={CARD_FOOTER}>
                {mayPrint ? (
                  <Link className={OUTLINE_BUTTON} href={`${address}/print`} target="_blank" title={chart('print')}>
                    <Printer aria-hidden="true" />
                    <span>{chart('print')}</span>
                  </Link>
                ) : null}
                {mayExport ? (
                  <a className={OUTLINE_BUTTON} href={`${address}/export`} title={chart('export')}>
                    <Download aria-hidden="true" />
                    <span>{chart('export')}</span>
                  </a>
                ) : null}
              </div>
            ) : null}
          </section>

          {mayConfigure ? <AccountControls account={node} mapping={mapping} mayConfigure={mayConfigure} /> : null}
          {mayApprove && !node.isGroup ? <ControlAccountDesignation account={node} /> : null}
        </div>

        <div className={s.profileStack}>
          {node.isGroup ? null : (
            <section aria-labelledby="account-journals-title" className={CARD}>
              <header className={CARD_HEADER}>
                <h2 className={CARD_TITLE} id="account-journals-title">
                  <ScrollText aria-hidden="true" />
                  <span>{chart('recent_journals')}</span>
                </h2>
              </header>
              {recent.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
                  <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-fg">
                    <Inbox aria-hidden="true" className="size-5" />
                  </span>
                  <strong className="font-medium text-fg text-sm">{chart('no_journals_yet')}</strong>
                </div>
              ) : (
                <div className={cn(s.sapTableWrap, FLUSH_TABLE)}>
                  {/* A register, not a typed grid: no hairlines between the columns. */}
                  <table className={cn(s.sapTable, s.sapReportTable, '[&_:is(th,td)]:border-s-0')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('journals.posting_date')}</th>
                        <th scope="col">{t('reports.entry')}</th>
                        <th scope="col">{t('journals.description')}</th>
                        <th className={s.sapNum} scope="col">
                          {t('journals.debit')}
                        </th>
                        <th className={s.sapNum} scope="col">
                          {t('journals.credit')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((row, index) => (
                        <tr key={`${row.entryNo}-${row.lineNo}-${index}`}>
                          <td>
                            {/* Not forced left to right: an Arabic date read inside an
                                LTR island comes out back to front (the rule Home follows). */}
                            <bdi className="whitespace-nowrap">{formatBusinessDate(row.postingDate, locale as Locale)}</bdi>
                          </td>
                          <td>
                            <Link className={cn(s.sapLink, 'tabular-nums')} href={`/finance/journals/${encodeURIComponent(row.entryNo)}`}>
                              <bdi dir="ltr">{row.entryNo}</bdi>
                            </Link>
                          </td>
                          <td>
                            <bdi dir="auto">{row.description ?? '—'}</bdi>
                          </td>
                          <td className={s.sapNum}>
                            <bdi dir="ltr">{Number(row.debitIqd) === 0 ? '' : money(row.debitIqd)}</bdi>
                          </td>
                          <td className={s.sapNum}>
                            <bdi dir="ltr">{Number(row.creditIqd) === 0 ? '' : money(row.creditIqd)}</bdi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {node.isGroup ? null : (
            <section aria-labelledby="account-balance-title" className={CARD}>
              <header className={CARD_HEADER}>
                <h2 className={CARD_TITLE} id="account-balance-title">
                  <Calculator aria-hidden="true" />
                  <span>{chart('balance_summary')}</span>
                </h2>
                <bdi className={toneBadge('secondary', 'tabular-nums')} dir="ltr">
                  IQD · {year}
                </bdi>
              </header>
              {/* Four figures across one row, the year's position read from the
                  start: Intent's stat row, a hairline between each figure and
                  the closing balance — what the other three add up to — tinted. */}
              <dl className="m-0 grid grid-cols-2 sm:grid-cols-4">
                {(
                  [
                    ['opening_balance', opening],
                    ['total_debits', debits],
                    ['total_credits', credits],
                    ['closing_balance', closing],
                  ] as const
                ).map(([label, value], index) => (
                  <div
                    className={cn(
                      'flex min-w-0 flex-col gap-1 border-border px-4 py-4 sm:px-5',
                      STAT_RULES[index],
                      label === 'closing_balance' && 'bg-primary-subtle',
                    )}
                    key={label}
                  >
                    <dt
                      className={cn(
                        'font-medium text-xs',
                        label === 'closing_balance' ? 'text-primary-subtle-fg' : 'text-muted-fg',
                      )}
                    >
                      {chart(label)}
                    </dt>
                    <dd
                      className={cn(
                        'm-0 break-words text-base tabular-nums sm:text-lg',
                        label === 'closing_balance' ? 'font-semibold text-primary-subtle-fg' : 'font-medium text-fg',
                      )}
                    >
                      <bdi dir="ltr">{figure(value)}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
              <div className={CARD_FOOTER}>
                <Link
                  className="inline-flex items-center gap-1.5 font-medium text-primary-subtle-fg text-sm no-underline underline-offset-4 hover:text-primary-subtle-fg hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  href={`/finance/gl-inquiry/${encodeURIComponent(code)}`}
                >
                  {chart('open_ledger')}
                  <ArrowRight aria-hidden="true" className="size-4 rtl:-scale-x-100" />
                </Link>
              </div>
            </section>
          )}

          <RecordPage
            hideTitle
            journalEmptyContent={(
              <p className="muted">
                {chart(node.isGroup ? 'group_journal_hint' : 'account_journal_hint')}
                {node.isGroup ? null : (
                  <>
                    {' '}
                    <Link className={s.sapLink} href={`/finance/gl-inquiry/${encodeURIComponent(code)}`}>
                      {chart('open_ledger')}
                    </Link>
                  </>
                )}
              </p>
            )}
            returnTo={address}
            view={record}
          />
        </div>
      </div>
    </AdminPage>
  );
}
