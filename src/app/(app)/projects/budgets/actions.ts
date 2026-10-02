'use server';

/**
 * Budget documents — REQ-PM-001 Stage PM-2 §7. The new-document page posts
 * one amount per planning element and cost code; the document page posts
 * its transitions. Every call is a service call with an audit row behind it.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as pb from '@/server/services/project-budget';
import { linesOf } from './lines';

const LIST = '/projects/budgets';
const record = (no: string) => `/projects/budgets/${encodeURIComponent(no)}`;

export async function createBudgetDocument(form: FormData): Promise<void> {
  const projectCode = text(form, 'project_code');
  const kind = text(form, 'kind');
  await runAdminAndReturn(
    (tx, ctx) =>
      pb.createBudgetDocument(tx, ctx, projectCode, {
        kind,
        raisedOn: text(form, 'raised_on') || null,
        description: text(form, 'description'),
        // A return is typed as what is taken back; the document carries it negative.
        lines: linesOf(form).map((line) => (kind === 'return' ? { ...line, amountIqd: `-${line.amountIqd.replace(/^-/, '')}` } : line)),
      }),
    (value) =>
      value && typeof value === 'object' && 'documentNo' in value
        ? record(String((value as { documentNo: string }).documentNo))
        : `${LIST}/new?project=${encodeURIComponent(projectCode)}&kind=${encodeURIComponent(kind)}`,
  );
}

export async function updateBudgetDocument(form: FormData): Promise<void> {
  const no = text(form, 'document_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      pb.updateBudgetDocument(tx, ctx, no, {
        raisedOn: text(form, 'raised_on') || null,
        description: text(form, 'description'),
        lines: linesOf(form).map((line) => (text(form, 'kind') === 'return' ? { ...line, amountIqd: `-${line.amountIqd.replace(/^-/, '')}` } : line)),
      }),
    record(no),
  );
}

export async function submitBudgetDocument(form: FormData): Promise<void> {
  const no = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => pb.submitBudgetDocument(tx, ctx, no), record(no));
}

export async function approveBudgetDocument(form: FormData): Promise<void> {
  const no = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => pb.approveBudgetDocument(tx, ctx, no), record(no));
}

export async function rejectBudgetDocument(form: FormData): Promise<void> {
  const no = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => pb.rejectBudgetDocument(tx, ctx, no, text(form, 'reason')), record(no));
}
