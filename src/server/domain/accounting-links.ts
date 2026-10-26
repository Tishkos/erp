/**
 * Where Accounting's own records live — REQ-ACC-001 (profiles, 2026-10-04).
 *
 * Every bank account, cash account, bank, G/L account and journal shown on an
 * accounting record is a link to its own page. The shared `profileHref`
 * (`domain/profiles.ts`, feat/shared-module) is the one place that says which
 * page; these are Accounting's names for its own kinds, so a transfer, a
 * reconciliation and a tax code send a reader to the same door and a moved
 * route is changed once, in `BASES`. A screen renders them with `ProfileLink`.
 */
import { profileHref } from './profiles';

const enc = encodeURIComponent;

/** A bank or cash account's master record. */
export function accountHref(kind: 'bank' | 'cash', code: string): string {
  return profileHref(kind === 'cash' ? 'cash_account' : 'bank_account', code) ?? '#';
}

/** A bank in the bank master. */
export function bankHref(code: string): string {
  return profileHref('bank', code) ?? '#';
}

/** A G/L account's record on the Chart of Accounts. */
export function glAccountHref(code: string): string {
  return profileHref('gl_account', code) ?? '#';
}

/** A journal entry. */
export function journalHref(entryNo: string): string {
  return profileHref('journal', entryNo) ?? '#';
}

/**
 * The record page of a document that moved money — Payments & Receipts'
 * source column. Null for a document with no page of its own; the row then
 * says what it was and opens its journal.
 */
export function moneyDocumentHref(type: string | null, no: string | null): string | null {
  if (!type || !no) return null;
  switch (type) {
    case 'customer_receipt':
      return profileHref('customer_receipt', no);
    case 'supplier_payment':
      return profileHref('supplier_payment', no);
    case 'supplier_advance':
      return profileHref('supplier_advance', no);
    case 'bank_transfer':
      return `/treasury/transfers/${enc(no)}`;
    case 'other_receipt':
      return profileHref('deposit', no);
    case 'customer_payment':
      return profileHref('customer_payment', no);
    case 'expense_payment':
      return profileHref('expense_payment', no);
    case 'bank_loan':
      return profileHref('loan', no);
    case 'payroll_run':
      return `/hr/payroll/${enc(no)}`;
    case 'employee_request':
      return `/hr/requests/${enc(no)}`;
    case 'employee_advance':
      return `/hr/advances/${enc(no)}`;
    case 'bank_reconciliation':
      return `/treasury/bank-reconciliation/${enc(no)}`;
    default:
      return null;
  }
}

/** A business partner's profile — the customer's, or the supplier's when it is only that. */
export function partnerHref(code: string, roles: { readonly isCustomer: boolean; readonly isSupplier: boolean }): string {
  return (roles.isSupplier && !roles.isCustomer ? profileHref('supplier', code) : profileHref('customer', code)) ?? '#';
}
