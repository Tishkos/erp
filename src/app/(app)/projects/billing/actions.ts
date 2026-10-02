'use server';

/**
 * Billing — REQ-PM-001 Stage PM-5 §11. The billing plan's lines, the
 * certificates raised from them or from measured progress and approved by
 * somebody else, and the period's revenue recognition.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as billing from '@/server/services/project-billing';

const page = (form: FormData) => {
  const periodEnd = text(form, 'period_end');
  return `/projects/billing?project=${encodeURIComponent(text(form, 'project_code'))}${periodEnd ? `&period_end=${periodEnd}` : ''}`;
};
const record = (form: FormData) => `/projects/billing/${encodeURIComponent(text(form, 'certificate_no'))}`;

export async function addBillingLine(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      billing.addPlanLine(tx, ctx, text(form, 'project_code'), {
        wbsCode: text(form, 'wbs_code'),
        description: text(form, 'description'),
        dueTrigger: text(form, 'due_trigger'),
        activityCode: text(form, 'activity_code') || null,
        dueOn: text(form, 'due_on') || null,
        basis: text(form, 'basis'),
        percentOfContract: text(form, 'basis') === 'percent' ? text(form, 'value') : null,
        amountIqd: text(form, 'basis') === 'amount' ? text(form, 'value') : null,
      }),
    page(form),
  );
}

export async function cancelBillingLine(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => billing.cancelPlanLine(tx, ctx, text(form, 'project_code'), Number(text(form, 'line_no')), text(form, 'reason')), page(form));
}

export async function raiseCertificate(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => billing.raiseFromLine(tx, ctx, text(form, 'project_code'), Number(text(form, 'line_no')), text(form, 'certified_on')),
    (made) => (made ? `/projects/billing/${encodeURIComponent((made as { certificateNo: string }).certificateNo)}` : page(form)),
  );
}

export async function certifyProgress(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => billing.certifyProgress(tx, ctx, text(form, 'project_code'), { certifiedOn: text(form, 'certified_on'), percentComplete: text(form, 'percent_complete') }),
    (made) => (made ? `/projects/billing/${encodeURIComponent((made as { certificateNo: string }).certificateNo)}` : page(form)),
  );
}

export async function runRecognition(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => billing.runRecognition(tx, ctx, text(form, 'project_code'), text(form, 'period_end')), page(form));
}

export async function approveCertificate(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => billing.approveCertificate(tx, ctx, text(form, 'certificate_no')), record(form));
}

export async function cancelCertificate(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => billing.cancelCertificate(tx, ctx, text(form, 'certificate_no'), text(form, 'reason')), record(form));
}
