import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Download, Landmark, Printer, ReceiptText, Scale, TrendingUp, WalletCards, type LucideIcon } from 'lucide-react';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { visibleRoute } from '@/server/phase-gate';
import { RecordPage } from '@/components/record-page';
import { registerAllRecords } from '@/server/records';
import { RecordNotFoundError, view } from '@/server/services/record';
import { PermissionDeniedError, can } from '@domain/permissions';
import { withCurrentUser } from '@/server/session';
import { AccountControls } from '@/components/admin/account-controls';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import type { AccountType } from '@domain/accounts';
import * as coa from '@/server/services/chart-of-accounts';
import * as trialBalance from '@/server/services/trial-balance';

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

export default async function AccountRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/chart-of-accounts')) notFound();
  registerAllRecords();

  const [{ code: raw }, outcome, t, chart, column, status, line, locale] = await Promise.all([
    params,
    outcomeOf(searchParams),
    getTranslations('admin'),
    getTranslations('chart'),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('statement_line'),
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
      mayConfigure: can(context.principal, 'configure', 'chart_of_account'),
      mayPrint: can(context.principal, 'print', 'chart_of_account'),
      mayExport: can(context.principal, 'export', 'chart_of_account'),
    };
  });
  if (!data) notFound();
  const { node, parent, activity, mayConfigure, mayPrint, mayExport } = data;

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
  const address = `/master-data/chart-of-accounts/${encodeURIComponent(code)}`;

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
          <section className="coa-panel coa-details-panel" aria-labelledby="account-details-title">
            <header className="coa-panel-header">
              <h2 id="account-details-title">{chart('account_details')}</h2>
            </header>
            <div className="coa-detail-hero">
              <span className="coa-detail-icon">
                <Icon aria-hidden="true" />
              </span>
              <div>
                <strong>
                  <bdi dir="auto">{node.name}</bdi>
                </strong>
                <span>
                  <bdi dir="ltr">{node.code}</bdi>
                </span>
              </div>
              <span className={`status status--${node.approvalStatus} ${s.sapRegisterStatus}`} data-status={node.approvalStatus}>
                {status(node.approvalStatus)}
              </span>
            </div>
            <dl className="coa-detail-grid">
              <div>
                <dt>{column('code')}</dt>
                <dd>
                  <bdi dir="ltr">{node.code}</bdi>
                </dd>
              </div>
              <div>
                <dt>{column('account_type')}</dt>
                <dd>{chart(`account_types.${node.accountType}`)}</dd>
              </div>
              <div>
                <dt>{chart('parent_account')}</dt>
                <dd>
                  {parent ? (
                    <Link className={s.sapLink} href={`/master-data/chart-of-accounts/${encodeURIComponent(parent.code)}`}>
                      <bdi dir="ltr">{parent.code}</bdi>
                      <span className="coa-detail-parent-name">{parent.name}</span>
                    </Link>
                  ) : (
                    chart('not_available')
                  )}
                </dd>
              </div>
              <div>
                <dt>{column('is_group')}</dt>
                <dd>{chart(node.isGroup ? 'group_account' : 'posting_account')}</dd>
              </div>
              <div>
                <dt>{column('is_active')}</dt>
                <dd>{chart(node.isActive ? 'active' : 'inactive')}</dd>
              </div>
              <div>
                <dt>{t('accounts.statement_line')}</dt>
                <dd>{node.statementLine ? line(node.statementLine) : t('accounts.statement_line_default')}</dd>
              </div>
              {node.controlAccount ? (
                <div>
                  <dt>{column('control_account')}</dt>
                  <dd>{chart(`control_accounts.${node.controlAccount}`)}</dd>
                </div>
              ) : null}
            </dl>
            {/* Paper and file, offered only to those who may take them. Print
                opens the statement in its own tab; export is a route handler
                that streams the CSV, so a press is a download, not a form. */}
            {mayPrint || mayExport ? (
              <div className="coa-panel-footer coa-panel-actions">
                {mayPrint ? (
                  <Link className={s.sapIconButton} href={`${address}/print`} target="_blank" title={chart('print')}>
                    <Printer aria-hidden="true" />
                    <span>{chart('print')}</span>
                  </Link>
                ) : null}
                {mayExport ? (
                  <a className={s.sapIconButton} href={`${address}/export`} title={chart('export')}>
                    <Download aria-hidden="true" />
                    <span>{chart('export')}</span>
                  </a>
                ) : null}
              </div>
            ) : null}
          </section>

          {mayConfigure ? <AccountControls account={node} mayConfigure={mayConfigure} /> : null}
        </div>

        <div className={s.profileStack}>
          {node.isGroup ? null : (
            <section className="coa-panel coa-journals-panel" aria-labelledby="account-journals-title">
              <header className="coa-panel-header">
                <h2 id="account-journals-title">{chart('recent_journals')}</h2>
              </header>
              {recent.length === 0 ? (
                <div className="coa-journal-empty">
                  <strong>{chart('no_journals_yet')}</strong>
                </div>
              ) : (
                <div className={s.sapTableWrap}>
                  <table className={`${s.sapTable} ${s.sapReportTable}`}>
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
                            <bdi dir="ltr">{formatBusinessDate(row.postingDate, locale as Locale)}</bdi>
                          </td>
                          <td>
                            <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(row.entryNo)}`}>
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
            <section className="coa-panel coa-journals-panel" aria-labelledby="account-balance-title">
              <header className="coa-panel-header">
                <h2 id="account-balance-title">{chart('balance_summary')}</h2>
                <bdi className="coa-currency-badge" dir="ltr">
                  IQD · {year}
                </bdi>
              </header>
              {/* The same table as the journals above it: four figures across
                  one row, the year's position read left to right. */}
              <div className={s.sapTableWrap}>
                <table className={`${s.sapTable} ${s.sapReportTable}`}>
                  <thead>
                    <tr>
                      <th className={s.sapNum} scope="col">
                        {chart('opening_balance')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {chart('total_debits')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {chart('total_credits')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {chart('closing_balance')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{figure(opening)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{figure(debits)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{figure(credits)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <strong>
                          <bdi dir="ltr">{figure(closing)}</bdi>
                        </strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="coa-panel-footer">
                <Link className={`${s.sapLink} coa-detail-link`} href={`/finance/gl-inquiry/${encodeURIComponent(code)}`}>
                  {chart('open_ledger')}
                </Link>
              </div>
            </section>
          )}

          <RecordPage hideTitle returnTo={address} view={record} />
        </div>
      </div>
    </AdminPage>
  );
}
