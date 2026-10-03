import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as integrity from '@/server/services/inventory-integrity';

/**
 * A line across the top of every stock screen when the ledger and its
 * documents disagree — and nothing at all when they agree.
 *
 * The check is cheap (a handful of indexed queries) and it is asked live, on
 * the page where the figures are read, so a person looking at a warehouse
 * total is told in the same glance if the total cannot be trusted. The
 * nightly run tells the accounting managers; this tells whoever is looking.
 *
 * Shown only to people who may view stock movements: the figures it refers
 * to are theirs to read.
 */
export async function IntegrityBanner() {
  const context = await requireContext();
  if (!can(context.principal, 'view', 'stock_movement')) return null;

  const [t, report] = await Promise.all([
    getTranslations('admin'),
    withCurrentUser((tx) => integrity.check(tx)),
  ]);
  if (report.clean) return null;

  const lines = integrity.describe(report);
  return (
    <div
      role="alert"
      style={{
        margin: '0 0 1rem',
        padding: '0.75rem 1rem',
        border: '1px solid #b45309',
        background: '#fffbeb',
        color: '#78350f',
        borderRadius: 4,
      }}
    >
      <strong>{t('integrity.title', { count: integrity.findingCount(report) })}</strong>{' '}
      {t('integrity.hint')}{' '}
      <Link href="/inventory/stock-ledger">{t('integrity.open_ledger')}</Link>
      <ul style={{ margin: '0.5rem 0 0 1rem' }}>
        {lines.slice(0, 5).map((line) => (
          <li key={line}>
            <bdi dir="ltr">{line}</bdi>
          </li>
        ))}
        {lines.length > 5 ? <li>{t('integrity.more', { count: lines.length - 5 })}</li> : null}
      </ul>
    </div>
  );
}
