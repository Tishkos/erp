'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as payments from '@/server/services/customer-payment';

const LIST = '/sales/customer-payments';
const record = (paymentNo: string) => `${LIST}/${encodeURIComponent(paymentNo)}`;

/** Customer, account, date, amount (in the account's currency), what it is for. */
export async function createCustomerPayment(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    payments.create(tx, ctx, {
      customerId: text(formData, 'customer_id'),
      bankCashAccountId: text(formData, 'bank_cash_account_id'),
      branchCode: ctx.branchCode,
      paymentDate: text(formData, 'payment_date'),
      amount: parseDecimal(text(formData, 'amount').trim() || '0', 4n),
      paymentMethodCode: text(formData, 'payment_method_code') || null,
      purpose: text(formData, 'purpose'),
      reference: text(formData, 'reference') || null,
      note: text(formData, 'note') || null,
    }),
  );
  if (!outcome.ok) {
    const customer = text(formData, 'customer_id');
    redirect(withQuery(`${LIST}/new${customer ? `?customer=${encodeURIComponent(customer)}` : ''}`, 'error', outcome.error!));
  }
  redirect(record(outcome.value!.paymentNo));
}

/** The approver's one press: approved, then posted. */
export async function approvePostCustomerPayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.approveAndPost(tx, ctx, text(formData, 'id')), record(text(formData, 'payment_no')));
}

/** An approved payment whose approver could not post it. */
export async function postCustomerPayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.post(tx, ctx, text(formData, 'id')), record(text(formData, 'payment_no')));
}

export async function cancelCustomerPayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.cancel(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(text(formData, 'payment_no')));
}

export async function reverseCustomerPayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.reverse(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(text(formData, 'payment_no')));
}
