'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as receipts from '@/server/services/customer-receipt';

const LIST = '/sales/customer-receipts';
const record = (receiptNo: string) => `${LIST}/${encodeURIComponent(receiptNo)}`;

/** Block 6's Receipt — customer, bank or cash account, date, amount, reference. */
export async function createReceipt(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    receipts.create(tx, ctx, {
      customerId: text(formData, 'customer_id') || null,
      branchCode: ctx.branchCode,
      receiptDate: text(formData, 'receipt_date'),
      bankCashAccountId: text(formData, 'bank_cash_account_id'),
      amountIqd: parseDecimal(text(formData, 'amount_iqd').trim() || '0', 4n),
      bankReference: text(formData, 'bank_reference').trim() || null,
    }),
  );

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.receiptNo));
}

export async function approveReceipt(formData: FormData): Promise<void> {
  const receiptNo = text(formData, 'receipt_no');
  await runAdminAndReturn(
    (tx, ctx) => receipts.approve(tx, ctx, text(formData, 'id')),
    record(receiptNo),
  );
}

/** Bank or Cash Dr. / Accounts Receivable Cr. */
export async function postReceipt(formData: FormData): Promise<void> {
  const receiptNo = text(formData, 'receipt_no');
  await runAdminAndReturn(
    (tx, ctx) => receipts.post(tx, ctx, text(formData, 'id')),
    record(receiptNo),
  );
}

/**
 * *"Receipts can be allocated to the related customer invoice, including
 * partial receipt."*
 *
 * The service takes a list, so one row of the table is a list of one. Partial
 * is the ordinary case and the amount comes from the box rather than being
 * assumed.
 */
export async function allocateReceipt(formData: FormData): Promise<void> {
  const receiptNo = text(formData, 'receipt_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      receipts.allocate(tx, ctx, text(formData, 'id'), [
        {
          arInvoiceId: text(formData, 'ar_invoice_id'),
          amountIqd: parseDecimal(text(formData, 'amount_iqd').trim() || '0', 4n),
        },
      ]),
    record(receiptNo),
  );
}
