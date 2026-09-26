'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as accounts from '@/server/services/bank-cash-accounts';

/**
 * Bank and cash accounts are one table and one service, so they are one set of
 * actions. Which screen a create came from is carried explicitly as `kind`,
 * and which screen an edit returns to is read from the account itself — the
 * account's type is the truth about which list it belongs on.
 */
const listFor = (kind: accounts.AccountKind) =>
  kind === 'bank' ? '/master-data/bank-accounts' : '/master-data/cash-accounts';
const recordFor = (kind: accounts.AccountKind, code: string) =>
  `${listFor(kind)}/${encodeURIComponent(code)}`;

const kindOf = (formData: FormData): accounts.AccountKind =>
  text(formData, 'kind') === 'cash' ? 'cash' : 'bank';

function inputFrom(formData: FormData) {
  return {
    name: text(formData, 'name'),
    branchCode: text(formData, 'branchCode'),
    glAccountId: text(formData, 'glAccountId'),
    currency: text(formData, 'currency') || null,
    bankName: text(formData, 'bankName') || null,
    accountNumber: text(formData, 'accountNumber') || null,
    iban: text(formData, 'iban') || null,
    swift: text(formData, 'swift') || null,
    statementFormat: text(formData, 'statementFormat') || null,
    custodianUserId: text(formData, 'custodianUserId') || null,
    cashLimitIqd: text(formData, 'cashLimitIqd') || null,
    approvalLimitIqd: text(formData, 'approvalLimitIqd') || null,
  };
}

/**
 * A new bank or cash account. The form carries no number and this reads none.
 *
 * Block 6 calls it "automatically generated", so the system gives it. Reading
 * a `code` field here would be the one line that let a typed one back in.
 */
export async function createAccount(formData: FormData): Promise<void> {
  const kind = kindOf(formData);
  await runAdminAndReturn(
    (tx, ctx) => accounts.create(tx, ctx, kind, inputFrom(formData)),
    (value) => {
      const created = value as { code?: string } | null | undefined;
      return created?.code ? recordFor(kind, created.code) : listFor(kind);
    },
  );
}

export async function updateAccount(formData: FormData): Promise<void> {
  const kind = kindOf(formData);
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => accounts.update(tx, ctx, code, inputFrom(formData)),
    recordFor(kind, code),
  );
}

export async function setAccountActive(formData: FormData): Promise<void> {
  const kind = kindOf(formData);
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      accounts.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    recordFor(kind, code),
  );
}
