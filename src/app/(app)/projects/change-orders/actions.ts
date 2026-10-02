'use server';

/**
 * Change orders — REQ-PM-001 Stage PM-2 §7. Raised with the budget they
 * move, element by element; approved twice, by people other than the
 * raiser; the supplement they carry is raised and approved with the second
 * approval.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as pb from '@/server/services/project-budget';
import { linesOf } from '../budgets/lines';

const LIST = '/projects/change-orders';
const record = (no: string) => `/projects/change-orders/${encodeURIComponent(no)}`;

export async function raiseChangeOrder(form: FormData): Promise<void> {
  const projectCode = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) =>
      pb.raiseChangeOrder(tx, ctx, projectCode, {
        description: text(form, 'description'),
        scopeNote: text(form, 'scope_note') || null,
        raisedOn: text(form, 'raised_on') || null,
        contractDeltaIqd: text(form, 'contract_delta_iqd') || null,
        scheduleDeltaDays: text(form, 'schedule_delta_days') || null,
        revisedEndsOn: text(form, 'revised_ends_on') || null,
        supersedesNo: text(form, 'supersedes_no') || null,
        lines: linesOf(form),
      }),
    (value) =>
      value && typeof value === 'object' && 'variationNo' in value
        ? record(String((value as { variationNo: string }).variationNo))
        : `${LIST}/new?project=${encodeURIComponent(projectCode)}`,
  );
}

export async function approveChangeOrder(form: FormData): Promise<void> {
  const no = text(form, 'variation_no');
  const which = text(form, 'which') === 'budget' ? 'budget' : 'commercial';
  await runAdminAndReturn((tx, ctx) => pb.approveChangeOrder(tx, ctx, no, which), record(no));
}

export async function rejectChangeOrder(form: FormData): Promise<void> {
  const no = text(form, 'variation_no');
  await runAdminAndReturn((tx, ctx) => pb.rejectChangeOrder(tx, ctx, no, text(form, 'reason')), record(no));
}
