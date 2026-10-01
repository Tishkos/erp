'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseDecimal } from '@/server/domain/money';
import * as advances from '@/server/services/supplier-advance';

/** Supplier advances — §8.5, and REQ-AP-001 §21.1's Advances screen. */
const LIST = '/payables/advances';
const record = (advanceNo: string) => `${LIST}/${encodeURIComponent(advanceNo)}`;

export async function requestAdvance(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => {
      const amount = text(formData, 'amount').replace(/[,\s]/g, '');
      if (!/^\d+(\.\d{1,4})?$/.test(amount)) throw new Error('State the amount of the advance in IQD.');
      return advances.request(tx, ctx, {
        purchaseOrderId: text(formData, 'purchase_order_id'),
        branchCode: text(formData, 'branch_code') || ctx.branchCode,
        requestDate: text(formData, 'request_date'),
        amountIqd: parseDecimal(amount, 4n),
        reason: text(formData, 'reason') || null,
      });
    },
    (value) => {
      const created = value as { advanceNo?: string } | null | undefined;
      return created?.advanceNo ? record(created.advanceNo) : `${LIST}?advance=1`;
    },
  );
}

export async function approveAdvance(formData: FormData): Promise<void> {
  const advanceNo = text(formData, 'advance_no');
  await runAdminAndReturn((tx, ctx) => advances.approve(tx, ctx, text(formData, 'id')), record(advanceNo));
}

export async function payAdvance(formData: FormData): Promise<void> {
  const advanceNo = text(formData, 'advance_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      advances.pay(
        tx,
        ctx,
        text(formData, 'id'),
        text(formData, 'paid_date'),
        text(formData, 'bank_cash_account_id') || null,
      ),
    record(advanceNo),
  );
}
