/**
 * Banks — REQ-AP-001 §15.1. Mansour, Arab, NBI, Rafidain … a master, not a
 * fixed list: a new bank is a row, its code minted (BNK-0001, Critical Rule 1)
 * and its SWIFT/BIC checked for shape and kept unique.
 *
 * A bank account names its bank; the time limits may be per bank (§19.3,
 * scope `bank:<code>`); a PD is registered with a bank (Stage 4); a loan is
 * lent by one (Stage 6). Nothing is deleted — a bank the company stopped
 * using is deactivated, with a reason.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { bank, bankCashAccount } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import { allocateFreeCode } from './numbering';

export const PERMISSION_OBJECT = 'bank';

export interface BankInput {
  readonly name: string;
  readonly swiftBic?: string | null;
  readonly country?: string | null;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: bank.code,
      name: bank.name,
      swiftBic: bank.swiftBic,
      country: bank.country,
      active: bank.active,
      accounts: sql<number>`(select count(*)::int from bank_cash_account a where a.bank_code = ${bank.code})`,
    })
    .from(bank)
    .orderBy(asc(bank.code));
}

export async function listActive(tx: Tx) {
  return tx
    .select({ code: bank.code, name: bank.name, swiftBic: bank.swiftBic })
    .from(bank)
    .where(eq(bank.active, true))
    .orderBy(asc(bank.name));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(bank).where(eq(bank.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('bank', code);
  return row;
}

export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const accounts = await tx
    .select({
      code: bankCashAccount.code,
      name: bankCashAccount.name,
      currency: bankCashAccount.currency,
      accountNumber: bankCashAccount.accountNumber,
      active: bankCashAccount.active,
    })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.bankCode, code))
    .orderBy(asc(bankCashAccount.code));
  return { ...row, accounts };
}

/** ISO 9362 — 8 or 11 characters; upper-cased, spaces removed. */
function normaliseSwift(value: string | null | undefined): string | null {
  const raw = (value ?? '').replace(/\s+/g, '').toUpperCase();
  if (!raw) return null;
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(raw)) {
    throw new AdminValidationError(
      'swiftBic',
      'is 8 or 11 characters: four letters for the bank, two for the country, two for the place, and an optional branch',
    );
  }
  return raw;
}

function normaliseCountry(value: string | null | undefined): string {
  const raw = (value ?? '').trim().toUpperCase() || 'IQ';
  if (!/^[A-Z]{2}$/.test(raw)) throw new AdminValidationError('country', 'is a two-letter country code (IQ, CN, AE)');
  return raw;
}

async function assertSwiftFree(tx: Tx, swift: string | null, except?: string) {
  if (!swift) return;
  const [other] = await tx.select({ code: bank.code }).from(bank).where(eq(bank.swiftBic, swift)).limit(1);
  if (other && other.code !== except) {
    throw new AdminValidationError('swiftBic', `${swift} is already ${other.code}`);
  }
}

export async function create(tx: Tx, ctx: ActorContext, input: BankInput) {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const name = requireText(input.name, 'name');
  const swiftBic = normaliseSwift(input.swiftBic);
  const country = normaliseCountry(input.country);
  await assertSwiftFree(tx, swiftBic);

  const code = await allocateFreeCode(
    tx,
    'BANK_CODE',
    async (candidate) => {
      const [row] = await tx.select({ code: bank.code }).from(bank).where(eq(bank.code, candidate));
      return Boolean(row);
    },
    ctx.principal.userId,
  );
  await tx.insert(bank).values({ code, name, swiftBic, country, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, {
    action: 'bank.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, name, swiftBic, country },
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: BankInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const name = requireText(input.name, 'name');
  const swiftBic = normaliseSwift(input.swiftBic);
  const country = normaliseCountry(input.country);
  await assertSwiftFree(tx, swiftBic, code);

  await tx.update(bank).set({ name, swiftBic, country }).where(eq(bank.code, code));
  await recordChange(tx, ctx, {
    action: 'bank.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name, swiftBic: before.swiftBic, country: before.country },
    after: { name, swiftBic, country },
  });
  return get(tx, code);
}

export async function setActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason: string | null) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  if (before.active === active) return before;
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate a bank');
  }
  await tx.update(bank).set({ active }).where(eq(bank.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'bank.reactivated' : 'bank.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}
