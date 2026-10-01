'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as payments from '@/server/services/supplier-payment';

const LIST = '/payables/supplier-payments';
const record = (paymentNo: string) => `${LIST}/${encodeURIComponent(paymentNo)}`;

/** Block 6's Payment — supplier, bank or cash account, date, amount, reference. */
export async function createPayment(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    payments.create(tx, ctx, {
      supplierId: text(formData, 'supplier_id'),
      bankCashAccountId: text(formData, 'bank_cash_account_id'),
      branchCode: ctx.branchCode,
      paymentDate: text(formData, 'payment_date'),
      amountIqd: parseDecimal(text(formData, 'amount_iqd').trim() || '0', 4n),
      reference: text(formData, 'reference').trim() || null,
    }),
  );

  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.paymentNo));
}

/**
 * *"Payments can be allocated to the related supplier invoice, including
 * partial payment."*
 *
 * One invoice at a time, and the amount is the person's: a partial payment is
 * the ordinary case, not an exception, so nothing here assumes the whole
 * balance. The service refuses more than is outstanding.
 */
export async function allocatePayment(formData: FormData): Promise<void> {
  const paymentNo = text(formData, 'payment_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      payments.allocate(tx, ctx, {
        supplierPaymentId: text(formData, 'id'),
        apInvoiceId: text(formData, 'ap_invoice_id'),
        amountIqd: parseDecimal(text(formData, 'amount_iqd').trim() || '0', 4n),
      }),
    record(paymentNo),
  );
}

/** Accounts Payable Dr. / Bank or Cash Cr. */
export async function postPayment(formData: FormData): Promise<void> {
  const paymentNo = text(formData, 'payment_no');
  await runAdminAndReturn(
    (tx, ctx) => payments.post(tx, ctx, text(formData, 'id')),
    record(paymentNo),
  );
}

/**
 * Oldest invoice first, in one act.
 *
 * The mirror of the receipt side: money going out clears the oldest debt
 * first, so a payment of 100,000 against a 50,000 invoice from Monday and a
 * 100,000 from Tuesday settles Monday and half-pays Tuesday. A supplier who
 * says which invoice a payment is for is still answered by the boxes.
 */
export async function allocateOldestFirstPayment(formData: FormData): Promise<void> {
  const paymentNo = text(formData, 'payment_no');
  await runAdminAndReturn(
    (tx, ctx) => payments.allocateOldestFirst(tx, ctx, text(formData, 'id')),
    record(paymentNo),
  );
}
