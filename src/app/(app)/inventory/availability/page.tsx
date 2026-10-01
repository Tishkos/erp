import { getTranslations } from 'next-intl/server';
import { Submit } from '@/components/admin';
import { visibleRoute } from '@/server/delivered';
import { notFound } from 'next/navigation';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { DataList } from '@/components/data-list';
import { Denied } from '@/components/denied';
import { PermissionDeniedError } from '@domain/permissions';
import { NegativeStockError } from '@domain/inventory';
import { parseQuantity } from '@domain/uom';
import { registerAllLists, stockPositionList } from '@/server/lists';
import { rows } from '@/server/services/list';
import * as inventory from '@/server/services/inventory';
import { withCurrentUser } from '@/server/session';

/**
 * Availability — Appendix A menu 5, on Phase 04's §9.5 buckets.
 *
 * The issue form here is what makes 04.4's first gate item testable: *"An issue
 * exceeding available stock is rejected via the UI."* It matters that this is a
 * separate item from the API one. The refusal has to reach a person as a
 * sentence they can act on, not as a 500 — §25 requires the message to name the
 * field, the reason and the correction, and a screen is where that is judged.
 *
 * The form calls the same `inventory.issue` the API and the import call. There
 * is no screen-specific path, which is why the three gate items can be proved
 * separately and still describe one rule.
 */
export const dynamic = 'force-dynamic';

async function issueStock(formData: FormData) {
  'use server';

  const itemCode = String(formData.get('item_code') ?? '').trim();
  const warehouseCode = String(formData.get('warehouse_code') ?? '').trim();
  const quantity = String(formData.get('quantity') ?? '').trim();
  const batchNumber = String(formData.get('batch_number') ?? '').trim();

  try {
    await withCurrentUser((tx, context) =>
      inventory.issue(tx, { principal: context.principal, branchCode: context.scope.branchCode }, {
        itemCode,
        warehouseCode,
        branchCode: context.scope.branchCode,
        quantity: parseQuantity(quantity),
        movementDate: new Date().toISOString().slice(0, 10),
        ...(batchNumber ? { batchNumber } : {}),
      }),
    );
  } catch (error) {
    // The message the service produced, carried to the screen intact. §25's
    // "identify the field, reason and corrective action" is satisfied by the
    // service; rewriting it here would lose the figures it names.
    const message =
      error instanceof NegativeStockError || error instanceof Error
        ? error.message
        : 'The issue could not be made.';

    redirectWithError(message);
  }

  revalidatePath('/inventory/availability');
  redirectWithError(null);
}

function redirectWithError(message: string | null): never {
  redirect(
    message
      ? `/inventory/availability?error=${encodeURIComponent(message)}`
      : '/inventory/availability?issued=1',
  );
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!visibleRoute('/inventory/availability')) notFound();
  registerAllLists();

  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q : undefined;
  const error = typeof params.error === 'string' ? params.error : undefined;

  const t = await getTranslations();

  const result = await withCurrentUser((tx, context) =>
    rows(tx, context.principal, 'stock_position', { ...(search ? { search } : {}) }),
  ).catch((cause) => {
    if (cause instanceof PermissionDeniedError) return null;
    throw cause;
  });

  if (!result) {
    return (
      <>
        <Denied object={t('page.availability')} />
      </>
    );
  }

  return (
    <>
      <div className="page__header">
        <h1 className="page__title">{t('page.availability')}</h1>
      </div>

      {error && (
        <div className="panel" role="alert" style={{ borderColor: 'var(--status-rejected)' }}>
          <p style={{ color: 'var(--status-rejected)', margin: 0 }}>{error}</p>
        </div>
      )}

      <form className="list__toolbar" method="get">
        <input
          className="list__search"
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder={t('list.search_placeholder')}
          aria-label={t('list.search')}
        />
        <Submit label={t('list.search')} tone="secondary" variant="document" />
      </form>

      <DataList
        columns={stockPositionList.columns}
        rows={result.rows}
        query={result.query}
        total={result.total}
      />

      <section className="panel" style={{ marginBlockStart: 'var(--space-6)' }}>
        <h2 className="panel__title">{t('inventory.issue_stock')}</h2>
        <form action={issueStock} className="list__toolbar">
          <input
            className="list__search"
            name="item_code"
            required
            placeholder={t('column.item_code')}
            aria-label={t('column.item_code')}
          />
          <input
            className="list__search"
            name="warehouse_code"
            required
            placeholder={t('column.warehouse_code')}
            aria-label={t('column.warehouse_code')}
          />
          <input
            className="list__search"
            name="batch_number"
            placeholder={t('column.batch_number')}
            aria-label={t('column.batch_number')}
          />
          <input
            className="list__search"
            name="quantity"
            required
            inputMode="decimal"
            placeholder={t('column.quantity')}
            aria-label={t('column.quantity')}
          />
          <Submit label={t('inventory.issue')} variant="document" />
        </form>
      </section>
    </>
  );
}
