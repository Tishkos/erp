import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow } from '@/components/admin/report-filter';
import { StatementTable } from '@/components/admin/statement-table';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as partners from '@/server/services/partners';
import * as statement from '@/server/services/partner-statement';

/**
 * One partner's Account Statement — Operations build, blocks 2 and 3.
 *
 * One page for both sides, because it is one record and one subledger. Which
 * way round it reads is the partner's own role:
 *
 *   a customer   sales Debit, receipts and discounts Credit
 *   a supplier   purchases Credit, payments and discounts Debit
 *
 * and the balance runs in the direction money is owed, so either statement
 * ends at a positive figure when something is outstanding. A partner who is
 * both is shown as a customer here and as a supplier from the Suppliers side;
 * netting the two would answer a question nobody asked.
 */
export const dynamic = 'force-dynamic';

export default async function PartnerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/business-partners')) notFound();

  const [t, page, chart, locale, context, query, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('chart'),
    getLocale(),
    requireContext(),
    searchParams,
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  if (!can(context.principal, 'view', partners.PERMISSION_OBJECT)) {
    return <Denied object={page('md_business_partners')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof query.from === 'string' ? query.from : `${year}-01-01`;
  const to = typeof query.to === 'string' ? query.to : `${year}-12-31`;
  // A partner who is both is read from whichever side was asked for, and as a
  // customer when nothing was said.
  const requestedSide =
    query.side === 'supplier' || query.side === 'customer' ? query.side : null;

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await partners.detail(tx, code);
      const side: statement.PartySide =
        requestedSide ?? (row.isSupplier && !row.isCustomer ? 'supplier' : 'customer');
      return { row, side, account: await statement.statementFor(tx, side, code, { from, to }) };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, side, account } = data;

  const money = (amount: string) => formatStatementAmount(amount, 'IQD', locale as Locale);

  return (
    <AdminPage
      back={{ href: `/master-data/business-partners/${encodeURIComponent(code)}`, label: t('back') }}
      title={`${row.code} · ${row.legalName}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <ReportWindow
        filter={
          <ReportFilter
            action={`/master-data/business-partners/${encodeURIComponent(code)}/statement`}
            currency="IQD"
            from={from}
            hiddenFields={{ side }}
            to={to}
          />
        }
        foot={
          <div className={s.sapFootTotals}>
            <div className={s.sapFootTotal}>
              <span>{t('partners.statement_closing')}</span>
              <strong>
                <bdi dir="ltr">{money(account.closing)}</bdi>
              </strong>
            </div>
          </div>
        }
        meta={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
        title={t('partners.statement')}
      >
        <StatementTable
          columns={[
            t('partners.statement_entry'),
            `${t('partners.statement_debit')} · IQD`,
            `${t('partners.statement_credit')} · IQD`,
            `${t('partners.statement_balance')} · IQD`,
          ]}
          labels={{
            expandAll: chart('expand_all'),
            collapseAll: chart('collapse_all'),
            expand: t('mapping.expand'),
            collapse: t('mapping.collapse'),
            empty: t('partners.statement_empty'),
          }}
          rows={[
            {
              key: 'opening',
              label: t('partners.statement_opening'),
              depth: 0,
              tone: 'line' as const,
              cells: ['', '', money(account.opening)],
            },
            ...account.lines.map((line) => ({
              key: `line:${line.entryNo}:${line.postingDate}`,
              label: `${formatBusinessDate(line.postingDate, locale as Locale)} · ${line.entryNo}${
                line.description ? ` · ${line.description}` : ''
              }`,
              depth: 0,
              tone: 'line' as const,
              cells: [money(line.debit), money(line.credit), money(line.balance)],
            })),
            {
              key: 'closing',
              label: t('partners.statement_closing'),
              depth: 0,
              tone: 'line' as const,
              rule: 'double' as const,
              cells: [money(account.totalDebit), money(account.totalCredit), money(account.closing)],
            },
          ]}
        />
      </ReportWindow>
    </AdminPage>
  );
}
