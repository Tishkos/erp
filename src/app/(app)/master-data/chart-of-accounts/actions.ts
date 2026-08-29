'use server';

import { revalidatePath } from 'next/cache';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as coa from '@/server/services/chart-of-accounts';

const LIST = '/master-data/chart-of-accounts';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

/**
 * Raises an account — Phase 1 requirement 1.
 *
 * The type is not asked for: an account under Assets is an asset, inherited
 * from the parent. Offering the choice would only create the chance to get it
 * wrong, and a mis-typed account is wrong on every statement afterwards.
 *
 * Nor is the currency: the ledger is kept in IQD (by direction, 2026-08-29),
 * and USD is a way of reading the reports, not a property of an account.
 *
 * Returns rather than redirects, so the dialog that called it can show a
 * refusal beside the fields with everything still typed, and move to the new
 * account itself on success.
 */
export async function createAccount(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; code?: string }> {
  // Read the value, not the presence of the field: a <select> always submits
  // something, so a presence check made every account a header account — and
  // a header account can never take a posting, which is the one thing most of
  // them are opened to do.
  const isGroup = text(formData, 'isGroup') === 'group';
  const outcome = await runAdmin((tx, ctx) =>
    coa.createAccount(tx, ctx, {
      name: text(formData, 'name'),
      parentId: text(formData, 'parentId'),
      isGroup,
      // A group summarises its children and holds no balance, so no currency.
      ...(isGroup ? {} : { currencyRestriction: 'IQD' }),
      statementLine: text(formData, 'statementLine') || null,
      description: text(formData, 'description'),
    }),
  );
  if (!outcome.ok) return { ok: false, error: outcome.error! };
  revalidatePath(LIST);
  return { ok: true, code: outcome.value!.code };
}

/** Phase 1 §5 — which line of which statement this account reports on. */
export async function setStatementLine(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      coa.setStatementLine(tx, ctx, text(formData, 'id'), text(formData, 'statementLine') || null),
    record(code),
  );
}

/** §1.1 — an account leaves use by being deactivated, never by being deleted. */
export async function deactivateAccount(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => coa.deactivate(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(code),
  );
}

/**
 * §14.3 — lets an account hold sub-accounts.
 *
 * Only while it has never been posted to: a header holds no balance of its
 * own, so converting one that does would leave that balance where no statement
 * adds it up. The service says so in words when it refuses.
 */
export async function allowSubAccounts(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => coa.convertToGroup(tx, ctx, text(formData, 'id')),
    record(code),
  );
}

/** The name and the description — the two things about an account that are typed. */
export async function updateAccount(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      coa.updateDetails(tx, ctx, text(formData, 'id'), {
        name: text(formData, 'name'),
        description: text(formData, 'description'),
      }),
    record(code),
  );
}
