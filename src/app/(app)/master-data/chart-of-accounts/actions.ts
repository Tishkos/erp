'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import { CONTROL_ACCOUNT_KINDS } from '@domain/chart-of-accounts';
import type { AccountMappingInput } from '@domain/financial-statements';
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
      mapping: mappingFrom(formData),
      description: text(formData, 'description'),
    }),
  );
  if (!outcome.ok) return { ok: false, error: outcome.error! };
  revalidatePath(LIST);
  return { ok: true, code: outcome.value!.code };
}

/**
 * Phase 1 §5 — where this account reports on each of the four statements.
 *
 * All four are read and all four are written, every time: leaving one out
 * would mean the form could only ever add a mapping and never clear one.
 */
function mappingFrom(formData: FormData): AccountMappingInput {
  return {
    income_statement: text(formData, 'incomeStatementLine') || null,
    balance_sheet: text(formData, 'balanceSheetLine') || null,
    cash_flow: text(formData, 'cashFlowLine') || null,
    changes_in_equity: text(formData, 'changesInEquityLine') || null,
  };
}

export async function setStatementLines(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => coa.setStatementLines(tx, ctx, text(formData, 'id'), mappingFrom(formData)),
    record(code),
  );
}

export async function setControlAccount(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      coa.setControlAccount(
        tx,
        ctx,
        text(formData, 'id'),
        z.enum(CONTROL_ACCOUNT_KINDS).nullable().parse(text(formData, 'controlAccount') || null),
      ),
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
