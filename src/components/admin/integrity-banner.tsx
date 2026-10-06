import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
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
  // Intent UI's warning note, in the palette's own warning colours (the redesign, 2026-10-06).
  return (
    <div
      className="mb-4 flex gap-3 rounded-lg border border-warning-subtle-fg/25 bg-warning-subtle px-4 py-3 text-sm text-fg"
      role="alert"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-subtle-fg" />
      <div className="min-w-0">
        <strong className="font-semibold">{t('integrity.title', { count: integrity.findingCount(report) })}</strong>{' '}
        {t('integrity.hint')}{' '}
        <Link className="font-medium text-warning-subtle-fg underline underline-offset-2" href="/inventory/stock-ledger">
          {t('integrity.open_ledger')}
        </Link>
        <ul className="mt-2 list-disc space-y-0.5 ps-4 text-muted-fg">
          {lines.slice(0, 5).map((line) => (
            <li key={line}>
              <bdi dir="ltr">{line}</bdi>
            </li>
          ))}
          {lines.length > 5 ? <li>{t('integrity.more', { count: lines.length - 5 })}</li> : null}
        </ul>
      </div>
    </div>
  );
}
