'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import * as opening from '@/server/services/opening-stock';
import { OPENING_ROWS } from './rows';

const LIST = '/inventory/opening-stock';
const record = (documentNo: string) => `${LIST}/${encodeURIComponent(documentNo)}`;

/**
 * Opening Stock — Operations build, block 7: Item, Quantity, Total Price and
 * Warehouse; the Average Unit Price is the total over the quantity.
 *
 * The number is the system's (OPENING_STOCK). Save raises the document and
 * sends it for approval; approval brings the stock in and posts it.
 */
export async function createOpeningStock(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => {
      const documentDate = text(formData, 'document_date').trim();
      const lines = [];
      for (let row = 0; row < OPENING_ROWS; row += 1) {
        const itemCode = text(formData, `item_code_${row}`).trim();
        if (!itemCode) continue;
        const quantityText = text(formData, `quantity_${row}`).trim();
        const totalText = text(formData, `total_${row}`).trim();
        if (!quantityText || !totalText) {
          throw new Error(
            `Line ${row + 1} names ${itemCode} but not its quantity and total price. Complete it, or clear the item.`,
          );
        }
        const quantity = parseQuantity(quantityText);
        const total = parseDecimal(totalText, 4n);
        if (quantity <= 0n) throw new Error(`Line ${row + 1}: enter a quantity above zero.`);
        if (total < 0n) throw new Error(`Line ${row + 1}: the total price cannot be negative.`);
        lines.push({
          itemCode,
          quantity,
          // The item's own unit; `raise` reads it from the item.
          uomCode: '',
          // Average Unit Price = Total Price / Quantity, at money precision.
          unitCostIqd: (total * 1_000_000n) / quantity,
          costLayerDate: documentDate,
        });
      }
      if (lines.length === 0) throw new Error('Name at least one item.');
      return opening.raise(tx, ctx, {
        branchCode: ctx.branchCode,
        warehouseCode: text(formData, 'warehouse_code').trim(),
        documentDate,
        lines,
      });
    },
    (value) => {
      const created = value as { documentNo?: string } | undefined;
      return created?.documentNo ? record(created.documentNo) : LIST;
    },
  );
}

/** Approval brings the stock in and posts the opening journal. */
export async function approveOpeningStock(formData: FormData): Promise<void> {
  const documentNo = text(formData, 'document_no');
  await runAdminAndReturn(
    (tx, ctx) => opening.approve(tx, ctx, text(formData, 'id'), { post: true }),
    record(documentNo),
  );
}
