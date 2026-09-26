'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseQuantity } from '@domain/uom';
import * as sr from '@/server/services/sales-return';
import { LINE_ROWS } from './lines';

const LIST = '/sales/sales-returns';
const record = (returnNo: string) => `${LIST}/${encodeURIComponent(returnNo)}`;

/**
 * Raise the return — Operations block 9.
 *
 * The offset is read as the sponsor wrote it: Accounts Receivable or Bank, one
 * of them, and the bank account only when Bank was chosen. The service refuses
 * the half-chosen shapes with a sentence, so nothing is guessed here.
 */
export async function createSalesReturn(formData: FormData): Promise<void> {
  const outcome = await runAdmin(async (tx, ctx) => {
    const lines: { arInvoiceLineId: string; quantity: bigint }[] = [];
    for (let row = 0; row < LINE_ROWS; row += 1) {
      const lineId = text(formData, `ar_invoice_line_id_${row}`).trim();
      const quantity = text(formData, `quantity_${row}`).trim();
      if (!lineId || !quantity || Number(quantity) === 0) continue;
      lines.push({ arInvoiceLineId: lineId, quantity: parseQuantity(quantity) });
    }

    const offsetKind = text(formData, 'offset_kind').trim() === 'bank' ? 'bank' : 'receivable';
    const bank = text(formData, 'offset_bank_account_id').trim();

    return sr.request(tx, ctx, {
      arInvoiceId: text(formData, 'ar_invoice_id'),
      requestedOn: text(formData, 'requested_on'),
      reason: text(formData, 'reason'),
      offsetKind,
      // Sent only on the Bank route. A bank id riding along with a receivable
      // offset is refused by the service, and rightly — it would mean two
      // answers to a question with one.
      ...(offsetKind === 'bank' ? { offsetBankAccountId: bank } : {}),
      lines,
    });
  });

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.returnNo));
}

/** Appendix B — Received. The goods are physically back. */
export async function receiveReturn(formData: FormData): Promise<void> {
  const returnNo = text(formData, 'return_no');
  const id = text(formData, 'id');
  await runAdminAndReturn(async (tx, ctx) => {
    const document = await sr.view(tx, id);
    return sr.receiveGoods(tx, ctx, id, {
      receivedOn: text(formData, 'received_on'),
      lines: document.lines.map((line) => ({
        salesReturnLineId: line.id,
        quantity: parseQuantity(line.requestedQuantity),
      })),
    });
  }, record(returnNo));
}

/**
 * Appendix B — Inspected, then Accepted.
 *
 * The whole quantity, into the warehouse chosen on each line — block 9 asks
 * for one warehouse per line and nothing about splitting a return between
 * dispositions. Quarantine and damaged-goods routing exists in the service for
 * §7.5 and is not part of what the sponsor asked for here.
 */
export async function acceptReturn(formData: FormData): Promise<void> {
  const returnNo = text(formData, 'return_no');
  const id = text(formData, 'id');

  await runAdminAndReturn(async (tx, ctx) => {
    // One step for the person accepting: goods that were raised as a return
    // and are being accepted have, by that act, been received. Block 9
    // describes one return document, not a receive-then-accept workflow.
    const raised = await sr.view(tx, id);
    if (raised.status === 'submitted') {
      await sr.receiveGoods(tx, ctx, id, {
        receivedOn: new Date().toISOString().slice(0, 10),
        lines: raised.lines.map((line) => ({
          salesReturnLineId: line.id,
          quantity: parseQuantity(line.requestedQuantity),
        })),
      });
    }
    const document = await sr.view(tx, id);
    await sr.inspect(
      tx,
      ctx,
      id,
      document.lines.map((line) => ({
        salesReturnLineId: line.id,
        acceptedQuantity: parseQuantity(line.receivedQuantity ?? line.requestedQuantity),
        disposition: 'saleable' as const,
        // The warehouse chosen on the line (block 9).
        destinationWarehouseCode: text(formData, `warehouse_code_${line.id}`).trim(),
      })),
    );
    // The goods back on the shelf and the customer credited, together —
    // block 9's journal is one act, not two.
    return sr.acceptAndSettle(tx, ctx, id);
  }, record(returnNo));
}

export async function rejectReturn(formData: FormData): Promise<void> {
  const returnNo = text(formData, 'return_no');
  await runAdminAndReturn(
    (tx, ctx) => sr.reject(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(returnNo),
  );
}
