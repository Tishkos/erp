'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as payroll from '@/server/services/payroll';

/**
 * Payroll — REQ-HR-001 Stage HR-3. The service holds every rule: who is
 * paid, what each line comes to, who may approve, post, pay and reverse.
 */
const LIST = '/hr/payroll';
const record = (runNo: string) => `${LIST}/${encodeURIComponent(runNo)}`;

export async function createPayrollRun(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    payroll.create(tx, ctx, {
      branchCode: text(form, 'branch'),
      month: text(form, 'month'),
      payDate: text(form, 'pay_date') || null,
      note: text(form, 'note') || null,
    }),
  );
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.runNo)}?saved=1`);
}

export async function updatePayrollDraft(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.updateDraft(tx, ctx, runNo, { payDate: text(form, 'pay_date'), note: text(form, 'note') || null }), record(runNo));
}

export async function recomputePayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.recompute(tx, ctx, runNo), record(runNo));
}

/** The manual components typed on the draft's lines, one row per person: `<code>_<i>` and `note_<i>`. */
export async function savePayrollTyped(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  const rows = Number(text(form, 'rows')) || 0;
  const codes = text(form, 'codes')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  const entries: payroll.TypedInput[] = [];
  for (let index = 0; index < rows; index += 1) {
    const employeeId = text(form, `employee_${index}`);
    if (!employeeId) continue;
    const note = text(form, `note_${index}`) || null;
    for (const code of codes) {
      const amount = text(form, `${code}_${index}`);
      // The row's note explains its figures; a component left at nothing carries none.
      entries.push({ employeeId, componentCode: code, amount, note: /^\s*0*(\.0*)?\s*$/.test(amount) ? null : note });
    }
  }
  await runAdminAndReturn((tx, ctx) => payroll.saveTyped(tx, ctx, runNo, entries), record(runNo));
}

export async function submitPayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.submit(tx, ctx, runNo), record(runNo));
}

export async function returnPayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.returnToDraft(tx, ctx, runNo, text(form, 'note')), record(runNo));
}

export async function approvePayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.approve(tx, ctx, runNo), record(runNo));
}

export async function postPayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.post(tx, ctx, runNo), record(runNo));
}

export async function payPayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      payroll.pay(tx, ctx, runNo, {
        payMethod: text(form, 'pay_method'),
        bankCashAccountId: text(form, 'account_id'),
        paidOn: text(form, 'paid_on'),
        reference: text(form, 'reference') || null,
      }),
    record(runNo),
  );
}

export async function reversePayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.reverse(tx, ctx, runNo, text(form, 'reason')), record(runNo));
}

export async function cancelPayroll(form: FormData): Promise<void> {
  const runNo = text(form, 'run_no');
  await runAdminAndReturn((tx, ctx) => payroll.cancel(tx, ctx, runNo, text(form, 'reason')), record(runNo));
}
