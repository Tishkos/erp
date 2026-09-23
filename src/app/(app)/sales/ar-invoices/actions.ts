'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { rowCount, runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import * as ar from '@/server/services/ar-invoice';
import * as inventory from '@/server/services/inventory';
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
 *
 * How many rows there are is the form's answer, not this file's: the grid opens
 * a new line each time the current one is filled, so the count is whatever the
 * person typed by the time they pressed the button.
 */
function linesFrom(formData: FormData): ar.DirectSalesLineInput[] {
  const lines: ar.DirectSalesLineInput[] = [];
  const rows = rowCount(formData, LINE_ROWS);

  for (let row = 0; row < rows; row += 1) {
    const itemCode = text(formData, `item_code_${row}`).trim();
    if (!itemCode) continue;

    const quantity = text(formData, `quantity_${row}`).trim();
    const unitPrice = text(formData, `unit_price_${row}`).trim();
    const discount = text(formData, `discount_${row}`).trim();
    const warehouseCode = text(formData, `warehouse_code_${row}`).trim();
    const supplierId = text(formData, `supplier_id_${row}`).trim();
    // The item's own unit, sent with the line rather than assumed to be each.
    const uomCode = text(formData, `uom_code_${row}`).trim();

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
      ...(uomCode ? { uomCode } : {}),
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
      // Block 5's header is the invoice number, the two dates and the
      // customer. There is no note among them.
      note: null,
      lines,
    });
  });

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.invoiceNo));
}

/** What the grid hears back: it happened, or why it did not. */
export interface LineOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly lineNo?: number;
}

export async function invoiceLineAvailability(input: {
  itemCode: string;
  warehouseCode: string;
  supplierId?: string | null;
}) {
  return runAdmin((tx, ctx) =>
    inventory.invoiceAvailability(tx, ctx, ar.PERMISSION_OBJECT, input),
  );
}

/**
 * One line of a draft, saved as it is left — by direction, 2026-09-16.
 *
 * With a `lineId` the line is changed in place; without one it is added. A
 * blank supplier stays a real answer: the oldest stock of any supplier.
 */
export async function saveArInvoiceLine(formData: FormData): Promise<LineOutcome> {
  const lineId = text(formData, 'lineId').trim();
  const discount = text(formData, 'discount').trim();
  const supplierId = text(formData, 'supplierId').trim();

  const outcome = await runAdmin((tx, ctx) =>
    ar.saveLine(tx, ctx, text(formData, 'id'), lineId || null, {
      itemCode: text(formData, 'itemCode').trim(),
      quantity: parseQuantity(text(formData, 'quantity').trim()),
      unitPriceIqd: parseDecimal(text(formData, 'unitPrice').trim(), 4n),
      ...(discount ? { discountIqd: parseDecimal(discount, 4n) } : {}),
      warehouseCode: text(formData, 'warehouseCode').trim(),
      ...(supplierId ? { supplierId } : {}),
    }),
  );

  if (outcome.ok) revalidatePath(record(text(formData, 'invoice_no')));
  return outcome.ok
    ? { ok: true, lineNo: outcome.value!.lineNo }
    : { ok: false, error: outcome.error! };
}

/** Taking one line off a draft. The rest renumber; the total follows. */
export async function removeArInvoiceLine(formData: FormData): Promise<LineOutcome> {
  const outcome = await runAdmin((tx, ctx) =>
    ar.removeLine(tx, ctx, text(formData, 'id'), text(formData, 'lineId')),
  );
  if (outcome.ok) revalidatePath(record(text(formData, 'invoice_no')));
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error! };
}

/** *"The invoice is not posted until CEO approval."* Approval, then posting. */
export async function approveArInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn((tx, ctx) => ar.approve(tx, ctx, text(formData, 'id')), record(invoiceNo));
}

/**
 * The accounts this invoice posts to, chosen on the document.
 *
 * Blank means "as configured" — the mapping for the statement side, the
 * item's own account then the mapping for the income — so clearing a field is
 * how somebody takes the exception back off.
 */
export async function saveArInvoiceAccounts(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      ar.setChosenAccounts(tx, ctx, text(formData, 'id'), {
        receivableAccountId: text(formData, 'receivable_account_id').trim() || null,
        revenueAccountId: text(formData, 'revenue_account_id').trim() || null,
      }),
    record(text(formData, 'invoice_no')),
  );
}

export async function returnArInvoiceToDraft(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => ar.returnToDraft(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(text(formData, 'invoice_no')),
  );
}

export async function postArInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn((tx, ctx) => ar.post(tx, ctx, text(formData, 'id')), record(invoiceNo));
}
