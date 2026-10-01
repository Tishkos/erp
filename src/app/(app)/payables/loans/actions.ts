'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseDecimal } from '@/server/domain/money';
import * as attachments from '@/server/services/attachments';
import * as loans from '@/server/services/loans';

/**
 * Bank loans — REQ-AP-001 §15.7, §21.10. Every verb is the service's; these
 * only read the form and say where to come back to.
 */
const LIST = '/payables/loans';
const record = (loanNo: string) => `${LIST}/${encodeURIComponent(loanNo)}`;

/** Amount as typed ("3,500.00") at the money scale; null when blank. */
function amountOf(value: string): bigint | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) {
    throw new loans.LoanError(`"${value}" is not an amount.`);
  }
  return parseDecimal(cleaned, 4n);
}

export async function createLoan(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) =>
      loans.create(tx, ctx, {
        bankCode: text(formData, 'bank_code'),
        bankCashAccountId: text(formData, 'bank_cash_account_id'),
        principalTxn: amountOf(text(formData, 'principal')) ?? 0n,
        commissionPct: text(formData, 'commission_pct') || null,
        commissionTxn: amountOf(text(formData, 'commission_amount')),
        commissionTreatmentCode: text(formData, 'commission_treatment'),
        commissionCapitalised: formData.get('commission_capitalised') !== null,
        interestPctPa: text(formData, 'interest_pct') || null,
        allocationMethod: text(formData, 'allocation_method') || null,
        instalmentCount: Number(text(formData, 'instalment_count')) || 0,
        frequency: text(formData, 'frequency'),
        firstDueDate: text(formData, 'first_due_date'),
        customDates: text(formData, 'custom_dates')
          .split(/[\s,;]+/)
          .map((date) => date.trim())
          .filter(Boolean),
        purpose: text(formData, 'purpose') || null,
      }),
    (value) => {
      const created = value as { loanNo?: string } | null | undefined;
      return created?.loanNo ? record(created.loanNo) : LIST;
    },
  );
}

/** The schedule dialog's rows: due date, principal, interest, commission. */
export async function setScheduleAction(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  const count = Number(text(formData, 'row_count')) || 0;
  await runAdminAndReturn(async (tx, ctx) => {
    const rows: loans.ScheduleRowInput[] = [];
    for (let index = 0; index < count; index += 1) {
      const dueDate = text(formData, `due_${index}`);
      const principal = amountOf(text(formData, `principal_${index}`));
      const interest = amountOf(text(formData, `interest_${index}`));
      const commission = amountOf(text(formData, `commission_${index}`));
      if (!dueDate && principal === null && interest === null && commission === null) continue;
      rows.push({ dueDate, principalTxn: principal ?? 0n, interestTxn: interest, commissionTxn: commission });
    }
    const loan = await loans.loadByNo(tx, loanNo);
    return loans.setSchedule(tx, ctx, loan.id, rows);
  }, record(loanNo));
}

export async function approveLoan(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  await runAdminAndReturn(
    async (tx, ctx) => loans.approve(tx, ctx, (await loans.loadByNo(tx, loanNo)).id),
    record(loanNo),
  );
}

export async function disburseLoan(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      loans.disburse(tx, ctx, (await loans.loadByNo(tx, loanNo)).id, {
        disbursementDate: text(formData, 'disbursement_date'),
        reference: text(formData, 'reference'),
      }),
    record(loanNo),
  );
}

export async function payInstalmentAction(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      loans.payInstalment(tx, ctx, text(formData, 'instalment_id'), {
        paidDate: text(formData, 'paid_date'),
        reference: text(formData, 'reference'),
      }),
    record(loanNo),
  );
}

export async function payCommissionAction(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      loans.payCommission(tx, ctx, (await loans.loadByNo(tx, loanNo)).id, {
        paidOn: text(formData, 'paid_on'),
        reference: text(formData, 'reference'),
      }),
    record(loanNo),
  );
}

export async function cancelLoan(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  await runAdminAndReturn(
    async (tx, ctx) => loans.cancel(tx, ctx, (await loans.loadByNo(tx, loanNo)).id, text(formData, 'reason')),
    record(loanNo),
  );
}

/** `manual` — each draw's share of the commission, as the manager states it. */
export async function setSharesAction(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  const count = Number(text(formData, 'row_count')) || 0;
  await runAdminAndReturn(async (tx, ctx) => {
    const shares = [];
    for (let index = 0; index < count; index += 1) {
      const allocationId = text(formData, `allocation_${index}`);
      const share = amountOf(text(formData, `share_${index}`));
      if (allocationId && share !== null) shares.push({ allocationId, shareTxn: share });
    }
    const loan = await loans.loadByNo(tx, loanNo);
    return loans.setManualShares(tx, ctx, loan.id, shares);
  }, record(loanNo));
}

/** The contract, the schedule, the bank's letters — kept with the loan. */
export async function attachToLoan(formData: FormData): Promise<void> {
  const loanNo = text(formData, 'loan_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(loanNo)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  await runAdminAndReturn(async (tx, ctx) => {
    const loan = await loans.loadByNo(tx, loanNo);
    await attachments.upload(tx, ctx, {
      objectType: loans.PERMISSION_OBJECT,
      objectId: loan.id,
      fileName: upload.name,
      content,
    });
  }, record(loanNo));
}
