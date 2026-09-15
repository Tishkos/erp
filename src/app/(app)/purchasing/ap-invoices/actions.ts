'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import * as ap from '@/server/services/ap-invoice';
import { LINE_ROWS } from './lines';

const LIST = '/purchasing/ap-invoices';
const record = (invoiceNo: string) => `${LIST}/${encodeURIComponent(invoiceNo)}`;

/**
 * Reads the line grid.
 *
 * A row counts as written the moment it names an item, and everything else on
 * it is then required — a row with an item and no quantity is somebody halfway
 * through typing, and posting it as a zero would be worse than telling them.
 */
function linesFrom(formData: FormData): ap.InvoiceLineInput[] {
  const lines: ap.InvoiceLineInput[] = [];

  for (let row = 0; row < LINE_ROWS; row += 1) {
    const itemCode = text(formData, `item_code_${row}`).trim();
    if (!itemCode) continue;

    const quantity = text(formData, `quantity_${row}`).trim();
    const unitPrice = text(formData, `unit_price_${row}`).trim();
    const discount = text(formData, `discount_${row}`).trim();
    const warehouseCode = text(formData, `warehouse_code_${row}`).trim();

    if (!quantity || !unitPrice) {
      throw new Error(
        `Line ${row + 1} names ${itemCode} but has no quantity or unit price. Complete it, or clear the item to drop the line.`,
      );
    }
    if (!warehouseCode) {
      throw new Error(
        `Line ${row + 1} does not say which warehouse ${itemCode} arrives in. A purchase invoice puts the goods somewhere.`,
      );
    }

    lines.push({
      itemCode,
      description: text(formData, `description_${row}`).trim() || null,
      quantity: parseQuantity(quantity),
      unitPriceIqd: parseDecimal(unitPrice, 4n),
      ...(discount ? { discountIqd: parseDecimal(discount, 4n) } : {}),
      uomCode: text(formData, `uom_code_${row}`).trim() || 'EA',
      isInventory: true,
      warehouseCode,
    });
  }

  if (lines.length === 0) {
    throw new Error('An invoice with no lines bills for nothing. Name at least one item.');
  }
  return lines;
}

/**
 * Raise the invoice — Operations block 4.
 *
 * No purchase order, because the sponsor's invoice is the first document in the
 * chain: it brings the goods in itself and names the warehouse each line lands
 * in. §15 asks a non-PO invoice for a justification and a second approver; an
 * invoice that receives its own stock already carries the receipt evidence §15
 * wants, and what remains is held by "not posted until CEO approval".
 */
export async function createApInvoice(formData: FormData): Promise<void> {
  const outcome = await runAdmin(async (tx, ctx) => {
    const lines = linesFrom(formData);
    return ap.create(tx, ctx, {
      supplierId: text(formData, 'supplier_id'),
      supplierInvoiceNo: text(formData, 'supplier_invoice_no').trim(),
      purchaseOrderId: null,
      branchCode: ctx.branchCode,
      invoiceDate: text(formData, 'invoice_date'),
      dueDate: text(formData, 'due_date'),
      note: text(formData, 'note').trim() || null,
      lines,
    });
  });

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.invoiceNo));
}

/** Appendix B's *Pending Approval* — the invoice leaves the clerk's hands. */
export async function submitApInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn(
    (tx, ctx) => ap.submit(tx, ctx, text(formData, 'id')),
    record(invoiceNo),
  );
}

/**
 * *"The invoice is not posted until CEO approval."*
 *
 * Posting is the approval: the service refuses anyone without the `post` verb,
 * and a clerk who raised the invoice cannot be the person who posts it.
 */
export async function postApInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn((tx, ctx) => ap.post(tx, ctx, text(formData, 'id')), record(invoiceNo));
}
