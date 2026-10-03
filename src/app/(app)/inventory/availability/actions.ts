'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseQuantity } from '@/server/domain/uom';
import { businessToday } from '@/server/domain/business-date';
import { eq } from 'drizzle-orm';
import { warehouse } from '@/server/db/schema';
import * as inventory from '@/server/services/inventory';

/**
 * Issue stock — Phase 04.4's UI gate (*"an issue exceeding available stock is
 * rejected via the UI"*), now from a dialog on the Availability register. It
 * calls the same `inventory.issue` the API and the import call; the refusal
 * comes back as the service wrote it, figures and correction included.
 */
export async function issueStock(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => {
      const batchNumber = text(formData, 'batch_number');
      const warehouseCode = text(formData, 'warehouse_code');
      // A movement carries its warehouse's branch (0215), not the screen's.
      const [held] = await tx.select({ branchCode: warehouse.branchCode }).from(warehouse).where(eq(warehouse.code, warehouseCode)).limit(1);
      return inventory.issue(tx, ctx, {
        itemCode: text(formData, 'item_code'),
        warehouseCode,
        branchCode: held?.branchCode ?? ctx.branchCode,
        quantity: parseQuantity(text(formData, 'quantity')),
        movementDate: businessToday(),
        ...(batchNumber ? { batchNumber } : {}),
      });
    },
    (value) => (value === undefined ? '/inventory/availability?issue=1' : '/inventory/availability'),
  );
}
