'use server';

/**
 * Recurring contracts — the server actions behind §21.4.
 *
 * Thin by design: each reads its form, calls the service in the caller's own
 * transaction, and returns with ?saved=1 or the service's own sentence. The
 * services hold every rule — maker-checker, future-only amendments, the
 * idempotent generator.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as contracts from '@/server/services/recurring-contracts';

const back = (contractNo: string) => `/payables/contracts/${encodeURIComponent(contractNo)}`;

export async function createContract(form: FormData): Promise<void> {
  let destination = '/payables/contracts';
  await runAdminAndReturn(
    async (tx, ctx) => {
      const created = await contracts.create(tx, ctx, {
        supplierId: text(form, 'supplier_id'),
        departmentCode: text(form, 'department_code'),
        branchCode: ctx.branchCode,
        expenseCategoryCode: text(form, 'expense_category'),
        description: text(form, 'description'),
        currency: text(form, 'currency').toUpperCase(),
        amountPerPeriodTxn: text(form, 'amount'),
        frequency: text(form, 'frequency') as 'monthly' | 'quarterly' | 'yearly',
        startDate: text(form, 'start_date'),
        endDate: text(form, 'end_date') || null,
        dueRule: text(form, 'due_rule'),
        generateDaysAhead: Number(text(form, 'generate_days_ahead') || '30'),
        autoConfirm: form.get('auto_confirm') === 'on',
        invoiceExpected: form.get('invoice_expected') === 'on',
      });
      destination = back(created.contractNo);
      return created;
    },
    () => destination,
  );
}

export async function approveContract(form: FormData): Promise<void> {
  const contractNo = text(form, 'contract_no');
  await runAdminAndReturn(
    async (tx, ctx) => contracts.approve(tx, ctx, text(form, 'contract_id')),
    () => back(contractNo),
  );
}

export async function amendContract(form: FormData): Promise<void> {
  const contractNo = text(form, 'contract_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      contracts.amend(tx, ctx, {
        contractId: text(form, 'contract_id'),
        effectiveFrom: text(form, 'effective_from'),
        amountPerPeriodTxn: text(form, 'amount') || null,
        note: text(form, 'note'),
      }),
    () => back(contractNo),
  );
}

export async function endContract(form: FormData): Promise<void> {
  const contractNo = text(form, 'contract_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      contracts.end(tx, ctx, {
        contractId: text(form, 'contract_id'),
        endDate: text(form, 'end_date'),
        reason: text(form, 'reason'),
      }),
    () => back(contractNo),
  );
}

/** §21.4 "Generate next period now" — manual, logged, idempotent like the sweep's. */
export async function generatePeriodsNow(form: FormData): Promise<void> {
  const contractNo = text(form, 'contract_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      contracts.generateDue(tx, new Date().toISOString().slice(0, 10), {
        userId: ctx.principal.userId,
      }),
    () => back(contractNo),
  );
}
