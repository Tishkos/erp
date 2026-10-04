/**
 * Where Accounting's own records live — REQ-ACC-001 (profiles, 2026-10-04).
 *
 * Every bank account, cash account, bank, G/L account and journal shown on an
 * accounting record is a link to its own page. These are those pages, in one
 * place, so a transfer, a reconciliation and a tax code send a reader to the
 * same door. The shared `profileHref` (feat/shared-module) answers the same
 * question for every module and reads these for Accounting's kinds.
 */
const enc = encodeURIComponent;

/** A bank or cash account's master record. */
export function accountHref(kind: 'bank' | 'cash', code: string): string {
  return kind === 'cash' ? `/master-data/cash-accounts/${enc(code)}` : `/master-data/bank-accounts/${enc(code)}`;
}

/** A bank in the bank master. */
export function bankHref(code: string): string {
  return `/master-data/banks/${enc(code)}`;
}

/** A G/L account's record on the Chart of Accounts. */
export function glAccountHref(code: string): string {
  return `/master-data/chart-of-accounts/${enc(code)}`;
}

/** A journal entry. */
export function journalHref(entryNo: string): string {
  return `/finance/journals/${enc(entryNo)}`;
}
