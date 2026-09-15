'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as payments from '@/server/services/supplier-payment';

const LIST = '/purchasing/supplier-payments';
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
