'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as notes from '@/server/services/supplier-notes';

/**
 * Supplier Credit / Debit Notes — REQ-PAY-001 PAY8 / PAY9 (2026-10-04).
 *
 * A credit note is raised as a draft, approved by somebody other than its
 * raiser, posted (Dr Supplier A/P / Cr purchase variance or the account it
 * names) and applied to its invoice; what is left is applied later to another
 * of the supplier's invoices. A posted note is reversed, never edited. A
 * debit note is a purchase invoice (D-PAY-2): it is raised here and opens on
 * the invoice register, where the AP engine approves, posts and pays it.
 */
const LIST = '/payables/credit-memos';
const record = (memoNo: string) => `${LIST}/${encodeURIComponent(memoNo)}`;
const iqd = (value: string) => parseDecimal(value.trim() || '0', 4n);

export async function createCreditNoteAction(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    notes.createCreditNote(tx, ctx, {
      apInvoiceId: text(formData, 'ap_invoice_id'),
      supplierMemoNo: text(formData, 'supplier_memo_no').trim() || null,
      memoDate: text(formData, 'memo_date'),
      amountIqd: iqd(text(formData, 'amount_iqd')),
      reason: text(formData, 'reason'),
      creditAccountId: text(formData, 'credit_account_id').trim() || null,
    }),
  );
  if (!outcome.ok) redirect(withQuery(LIST, 'error', outcome.error!));
  redirect(record(outcome.value!.memoNo));
}

export async function createDebitNoteAction(formData: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    notes.createDebitNote(tx, ctx, {
      adjustsInvoiceId: text(formData, 'ap_invoice_id'),
      supplierNoteNo: text(formData, 'supplier_note_no').trim() || null,
      noteDate: text(formData, 'note_date'),
      amountIqd: iqd(text(formData, 'amount_iqd')),
      reason: text(formData, 'reason'),
      expenseAccountId: text(formData, 'expense_account_id').trim() || null,
      dueDate: text(formData, 'due_date').trim() || null,
    }),
  );
  if (!outcome.ok) redirect(withQuery(LIST, 'error', outcome.error!));
  // The debit note is a purchase invoice; it opens where every invoice opens.
  redirect(`/payables/invoices/${encodeURIComponent(outcome.value!.invoiceNo)}`);
}

export async function approveCreditNoteAction(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => notes.approveCreditNote(tx, ctx, text(formData, 'id')), record(text(formData, 'memo_no')));
}

export async function postCreditNoteAction(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => notes.postCreditNote(tx, ctx, text(formData, 'id')), record(text(formData, 'memo_no')));
}

export async function cancelCreditNoteAction(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => notes.cancelCreditNote(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(text(formData, 'memo_no')),
  );
}

export async function reverseCreditNoteAction(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => notes.reverseCreditNote(tx, ctx, text(formData, 'id'), { reason: text(formData, 'reason') }),
    record(text(formData, 'memo_no')),
  );
}

export async function applyCreditAction(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      notes.applyCredit(tx, ctx, {
        memoId: text(formData, 'id'),
        apInvoiceId: text(formData, 'ap_invoice_id'),
        amountIqd: iqd(text(formData, 'amount_iqd')),
      }),
    record(text(formData, 'memo_no')),
  );
}
