'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import { parseDecimal } from '@/server/domain/money';
import * as deposits from '@/server/services/bank-deposits';

/** Bank deposits — REQ-FIX-001 FIX-1 (D-FX-2). */
const LIST = '/treasury/deposits';
const record = (no: string) => `${LIST}/${encodeURIComponent(no)}`;

function amountOf(formData: FormData, name = 'amount'): bigint {
  const amount = text(formData, name).replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,4})?$/.test(amount)) throw new Error('State the amount deposited.');
  return parseDecimal(amount, 4n);
}

export async function depositCash(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      deposits.depositCash(tx, ctx, {
        intoAccountId: text(formData, 'into_account_id'),
        fromCashAccountId: text(formData, 'from_cash_account_id'),
        depositDate: text(formData, 'deposit_date'),
        amount: amountOf(formData),
        reference: text(formData, 'reference') || null,
        note: text(formData, 'note') || null,
      }),
    (value) => {
      const made = value as { no?: string } | null | undefined;
      return made?.no ? record(made.no) : `${LIST}?deposit=cash`;
    },
  );
}

export async function depositOther(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      deposits.depositOther(tx, ctx, {
        intoAccountId: text(formData, 'other_into_account_id'),
        creditAccountId: text(formData, 'credit_account_id'),
        payer: text(formData, 'payer'),
        depositDate: text(formData, 'other_deposit_date'),
        amount: amountOf(formData, 'other_amount'),
        reference: text(formData, 'other_reference') || null,
        note: text(formData, 'other_note') || null,
      }),
    (value) => {
      const made = value as { no?: string } | null | undefined;
      return made?.no ? record(made.no) : `${LIST}?deposit=other`;
    },
  );
}

/**
 * The slip the bank gave for a deposit — by direction, 2026-10-04.
 *
 * A deposit is not its own table: the cash one is a `bank_transfer` and the
 * bank one an `other_receipt`, so the file hangs on whichever it is. The
 * attachment rules are registered lazily, so a cold process is told about them
 * before it is handed the first file.
 */
export async function attachToDeposit(formData: FormData): Promise<void> {
  const no = text(formData, 'deposit_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(no)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const deposit = await deposits.byNo(tx, no);
    await attachments.upload(tx, ctx, {
      objectType: deposit.source === 'cash' ? 'bank_transfer' : 'other_receipt',
      objectId: deposit.id,
      fileName: upload.name,
      content,
    });
    return deposit;
  }, record(no));
}

export async function approveDeposit(formData: FormData): Promise<void> {
  const no = text(formData, 'deposit_no');
  await runAdminAndReturn((tx, ctx) => deposits.approve(tx, ctx, no), record(no));
}

export async function postDeposit(formData: FormData): Promise<void> {
  const no = text(formData, 'deposit_no');
  await runAdminAndReturn((tx, ctx) => deposits.post(tx, ctx, no), record(no));
}
