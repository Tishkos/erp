'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseQuantity } from '@domain/uom';
import * as stock from '@/server/services/stock-operations';

const LIST = '/inventory/stock-reconciliation';

/**
 * An Item Reconciliation — Operations build, block 7: the item, the
 * warehouse, In or Out, and the adjustment quantity. The number is the
 * system's (STOCK_ADJUSTMENT).
 */
export async function createAdjustment(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      stock.adjust(tx, ctx, {
        // The key the form was drawn with — see stock-operations.claimDocumentId.
        id: text(formData, 'document_id').trim() || null,
        itemCode: text(formData, 'item_code').trim(),
        warehouseCode: text(formData, 'warehouse_code').trim(),
        direction: text(formData, 'direction').trim() === 'out' ? 'out' : 'in',
        quantity: parseQuantity(text(formData, 'quantity').trim() || '0'),
        adjustmentDate: text(formData, 'adjustment_date').trim(),
      }),
    LIST,
  );
}
