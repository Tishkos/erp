'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { rowCount, runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import * as attachments from '@/server/services/attachments';
import * as ap from '@/server/services/ap-invoice';
import * as inventory from '@/server/services/inventory';
import * as expenses from '@/server/services/expenses';
import { LINE_ROWS } from './lines';

const LIST = '/payables/invoices';
const record = (invoiceNo: string) => `${LIST}/${encodeURIComponent(invoiceNo)}`;

/**
 * Reads the line grid.
 *
 * A row counts as written the moment it names an item, and everything else on
 * it is then required — a row with an item and no quantity is somebody halfway
 * through typing, and posting it as a zero would be worse than telling them.
 *
 * How many rows there are is the form's answer, not this file's: the grid opens
 * a new line each time the current one is filled, so the count is whatever the
 * person typed by the time they pressed the button.
 */
function linesFrom(formData: FormData): ap.InvoiceLineInput[] {
  const lines: ap.InvoiceLineInput[] = [];
  const rows = rowCount(formData, LINE_ROWS);

  for (let row = 0; row < rows; row += 1) {
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
      // The item's own unit, sent with the line. Falling back to "each" was
      // wrong for anything measured in metres or kilogrammes.
      // REQ-FIX-001 FIX-4 — the line's unit; the item's purchase default when none is sent.
      uomCode: text(formData, `uom_code_${row}`).trim() || null,
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
      // Block 4's header is the invoice number, the two dates and the
      // supplier. The supplier's own number is not among them, and the column
      // is not nullable — so the service takes our number for it, which is
      // unique per supplier and keeps §15's duplicate control meaningful.
      supplierInvoiceNo: '',
      purchaseOrderId: null,
      branchCode: ctx.branchCode,
      invoiceDate: text(formData, 'invoice_date'),
      // Blank only when the browser could not fill it — no supplier terms were
      // on the page, or no JavaScript ran. The service then applies the
      // supplier's terms itself, by the same arithmetic the form uses (§16).
      dueDate: text(formData, 'due_date').trim() || undefined,
      note: null,
      // Where it posts, chosen on the form that raised it.
      payableAccountId: text(formData, 'payable_account_id').trim() || null,
      expenseAccountId: text(formData, 'expense_account_id').trim() || null,
      // D13 — the accountant ticked Import: the application is born with it.
      isImport: text(formData, 'is_import') === '1',
      // §24.3 — ticked Import and naming an open import: the invoice joins it.
      payableId: text(formData, 'is_import') === '1' ? text(formData, 'payable_id').trim() || null : null,
      paymentTermsText: text(formData, 'payment_terms_text').trim() || null,
      // REQ-PM-001 §8 — the element is "project|element"; the three together or none.
      projectCode: text(formData, 'project_element').split('|')[0]?.trim() || null,
      wbsCode: text(formData, 'project_element').split('|')[1]?.trim() || null,
      costCode: text(formData, 'project_cost_code').trim() || null,
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
    inventory.invoiceAvailability(tx, ctx, ap.PERMISSION_OBJECT, input),
  );
}

/**
 * One line of a draft, saved as it is left — by direction, 2026-09-16.
 *
 * With a `lineId` the line is changed in place; without one it is added. It
 * returns rather than redirects, so the grid stays where the person is typing
 * and refreshes its own figures.
 */
export async function saveApInvoiceLine(formData: FormData): Promise<LineOutcome> {
  const lineId = text(formData, 'lineId').trim();
  const discount = text(formData, 'discount').trim();

  const outcome = await runAdmin((tx, ctx) =>
    ap.saveLine(tx, ctx, text(formData, 'id'), lineId || null, {
      itemCode: text(formData, 'itemCode').trim(),
      quantity: parseQuantity(text(formData, 'quantity').trim()),
      unitPriceIqd: parseDecimal(text(formData, 'unitPrice').trim(), 4n),
      ...(discount ? { discountIqd: parseDecimal(discount, 4n) } : {}),
      warehouseCode: text(formData, 'warehouseCode').trim(),
      // REQ-FIX-001 FIX-4 — the unit chosen on the line; the item's purchase default when none.
      uomCode: text(formData, 'uomCode').trim() || null,
    }),
  );

  if (outcome.ok) revalidatePath(record(text(formData, 'invoice_no')));
  return outcome.ok
    ? { ok: true, lineNo: outcome.value!.lineNo }
    : { ok: false, error: outcome.error! };
}

/** Taking one line off a draft. The rest renumber; the total follows. */
export async function removeApInvoiceLine(formData: FormData): Promise<LineOutcome> {
  const outcome = await runAdmin((tx, ctx) =>
    ap.removeLine(tx, ctx, text(formData, 'id'), text(formData, 'lineId')),
  );
  if (outcome.ok) revalidatePath(record(text(formData, 'invoice_no')));
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error! };
}

/**
 * The accounts this invoice posts to, chosen on the document.
 *
 * Blank means "as configured": the supplier payable mapping, and the expense
 * mapping for a service line. A stock line is not offered — its debit is the
 * item's inventory account, so the warehouse and the ledger hold one figure.
 */
export async function saveApInvoiceAccounts(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      ap.setChosenAccounts(tx, ctx, text(formData, 'id'), {
        payableAccountId: text(formData, 'payable_account_id').trim() || null,
        expenseAccountId: text(formData, 'expense_account_id').trim() || null,
      }),
    record(invoiceNo),
  );
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

/**
 * Undo a posted invoice — journal, stock and status together, with a reason
 * (decided 2026-09-27). Refused while anything rests on it; the service says
 * what, and the message is shown as it is.
 */
export async function reverseApInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn(
    (tx, ctx) => ap.reverse(tx, ctx, text(formData, 'id'), { reason: text(formData, 'reason') }),
    record(invoiceNo),
  );
}

// ---------------------------------------------------------------------------
// D12 — expenses are purchase invoices: Add expense, Mark paid, Add note.
// ---------------------------------------------------------------------------

/** "Add expense" — the quick form on the Purchase Invoices list (§21.2). */
export async function addExpenseAction(formData: FormData): Promise<void> {
  const outcome = await runAdmin(async (tx, ctx) => {
    const amount = text(formData, 'amount').trim();
    if (!amount) throw new Error('Enter the amount on the bill.');
    return expenses.addExpense(tx, ctx, {
      expenseCategoryCode: text(formData, 'expense_category'),
      name: text(formData, 'name'),
      supplierId: text(formData, 'supplier_id'),
      branchCode: ctx.branchCode,
      amountIqd: parseDecimal(amount, 4n),
      invoiceDate: text(formData, 'invoice_date'),
      dueDate: text(formData, 'due_date'),
      supplierInvoiceNo: text(formData, 'supplier_invoice_no').trim() || null,
      chargedToPayableId: text(formData, 'charged_to').trim() || null,
    });
  });
  if (!outcome.ok) redirect(withQuery(`${LIST}?expense=1`, 'error', outcome.error!));
  redirect(record(outcome.value!.invoiceNo));
}

/** "Mark paid" — the payment for what is still owed, posted and allocated. */
export async function markPaidAction(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      expenses.markPaid(tx, ctx, {
        apInvoiceId: text(formData, 'id'),
        bankCashAccountId: text(formData, 'bank_cash_account_id'),
        paymentDate: text(formData, 'payment_date'),
        reference: text(formData, 'reference').trim() || null,
      }),
    record(invoiceNo),
  );
}

/** "Add note" — dated, signed, never edited. */
export async function addInvoiceNoteAction(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  await runAdminAndReturn(
    (tx, ctx) => expenses.addNote(tx, ctx, text(formData, 'id'), text(formData, 'note')),
    record(invoiceNo),
  );
}

/**
 * The supplier's own paperwork, kept against the invoice it proves — the
 * PDF from the factory, the packing list, the letter about a price.
 *
 * As many as anybody wants, and they stay: an attachment is never removed by
 * posting, reversing or linking the invoice to an import.
 */
export async function attachToInvoice(formData: FormData): Promise<void> {
  const invoiceNo = text(formData, 'invoice_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/payables/invoices/${encodeURIComponent(invoiceNo)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  await runAdminAndReturn(
    async (tx, ctx) => {
      const found = await ap.viewByNo(tx, invoiceNo);
      // `viewByNo` answers null for a number nobody holds; the redirect above
      // only guards the file, not the invoice.
      if (!found) redirect(`/payables/invoices/${encodeURIComponent(invoiceNo)}?error=not_found`);
      await attachments.upload(tx, ctx, {
        objectType: ap.PERMISSION_OBJECT,
        objectId: found.invoice.id,
        fileName: upload.name,
        content,
      });
      return found;
    },
    () => `/payables/invoices/${encodeURIComponent(invoiceNo)}?saved=1`,
  );
}

