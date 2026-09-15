'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import * as ar from '@/server/services/ar-invoice';
import { LINE_ROWS } from './lines';

const LIST = '/sales/ar-invoices';
const record = (invoiceNo: string) => `${LIST}/${encodeURIComponent(invoiceNo)}`;

/**
 * Reads the line grid.
 *
 * A row counts as written the moment it names an item, and the rest of it is
 * then required. A blank supplier is a real answer, not a missing one: it means
 * the oldest stock of any supplier, which is what FIFO does when nobody has
 * said whose pool to draw from.
 */
function linesFrom(formData: FormData): ar.DirectSalesLineInput[] {
  const lines: ar.DirectSalesLineInput[] = [];

  for (let row = 0; row < LINE_ROWS; row += 1) {
    const itemCode = text(formData, `item_code_${row}`).trim();
    if (!itemCode) continue;

    const quantity = text(formData, `quantity_${row}`).trim();
    const unitPrice = text(formData, `unit_price_${row}`).trim();
    const discount = text(formData, `discount_${row}`).trim();
    const warehouseCode = text(formData, `warehouse_code_${row}`).trim();
    const supplierId = text(formData, `supplier_id_${row}`).trim();

    if (!quantity || !unitPrice) {
      throw new Error(
        `Line ${row + 1} names ${itemCode} but has no quantity or unit price. Complete it, or clear the item to drop the line.`,
      );
    }
    if (!warehouseCode) {
      throw new Error(
        `Line ${row + 1} does not say which warehouse ${itemCode} is sold from. The stock has to leave somewhere.`,
      );
    }

    lines.push({
      itemCode,
      quantity: parseQuantity(quantity),
      unitPriceIqd: parseDecimal(unitPrice, 4n),
      ...(discount ? { discountIqd: parseDecimal(discount, 4n) } : {}),
      warehouseCode,
      ...(supplierId ? { supplierId } : {}),
    });
  }

  if (lines.length === 0) {
    throw new Error('An invoice with no lines bills for nothing. Name at least one item.');
  }
  return lines;
}

/** Raise the invoice — Operations block 5's direct sale. */
export async function createArInvoice(formData: FormData): Promise<void> {
  const outcome = await runAdmin(async (tx, ctx) => {
    const lines = linesFrom(formData);
    const dueDate = text(formData, 'due_date').trim();
    return ar.createDirect(tx, ctx, {
      customerId: text(formData, 'customer_id'),
      branchCode: ctx.branchCode,
      invoiceDate: text(formData, 'invoice_date'),
      ...(dueDate ? { dueDate } : {}),
      note: text(formData, 'note').trim() || null,
      lines,
    });
  });

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.invoiceNo));
}

/** *"The invoice is not posted until CEO approval."* Approval, then posting. */
export async function approveArInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn((tx, ctx) => ar.approve(tx, ctx, text(formData, 'id')), record(invoiceNo));
}

export async function postArInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn((tx, ctx) => ar.post(tx, ctx, text(formData, 'id')), record(invoiceNo));
}
