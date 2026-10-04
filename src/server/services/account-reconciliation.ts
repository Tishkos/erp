/**
 * Account Reconciliation — REQ-ACC-001 Part D-4.
 *
 * A module of its own so `closing-checks.ts` (whose catalogue a unit test
 * loads without a database) keeps importing only `subledger.ts`; this one
 * brings the authorisation the screen needs.
 */
import type { Tx } from '../db/client';
import type { ControlAccountKind } from '../domain/chart-of-accounts';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import { inventoryValue, reconciliation } from './subledger';

/** Where each sub-ledger is investigated, party by party. */
export const SUBLEDGER_SCREEN: Readonly<Partial<Record<ControlAccountKind, string>>> = {
  customer: '/sales/customer-statements',
  supplier: '/payables/supplier-statements',
  loan: '/treasury/loans',
  inventory: '/inventory/fifo-valuation',
};

/**
 * The Account Reconciliation screen's one read (REQ-ACC-001 Part D-4): every
 * control account's sub-ledger beside its G/L balance as at a date — the same
 * rows the close checklist's `subledger_equals_gl` reads — and the inventory
 * layers beside the inventory accounts (`inventoryValue`, check 7's figure).
 * It reports; it never posts a correction. Read under the Trial Balance's
 * grant, as the menu says.
 */
export async function accountReconciliation(tx: Tx, ctx: ActorContext, asOf: string) {
  await authz.authorize(ctx.principal, 'view', 'trial_balance', { branchCode: ctx.branchCode });
  return { asOf, rows: await reconciliation(tx, asOf), inventory: await inventoryValue(tx) };
}

