'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseQuantity } from '@domain/uom';
import * as stock from '@/server/services/stock-operations';

const LIST = '/inventory/transfers';

/**
 * A transfer — Operations build, block 7. Its number is the system's
 * (WAREHOUSE_TRANSFER), so the form carries none and this reads none.
 */
export async function createTransfer(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      stock.transfer(tx, ctx, {
        itemCode: text(formData, 'item_code').trim(),
        fromWarehouseCode: text(formData, 'from_warehouse_code').trim(),
        toWarehouseCode: text(formData, 'to_warehouse_code').trim(),
        quantity: parseQuantity(text(formData, 'quantity').trim() || '0'),
        transferDate: text(formData, 'transfer_date').trim(),
      }),
    LIST,
  );
}
