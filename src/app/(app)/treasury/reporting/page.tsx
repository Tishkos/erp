import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, FilterRow, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { SearchablePicker } from '@/components/admin/searchable-picker';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as reports from '@/server/services/treasury-reports';

/**
 * Bank and Cash Reporting — §17.
 *
 * Every account, what it opened the period with, what came in, what went out,
 * and what it closes at. The closing figure is the G/L balance of the account
 * the bank account is mapped to; it is not stored anywhere and not added up by
 * this page. That is the 07.1 gate stated as an identity rather than as a
 * reconciliation — see `services/treasury-reports.ts`.
 *
 * ── Transfers have their own columns, and that is the point ───────────────
 * Money moved between two of the company's own accounts is not income to one
 * and expense to the other. Folded into "money in" it would make a treasury
 * that shuffles a million between its own accounts each morning look like a
 * business earning a million a day. They are identified by the module that
 * posted them, not by their wording.
 *
 * Choosing an account opens its transactions underneath, oldest first, with the
 * balance carried down and every row naming the journal entry behind it.
 */
export const dynamic = 'force-dynamic';

export default async function TreasuryReportingPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/reporting')) notFound();

  const [t, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', reports.PERMISSION_OBJECT)) {
    return <Denied object={page('treasury_reports')} />;
  }

  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const year = new Date().getFullYear();
  const from = one('from') || `${year}-01-01`;
  const to = one('to') || new Date().toISOString().slice(0, 10);
  const kind = one('kind') === 'bank' || one('kind') === 'cash' ? (one('kind') as 'bank' | 'cash') : null;
  const chosen = one('account') || null;

  const { positions, allAccounts, ledger } = await withCurrentUser(async (tx, request) => {
    const actor = { principal: request.principal, branchCode: request.scope.branchCode };
    return {
      positions: await reports.positions(tx, actor, { from, to }, { kind, accountCode: chosen }),
      // The picker offers every account, not the filtered set — a filter that
      // hid the thing you are trying to choose would be a trap.
      allAccounts: await reports.positions(tx, actor, { from, to }, {}),
      // The branch is deliberately not narrowed here: a bank account is a
      // company-wide master (§17), and a balance shown for one branch would
      // not be the balance anybody can reconcile against the bank.
      ledger: chosen ? await reports.ledger(tx, actor, chosen, { from, to }) : null,
    };
  });

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const sum = (pick: (row: reports.AccountPosition) => string) =>
    positions.reduce((total, row) => total + Number(pick(row)), 0);

  const href = (next: Record<string, string | null>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ from, to, kind: kind ?? '', account: chosen ?? '', ...next })) {
      if (value) query.set(key, value);
    }
    return `/treasury/reporting?${query.toString()}`;
  };

  const kindName = (value: string) => t(`treasury_reporting.kind_${value}`);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="treasury_reporting" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('treasury_reporting.subtitle')}
      tabs={<SectionTabs route="/treasury/reporting" />}
      title={page('treasury_reports')}
      variant="sap"
    >
      <Panel flush>
        <form className={s.filterBar} method="get">
          <FilterRow>
            <Field defaultValue={from} label={t('reports.from')} name="from" type="date" />
            <Field defaultValue={to} label={t('reports.to')} name="to" type="date" />
            <Select
              defaultValue={kind ?? ''}
              emptyLabel={t('treasury_reporting.all_accounts')}
              label={column('account_type')}
              name="kind"
              options={[
                { value: 'bank', label: kindName('bank') },
                { value: 'cash', label: kindName('cash') },
              ]}
            />
            {/* One account by name, typed and matched — a treasury with forty
                accounts is not a drop-down anybody reads. */}
            <SearchablePicker
              defaultValue={chosen ?? ''}
              label={column('account')}
              name="account"
              options={allAccounts.map((row) => ({
                value: row.accountCode,
                label: `${row.accountName} · ${row.accountCode}`,
              }))}
            />
            <SubmitRow>
              <Submit label={t('stock_movements.filter')} />
            </SubmitRow>
          </FilterRow>
        </form>

        {positions.length === 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {t('treasury_reporting.no_accounts')}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{column('account')}</th>
                  <th scope="col">{column('account_type')}</th>
                  <th scope="col">{column('currency')}</th>
                  <th scope="col">{t('treasury_reporting.opening')}</th>
                  <th scope="col">{t('treasury_reporting.money_in')}</th>
                  <th scope="col">{t('treasury_reporting.money_out')}</th>
                  <th scope="col">{t('treasury_reporting.transfers_in')}</th>
                  <th scope="col">{t('treasury_reporting.transfers_out')}</th>
                  <th scope="col">{t('treasury_reporting.closing')}</th>
                  <th scope="col">{t('treasury_reporting.last_movement')}</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((row) => (
                  <tr key={row.accountCode}>
                    <td>
                      <Link href={href({ account: row.accountCode })}>
                        <bdi dir="auto">{row.accountName}</bdi>
                      </Link>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.accountCode}</bdi>
                      </span>
                      {/* An account with no ledger account behind it cannot
                          post. Said here rather than hidden, because this is
                          the screen from which it can be repaired. */}
                      {row.glAccountCode ? null : (
                        <>
                          {' '}
                          <span className={s.sapWarn}>{t('treasury_reporting.no_ledger_account')}</span>
                        </>
                      )}
                    </td>
                    <td>{kindName(row.kind)}</td>
                    <td>
                      <bdi dir="ltr">{row.currency}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(row.openingIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(row.moneyInIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(row.moneyOutIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(row.transfersInIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(row.transfersOutIqd)}</bdi>
                    </td>
                    <td>
                      <strong>
                        <bdi dir="ltr">{money(row.closingIqd)}</bdi>
                      </strong>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.lastMovementDate ? day(row.lastMovementDate) : '—'}</bdi>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}>
                    <strong>{t('reports.totals')}</strong>
                  </td>
                  {(
                    [
                      (row: reports.AccountPosition) => row.openingIqd,
                      (row: reports.AccountPosition) => row.moneyInIqd,
                      (row: reports.AccountPosition) => row.moneyOutIqd,
                      (row: reports.AccountPosition) => row.transfersInIqd,
                      (row: reports.AccountPosition) => row.transfersOutIqd,
                      (row: reports.AccountPosition) => row.closingIqd,
                    ] as const
                  ).map((pick, index) => (
                    <td key={index}>
                      <strong>
                        <bdi dir="ltr">{money(String(sum(pick)))}</bdi>
                      </strong>
                    </td>
                  ))}
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {ledger ? (
        <Panel
          flush
          title={t('treasury_reporting.ledger_for', {
            account: `${ledger.accountName} · ${ledger.accountCode}`,
          })}
        >
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('movement')}</th>
                  <th scope="col">{t('treasury_reporting.party')}</th>
                  <th scope="col">{column('description')}</th>
                  <th scope="col">{column('raised_by')}</th>
                  <th scope="col">{t('treasury_reporting.approved_by')}</th>
                  <th scope="col">{t('treasury_reporting.money_in')}</th>
                  <th scope="col">{t('treasury_reporting.money_out')}</th>
                  <th scope="col">{t('treasury_reporting.running_balance')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <bdi dir="ltr">{day(ledger.from)}</bdi>
                  </td>
                  <td colSpan={8}>
                    <strong>{t('treasury_reporting.opening')}</strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(ledger.openingIqd)}</bdi>
                    </strong>
                  </td>
                </tr>
                {ledger.lines.length === 0 ? (
                  <tr>
                    <td colSpan={10}>{t('treasury_reporting.no_movements')}</td>
                  </tr>
                ) : null}
                {ledger.lines.map((line, index) => (
                  <tr key={`${line.entryNo}-${index}`}>
                    <td>
                      <bdi dir="ltr">{day(line.postingDate)}</bdi>
                    </td>
                    <td className={s.sapAccountCell}>
                      {/* Every row opens the journal that made it: a figure
                          nobody can trace is a figure nobody can defend. */}
                      <Link href={`/finance/journals/${encodeURIComponent(line.entryNo)}`}>
                        <bdi dir="ltr">{line.entryNo}</bdi>
                      </Link>
                    </td>
                    <td>{t(`treasury_reporting.movement_${line.kind}`)}</td>
                    <td>
                      <bdi dir="auto">{line.partyName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{line.description ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{line.raisedBy ?? '—'}</bdi>
                    </td>
                    <td>
                      {/* Blank on an entry the posting engine raised: the
                          approval was given on the document, and naming
                          somebody here would claim one nobody gave. */}
                      <bdi dir="auto">{line.approvedBy ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{Number(line.debitIqd) === 0 ? '' : money(line.debitIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{Number(line.creditIqd) === 0 ? '' : money(line.creditIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{money(line.balanceIqd)}</bdi>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <bdi dir="ltr">{day(ledger.to)}</bdi>
                  </td>
                  <td colSpan={6}>
                    <strong>{t('treasury_reporting.closing')}</strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(ledger.totalInIqd)}</bdi>
                    </strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(ledger.totalOutIqd)}</bdi>
                    </strong>
                  </td>
                  <td>
                    <strong>
                      <bdi dir="ltr">{money(ledger.closingIqd)}</bdi>
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </AdminPage>
  );
}
