'use server';

/**
 * Service receipts — the actions behind §21.5's inbox.
 *
 * Submit and approve, each in the caller's own transaction; the service
 * holds the maker-checker and the department rule. Dispute is a note and a
 * stop on the payable, raised from the payable page — not here.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as receipts from '@/server/services/service-receipt';

const BACK = '/payables/service-receipts';

export async function submitReceipt(form: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => receipts.submit(tx, ctx, text(form, 'receipt_id')),
    () => BACK,
  );
}

export async function approveReceipt(form: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => receipts.approve(tx, ctx, text(form, 'receipt_id')),
    () => BACK,
  );
}
