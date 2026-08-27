import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, admin as s } from '@/components/admin';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as journal from '@/server/services/journal';

/**
 * Reversals — Phase 1 requirement 3, read as a register.
 *
 * Every correction made to the books since the beginning, both halves of each
 * one, and the reason. This screen has no actions of its own: a reversal is
 * raised on the entry being corrected, where the person can see what they are
 * about to undo. What it offers instead is the question an auditor asks —
 * *what has been changed, and why* — answered on one page.
 */
export const dynamic = 'force-dynamic';

export default async function ReversalsPage() {
  if (!visibleRoute('/finance/reversals')) notFound();

  const [t, page, locale, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
  ]);
  if (!can(context.principal, 'view', journal.PERMISSION_OBJECT)) {
    return <Denied object={page('reversals')} />;
  }

  const rows = await withCurrentUser((tx) => journal.reversals(tx));
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const link = (entryNo: string) => (
    <Link href={`/finance/journals/${encodeURIComponent(entryNo)}`}>{entryNo}</Link>
  );

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/reversals" />}
      subtitle={t('reversals.subtitle')}
      title={t('reversals.title')}
      variant="sap"
    >
      <Panel flush>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('reversals.original')}</th>
                <th scope="col">{t('reversals.posted_on')}</th>
                <th className="numeric" scope="col">
                  {t('reports.amount')}
                </th>
                <th scope="col">{t('reversals.reversal')}</th>
                <th scope="col">{t('reversals.reversed_on')}</th>
                <th scope="col">{t('reason')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="muted" colSpan={6}>
                    {t('reversals.none')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.reversalId}>
                    <td className={s.mono}>{link(row.originalNo)}</td>
                    <td>{formatBusinessDate(row.originalPostingDate, locale as Locale)}</td>
                    <td className="numeric">{money(row.originalAmount)}</td>
                    <td className={s.mono}>{link(row.reversalNo)}</td>
                    <td>{formatBusinessDate(row.reversalPostingDate, locale as Locale)}</td>
                    <td>{row.reason ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
