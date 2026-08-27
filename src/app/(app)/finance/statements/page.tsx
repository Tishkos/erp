import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, FilterForm, Pill, Submit, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statements from '@/server/services/financial-statements';
import type { StatementLineResult } from '@/server/services/financial-statements';

/**
 * The financial statements — Phase 1 requirement 5.
 *
 * Both are drawn from the posted journal lines and nothing else. The Statement
 * of Profit or Loss covers the period between the two dates; the Statement of
 * Financial Position is as at the later of them, counting everything posted up
 * to that day — which is why the same screen shows one date range and two
 * reports that answer different questions with it.
 */
export const dynamic = 'force-dynamic';

export default async function StatementsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/statements')) notFound();

  const [t, page, line, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('statement_line'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('financial_statements')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof params.from === 'string' ? params.from : `${year}-01-01`;
  const to = typeof params.to === 'string' ? params.to : `${year}-12-31`;

  const { pl, sfp } = await withCurrentUser(async (tx) => ({
    pl: await statements.profitOrLoss(tx, { from, to, allPermittedBranches: true }),
    sfp: await statements.financialPosition(tx, to, {
      allPermittedBranches: true,
      yearStart: from,
    }),
  }));

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  /** One line of a statement, with the accounts behind it named underneath. */
  const StatementRows = ({ lines }: { readonly lines: readonly StatementLineResult[] }) => (
    <>
      {lines.map((entry) => (
        <>
          <tr key={entry.line.code}>
            <th scope="row">
              {line(entry.line.code)}
              {entry.line.deduction ? <span className="muted"> ({t('reports.deducted')})</span> : null}
            </th>
            <td className={`numeric ${s.totalCell}`}>{money(entry.amount)}</td>
          </tr>
          {entry.accounts.map((account) => (
            <tr key={`${entry.line.code}-${account.accountCode}`}>
              <td className={s.statementAccount}>
                <span className={s.mono}>{account.accountCode}</span> · {account.accountName}
              </td>
              <td className="numeric">{money(account.amount)}</td>
            </tr>
          ))}
        </>
      ))}
    </>
  );

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/statements" />}
      subtitle={t('reports.statements_subtitle')}
      title={t('reports.statements')}
      variant="sap"
    >
      <Panel>
        <FilterForm action="/finance/statements">
          <Field defaultValue={from} label={t('reports.from')} name="from" required type="date" />
          <Field
            defaultValue={to}
            hint={t('reports.as_at_hint')}
            label={t('reports.to')}
            name="to"
            type="date"
            required
                />
          <Submit label={t('reports.run')} />
        </FilterForm>
      </Panel>

      <div className={s.assignGrid}>
        <Panel flush title={t('reports.profit_or_loss')}>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">
                    {t('reports.for_the_period', {
                      from: formatBusinessDate(from, locale as Locale),
                      to: formatBusinessDate(to, locale as Locale),
                    })}
                  </th>
                  <th className="numeric" scope="col">
                    {t('reports.amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pl.lines.length === 0 ? (
                  <tr>
                    <td className="muted" colSpan={2}>
                      {t('reports.nothing_posted')}
                    </td>
                  </tr>
                ) : (
                  <StatementRows lines={pl.lines} />
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th className={s.totalCell} scope="row">
                    {Number(pl.result) < 0 ? t('reports.loss') : t('reports.profit')}
                  </th>
                  <td className={`numeric ${s.totalCell}`}>{money(pl.result)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>

        <Panel flush title={t('reports.financial_position')}>
          <div className="table-wrap" style={{ border: 0 }}>
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">
                    {t('reports.as_at', { date: formatBusinessDate(to, locale as Locale) })}
                  </th>
                  <th className="numeric" scope="col">
                    {t('reports.amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th className={s.statementSection} colSpan={2} scope="row">
                    {t('reports.assets')}
                  </th>
                </tr>
                <StatementRows lines={sfp.assets} />
                <tr>
                  <th className={s.totalCell} scope="row">
                    {t('reports.total_assets')}
                  </th>
                  <td className={`numeric ${s.totalCell}`}>{money(sfp.totalAssets)}</td>
                </tr>

                <tr>
                  <th className={s.statementSection} colSpan={2} scope="row">
                    {t('reports.equity_and_liabilities')}
                  </th>
                </tr>
                <StatementRows lines={sfp.equityAndLiabilities} />
                {/* Until a year-end close moves it into retained earnings, the
                    period's own result is what makes the two sides agree. */}
                <tr>
                  <td className={s.statementAccount}>{t('reports.result_for_the_period')}</td>
                  <td className="numeric">{money(sfp.resultForThePeriod)}</td>
                </tr>
                <tr>
                  <th className={s.totalCell} scope="row">
                    {t('reports.total_equity_and_liabilities')}
                  </th>
                  <td className={`numeric ${s.totalCell}`}>{money(sfp.totalEquityAndLiabilities)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ padding: '1rem 1.5rem' }}>
            <Pill
              label={sfp.balances ? t('reports.sides_agree') : t('reports.does_not_balance')}
              on={sfp.balances}
            />
          </div>
        </Panel>
      </div>
    </AdminPage>
  );
}
