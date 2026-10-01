'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseQuantity } from '@domain/uom';
import * as gr from '@/server/services/goods-return';
import { LINE_ROWS } from './lines';

const LIST = '/payables/goods-returns';
const record = (returnNo: string) => `${LIST}/${encodeURIComponent(returnNo)}`;

/**
 * Raise the return — Operations block 10.
 *
 * The offset is the mirror of block 9's and the sign is the other way round:
 * Accounts Payable Dr. when the debt shrinks, Bank Dr. when the supplier sends
 * the money back. The service refuses the half-chosen shapes with a sentence.
 */
export async function createGoodsReturn(formData: FormData): Promise<void> {
  const outcome = await runAdmin(async (tx, ctx) => {
    const lines: { apInvoiceLineId: string; quantity: bigint; warehouseCode: string | null }[] = [];
    for (let row = 0; row < LINE_ROWS; row += 1) {
      const lineId = text(formData, `ap_invoice_line_id_${row}`).trim();
      const quantity = text(formData, `quantity_${row}`).trim();
      if (!lineId || !quantity || Number(quantity) === 0) continue;
      lines.push({
        apInvoiceLineId: lineId,
        quantity: parseQuantity(quantity),
        // Block 10 — the warehouse the goods go back out of.
        warehouseCode: text(formData, `warehouse_code_${row}`).trim() || null,
      });
    }

    const offsetKind = text(formData, 'offset_kind').trim() === 'bank' ? 'bank' : 'payable';
    const bank = text(formData, 'offset_bank_account_id').trim();

    return gr.createFromInvoice(tx, ctx, {
      apInvoiceId: text(formData, 'ap_invoice_id'),
      returnDate: text(formData, 'return_date'),
      reason: text(formData, 'reason'),
      offsetKind,
      ...(offsetKind === 'bank' ? { offsetBankAccountId: bank } : {}),
      lines,
    });
  });

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.returnNo));
}

export async function approveGoodsReturn(formData: FormData): Promise<void> {
  const returnNo = text(formData, 'return_no');
  await runAdminAndReturn(
    (tx, ctx) => gr.approve(tx, ctx, text(formData, 'id')),
    record(returnNo),
  );
}

/** The goods leave, at the cost they came in on, and Inventory is credited. */
export async function postGoodsReturn(formData: FormData): Promise<void> {
  const returnNo = text(formData, 'return_no');
  await runAdminAndReturn((tx, ctx) => gr.post(tx, ctx, text(formData, 'id')), record(returnNo));
}
