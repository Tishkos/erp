'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import { parseDecimal } from '@/server/domain/money';
import type { InstalmentDraft } from '@/server/domain/payment-applications';
import * as applications from '@/server/services/payment-applications';
import * as attachments from '@/server/services/attachments';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';

/**
 * Payment applications — REQ-AP-001 §15.3, §21.7. Every verb is the service's;
 * these only read the form and say where to come back to.
 */
const LIST = '/payables/payment-applications';
const record = (applicationNo: string) => `${LIST}/${encodeURIComponent(applicationNo)}`;
const payableRecord = (payableNo: string) => `/payables/${encodeURIComponent(payableNo)}`;

/** Amount as typed ("3,500.00") at the money scale; null when blank. */
function amountOf(value: string): bigint | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) {
    throw new Error(`"${value}" is not an amount.`);
  }
  return parseDecimal(cleaned, 4n);
}

/** The list's "New payment application": pick the import, then plan from its page. */
export async function startApplication(formData: FormData): Promise<void> {
  const payableNo = text(formData, 'payable_no');
  redirect(`${payableRecord(payableNo)}?pay=1#payments`);
}

export async function createApplication(formData: FormData): Promise<void> {
  const payableNo = text(formData, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const owner = await payables.loadByNo(tx, payableNo);
      return applications.create(tx, ctx, {
        payableId: owner.id,
        instalmentId: text(formData, 'instalment_id') || null,
        paymentMethodCode: text(formData, 'payment_method'),
        bankCashAccountId: text(formData, 'bank_cash_account_id'),
        payeeBankAccountId: text(formData, 'payee_bank_account_id') || null,
        fundingSourceCode: text(formData, 'funding_source') || null,
        loanId: text(formData, 'loan_id') || null,
        amountTxn: amountOf(text(formData, 'amount')),
        note: text(formData, 'note') || null,
      });
    },
    (value) => {
      const created = value as { applicationNo?: string } | null | undefined;
      return created?.applicationNo ? record(created.applicationNo) : `${payableRecord(payableNo)}?pay=1`;
    },
  );
}

/** The plan dialog's rows: label, basis, value, trigger, days, expected date. */
export async function planInstalmentsAction(formData: FormData): Promise<void> {
  const payableNo = text(formData, 'payable_no');
  const count = Number(text(formData, 'row_count')) || 0;
  await runAdminAndReturn(
    async (tx, ctx) => {
      const rows: InstalmentDraft[] = [];
      for (let index = 0; index < count; index += 1) {
        const label = text(formData, `label_${index}`).trim();
        const value = text(formData, `value_${index}`).trim();
        if (!label && !value) continue;
        const basis = text(formData, `basis_${index}`) === 'amount' ? 'amount' : 'percent';
        const days = text(formData, `days_${index}`).trim();
        rows.push({
          label,
          basis,
          percent: basis === 'percent' ? value : null,
          amountTxn: basis === 'amount' ? amountOf(value) : null,
          triggerCode: text(formData, `trigger_${index}`),
          triggerDays: days ? Number(days) : null,
          expectedDate: text(formData, `expected_${index}`) || null,
        });
      }
      const owner = await payables.loadByNo(tx, payableNo);
      return applications.planInstalments(tx, ctx, { payableId: owner.id, rows });
    },
    payableRecord(payableNo),
  );
}

export async function approveApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) => applications.approve(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id),
    record(applicationNo),
  );
}

export async function sendApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      applications.send(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id, {
        applicationDate: text(formData, 'application_date'),
        bankReference: text(formData, 'bank_reference') || null,
        overrideReason: text(formData, 'override_reason') || null,
      }),
    record(applicationNo),
  );
}

export async function confirmApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      applications.confirm(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id, {
        confirmedOn: text(formData, 'confirmed_on'),
        reference: text(formData, 'confirmation_reference'),
      }),
    record(applicationNo),
  );
}

/** §24.3 / D37 — a migrated application paid before the cut-over: recorded, not posted. */
export async function confirmBeforeCutOver(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      applications.confirmBeforeCutOver(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id, {
        confirmedOn: text(formData, 'confirmed_on'),
        reference: text(formData, 'confirmation_reference'),
      }),
    record(applicationNo),
  );
}

export async function debitApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      applications.recordDebit(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id, {
        debitDate: text(formData, 'debit_date'),
      }),
    record(applicationNo),
  );
}

export async function rejectApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      applications.reject(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id, text(formData, 'reason')),
    record(applicationNo),
  );
}

export async function cancelApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      applications.cancel(tx, ctx, (await applications.loadByNo(tx, applicationNo)).id, text(formData, 'reason')),
    record(applicationNo),
  );
}

/** The SWIFT copy, the signed voucher, the bank's letter — kept with the application. */
export async function attachToApplication(formData: FormData): Promise<void> {
  const applicationNo = text(formData, 'application_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(applicationNo)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const row = await applications.loadByNo(tx, applicationNo);
    await attachments.upload(tx, ctx, {
      objectType: applications.PERMISSION_OBJECT,
      objectId: row.id,
      fileName: upload.name,
      content,
    });
    await events.record(tx, {
      payableId: row.payableId,
      eventCode: 'ATTACHMENT_ADDED',
      summary: `${upload.name} attached to ${row.applicationNo}`,
      sourceType: applications.PERMISSION_OBJECT,
      sourceId: row.id,
      sourceNo: row.applicationNo,
      actorUserId: ctx.principal.userId,
    });
  }, record(applicationNo));
}
