'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as payments from '@/server/services/expense-payment';

const LIST = '/treasury/expense-payments';
const record = (paymentNo: string) => `${LIST}/${encodeURIComponent(paymentNo)}`;

/** Who was paid, for what, from which account, charged to which expense account. */
export async function createExpensePayment(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    payments.create(tx, ctx, {
      bankCashAccountId: text(formData, 'bank_cash_account_id'),
      branchCode: ctx.branchCode,
      paymentDate: text(formData, 'payment_date'),
      amount: parseDecimal(text(formData, 'amount').trim() || '0', 4n),
      expenseAccountId: text(formData, 'expense_account_id'),
      departmentCode: text(formData, 'department_code') || null,
      paymentMethodCode: text(formData, 'payment_method_code') || null,
      payee: text(formData, 'payee'),
      purpose: text(formData, 'purpose'),
      reference: text(formData, 'reference') || null,
      note: text(formData, 'note') || null,
    }),
  );
  if (!outcome.ok) redirect(withQuery(`${LIST}/new`, 'error', outcome.error!));
  redirect(record(outcome.value!.paymentNo));
}

export async function approvePostExpensePayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.approveAndPost(tx, ctx, text(formData, 'id')), record(text(formData, 'payment_no')));
}

export async function postExpensePayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.post(tx, ctx, text(formData, 'id')), record(text(formData, 'payment_no')));
}

export async function cancelExpensePayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.cancel(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(text(formData, 'payment_no')));
}

export async function reverseExpensePayment(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => payments.reverse(tx, ctx, text(formData, 'id'), text(formData, 'reason')), record(text(formData, 'payment_no')));
}
