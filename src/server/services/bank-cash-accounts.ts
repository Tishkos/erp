/**
 * Bank and cash accounts — Phase 2 requirements 5 and 6.
 *
 * *"Company bank accounts can be created and maintained and linked to the
 *  correct branch and G/L account…"* and the same for cash accounts.
 *
 * One table, two kinds, two screens. They are one table because both are a
 * place company money sits, and every later payment, receipt and transfer
 * needs to resolve "which account?" against a single list. They are two
 * screens because the questions differ: a bank account has a bank, a number,
 * an IBAN and a statement format; a cash account has a custodian and a float
 * limit. A single form asking all of it would ask most people most of the
 * time for things that do not apply to them.
 *
 * ── The link that matters ──────────────────────────────────────────────────
 * Exactly one G/L account each, and no two accounts share one. That is a
 * unique index, not a convention: a bank statement is reconciled against a G/L
 * balance, and that is only a reconciliation if the balance belongs to one
 * account. Two cash accounts sharing a G/L account would each appear to hold
 * the other's money.
 *
 * The G/L account offered must be a posting account under Assets. Cash is an
 * asset; a header carries the sum of what is beneath it and nothing posts to
 * it; and an account already spoken for by another cash account is not free.
 */
import { and, asc, eq, inArray, not, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, bankCashAccount, branch, chartOfAccount } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  optionalText,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'bank_account';

export type AccountKind = 'bank' | 'cash';

export interface AccountInput {
  readonly name: string;
  readonly branchCode: string;
  readonly glAccountId: string;
  readonly currency?: string | null;
  /** Bank only. */
  readonly bankName?: string | null;
  readonly accountNumber?: string | null;
  readonly iban?: string | null;
  readonly swift?: string | null;
  readonly statementFormat?: string | null;
  /** Cash only. */
  readonly custodianUserId?: string | null;
  readonly cashLimitIqd?: string | null;
  /** Both. */
  readonly approvalLimitIqd?: string | null;
}

export async function listOfKind(tx: Tx, kind: AccountKind) {
  return tx
    .select({
      id: bankCashAccount.id,
      code: bankCashAccount.code,
      name: bankCashAccount.name,
      accountType: bankCashAccount.accountType,
      bankName: bankCashAccount.bankName,
      accountNumber: bankCashAccount.accountNumber,
      currency: bankCashAccount.currency,
      branchCode: bankCashAccount.branchCode,
      glAccountCode: chartOfAccount.code,
      glAccountName: chartOfAccount.name,
      custodianName: appUser.displayName,
      cashLimitIqd: bankCashAccount.cashLimitIqd,
      active: bankCashAccount.active,
    })
    .from(bankCashAccount)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, bankCashAccount.glAccountId))
    .leftJoin(appUser, eq(appUser.id, bankCashAccount.custodianUserId))
    .where(eq(bankCashAccount.accountType, kind))
    .orderBy(asc(bankCashAccount.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(bankCashAccount).where(eq(bankCashAccount.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('account', code);
  return row;
}

export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [gl] = await tx
    .select({ code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, row.glAccountId))
    .limit(1);
  const [place] = await tx
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.code, row.branchCode))
    .limit(1);
  const [custodian] = row.custodianUserId
    ? await tx
        .select({ name: appUser.displayName, email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, row.custodianUserId))
        .limit(1)
    : [];
  return {
    ...row,
    glAccountCode: gl?.code ?? null,
    glAccountName: gl?.name ?? null,
    branchName: place?.name ?? null,
    custodianName: custodian?.name ?? null,
    custodianEmail: custodian?.email ?? null,
  };
}

/**
 * The G/L accounts this account may be carried in.
 *
 * Posting accounts under Assets that no other bank or cash account has already
 * claimed — plus, when editing, the one this account already holds, so the
 * form can show it without the picker calling it unavailable.
 */
export async function availableGlAccounts(tx: Tx, keep?: string | null) {
  const taken = await tx
    .select({ id: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(keep ? not(eq(bankCashAccount.glAccountId, keep)) : sql`true`);
  const takenIds = taken.map((row) => row.id);

  return tx
    .select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(
      and(
        eq(chartOfAccount.accountType, 'asset'),
        eq(chartOfAccount.isGroup, false),
        eq(chartOfAccount.isActive, true),
        eq(chartOfAccount.approvalStatus, 'approved'),
        takenIds.length > 0 ? not(inArray(chartOfAccount.id, takenIds)) : sql`true`,
      ),
    )
    .orderBy(asc(chartOfAccount.code));
}

async function assertGlAccount(tx: Tx, id: string, keep?: string | null): Promise<string> {
  const [account] = await tx
    .select({
      id: chartOfAccount.id,
      isGroup: chartOfAccount.isGroup,
      accountType: chartOfAccount.accountType,
      isActive: chartOfAccount.isActive,
    })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, id))
    .limit(1);
  if (!account) throw new AdminValidationError('glAccountId', 'is not a known account');
  if (account.isGroup) {
    throw new AdminValidationError('glAccountId', 'is a header, not a posting account');
  }
  if (account.accountType !== 'asset') {
    throw new AdminValidationError('glAccountId', 'must be an asset account — cash is an asset');
  }
  if (!account.isActive) throw new AdminValidationError('glAccountId', 'is not active');

  const [claimed] = await tx
    .select({ code: bankCashAccount.code })
    .from(bankCashAccount)
    .where(
      and(
        eq(bankCashAccount.glAccountId, id),
        keep ? not(eq(bankCashAccount.glAccountId, keep)) : sql`true`,
      ),
    )
    .limit(1);
  if (claimed && id !== keep) {
    throw new AdminValidationError('glAccountId', `is already carried by account ${claimed.code}`);
  }
  return account.id;
}

async function assertBranch(tx: Tx, code: string): Promise<string> {
  const [row] = await tx.select({ code: branch.code }).from(branch).where(eq(branch.code, code)).limit(1);
  if (!row) throw new AdminValidationError('branchCode', 'is not a known branch');
  return row.code;
}

async function assertCustodian(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [user] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user) throw new AdminValidationError('custodianUserId', 'is not a known user');
  return user.id;
}

function assertAmount(value: string | null | undefined, field: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AdminValidationError(field, 'must be a positive amount');
  }
  return raw;
}

function assertCurrency(value: string | null | undefined): string {
  const code = (value ?? 'IQD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new AdminValidationError('currency', 'is a three-letter code such as IQD or USD');
  }
  return code;
}

/** The fields that belong to one kind, checked as that kind requires. */
async function shapeFor(tx: Tx, kind: AccountKind, input: AccountInput) {
  if (kind === 'bank') {
    return {
      bankName: optionalText(input.bankName),
      // §4.4 — a bank account with no number cannot be reconciled to a statement.
      accountNumber: requireText(input.accountNumber ?? '', 'accountNumber'),
      iban: optionalText(input.iban),
      swift: optionalText(input.swift),
      statementFormat: optionalText(input.statementFormat),
      custodianUserId: null,
      cashLimitIqd: null,
    };
  }
  // §17 — a cash float without a custodian is nobody's responsibility.
  const custodian = await assertCustodian(tx, input.custodianUserId ?? null);
  if (!custodian) throw new AdminValidationError('custodianUserId', 'is required for a cash account');
  return {
    bankName: null,
    accountNumber: null,
    iban: null,
    swift: null,
    statementFormat: null,
    custodianUserId: custodian,
    cashLimitIqd: assertAmount(input.cashLimitIqd, 'cashLimitIqd'),
  };
}

/** Where each kind's number comes from — configurable on the Numbering screen. */
const CODE_SEQUENCE: Readonly<Record<AccountKind, string>> = {
  bank: 'BANK_ACCOUNT_CODE',
  cash: 'CASH_ACCOUNT_CODE',
};

/**
 * The next number of this kind that nothing already holds.
 *
 * Bounded like the chart's: a hundred consecutive numbers all taken means the
 * counter is behind and somebody should look, rather than the loop spinning.
 */
async function allocateFreeCode(tx: Tx, kind: AccountKind, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { documentNo } = await allocateDocumentNumber(tx, CODE_SEQUENCE[kind], {}, userId);
    const [taken] = await tx
      .select({ code: bankCashAccount.code })
      .from(bankCashAccount)
      .where(eq(bankCashAccount.code, documentNo))
      .limit(1);
    if (!taken) return documentNo;
  }
  throw new Error(
    `The ${kind} account counter is a hundred numbers behind the register. ` +
      'Set it past the highest code in use on the Numbering screen before adding another.',
  );
}

/**
 * A new bank or cash account. Its number is minted, never given.
 *
 * Operations build, block 6: *"Bank/Cash Name; Bank Number (automatically
 * generated); Type (Cash or Bank); Related Account."* It used to be a slug of
 * the name that anybody could type over, which is not what "automatically
 * generated" describes.
 */
export async function create(tx: Tx, ctx: ActorContext, kind: AccountKind, input: AccountInput) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  const code = await allocateFreeCode(tx, kind, ctx.principal.userId);

  const values = {
    code,
    name,
    accountType: kind,
    currency: assertCurrency(input.currency),
    glAccountId: await assertGlAccount(tx, input.glAccountId),
    branchCode: await assertBranch(tx, input.branchCode),
    approvalLimitIqd: assertAmount(input.approvalLimitIqd, 'approvalLimitIqd'),
    ...(await shapeFor(tx, kind, input)),
    active: true,
  };
  await tx.insert(bankCashAccount).values(values);

  await recordChange(tx, ctx, {
    action: `${kind}_account.created`,
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: values,
    branchCode: values.branchCode,
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: AccountInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const kind = before.accountType as AccountKind;

  const values = {
    name: requireText(input.name, 'name'),
    currency: assertCurrency(input.currency),
    glAccountId: await assertGlAccount(tx, input.glAccountId, before.glAccountId),
    branchCode: await assertBranch(tx, input.branchCode),
    approvalLimitIqd: assertAmount(input.approvalLimitIqd, 'approvalLimitIqd'),
    ...(await shapeFor(tx, kind, input)),
  };
  await tx.update(bankCashAccount).set(values).where(eq(bankCashAccount.code, code));

  await recordChange(tx, ctx, {
    action: `${kind}_account.updated`,
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: {
      name: before.name,
      currency: before.currency,
      glAccountId: before.glAccountId,
      branchCode: before.branchCode,
      accountNumber: before.accountNumber,
      custodianUserId: before.custodianUserId,
    },
    after: values,
    branchCode: values.branchCode,
  });
  return get(tx, code);
}

export async function setActive(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  active: boolean,
  reason: string | null,
) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  if (before.active === active) return before;
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate an account');
  }
  // §4.1 — a branch's default cash account is part of what makes the branch
  // operable. Retiring it would leave the branch unable to take cash.
  if (!active) {
    const [defaulted] = await tx
      .select({ code: branch.code })
      .from(branch)
      .where(eq(branch.defaultCashAccountId, before.id))
      .limit(1);
    if (defaulted) {
      throw new AdminValidationError(
        'code',
        `is the default cash account of branch ${defaulted.code}`,
      );
    }
  }
  await tx.update(bankCashAccount).set({ active }).where(eq(bankCashAccount.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'bank_account.reactivated' : 'bank_account.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
    branchCode: before.branchCode,
  });
  return get(tx, code);
}

/** Branches a picker may offer — active only. */
export async function listBranches(tx: Tx) {
  return tx
    .select({ code: branch.code, name: branch.name })
    .from(branch)
    .where(eq(branch.active, true))
    .orderBy(asc(branch.code));
}
