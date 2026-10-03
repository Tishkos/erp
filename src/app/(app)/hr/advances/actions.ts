'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as advances from '@/server/services/employee-advances';

/**
 * Advances & Loans — REQ-HR-001 Stage HR-4. The service holds every rule:
 * who endorses and approves, the schedule, what may be repaid.
 */
const LIST = '/hr/advances';
const record = (advanceNo: string) => `${LIST}/${encodeURIComponent(advanceNo)}`;

export async function createAdvance(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    advances.create(tx, ctx, {
      employeeId: text(form, 'employee_id'),
      kind: text(form, 'kind'),
      amount: text(form, 'amount'),
      instalments: text(form, 'instalments') || 1,
      firstRecoveryMonth: text(form, 'first_recovery_month') || null,
      reason: text(form, 'reason'),
    }),
  );
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.advanceNo)}?saved=1`);
}

export async function submitAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn((tx, ctx) => advances.submit(tx, ctx, advanceNo), record(advanceNo));
}

export async function endorseAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn((tx, ctx) => advances.endorse(tx, ctx, advanceNo, text(form, 'note') || null), record(advanceNo));
}

export async function approveAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn((tx, ctx) => advances.approve(tx, ctx, advanceNo), record(advanceNo));
}

export async function refuseAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn((tx, ctx) => advances.refuse(tx, ctx, advanceNo, text(form, 'note')), record(advanceNo));
}

export async function cancelAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn((tx, ctx) => advances.cancel(tx, ctx, advanceNo, text(form, 'reason')), record(advanceNo));
}

export async function payAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn(
    (tx, ctx) => advances.pay(tx, ctx, advanceNo, { bankCashAccountId: text(form, 'account_id'), on: text(form, 'paid_on'), reference: text(form, 'reference') || null }),
    record(advanceNo),
  );
}

export async function repayAdvance(form: FormData): Promise<void> {
  const advanceNo = text(form, 'advance_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      advances.repayInCash(tx, ctx, advanceNo, {
        amount: text(form, 'amount'),
        bankCashAccountId: text(form, 'account_id'),
        on: text(form, 'repaid_on'),
        reference: text(form, 'reference') || null,
      }),
    record(advanceNo),
  );
}
