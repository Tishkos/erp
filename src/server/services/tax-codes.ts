/**
 * Tax Codes — REQ-ACC-001 Part D-5.
 *
 * "Reusable tax configuration: tax code, rate, input/output treatment,
 * relevant accounts, active/inactive. Transactions reference tax codes. Do not
 * hard-code rates into individual invoices/journals."
 *
 * The tables are Phase 03.6's (`tax_code`, `tax_rate`, 0012) with 0292's
 * direction and series; this is their only writer.
 *
 *   * The code is minted (TAX-001 …), never typed — Critical Rule 1.
 *   * The rate is effective-dated: a new rate is a new row from a date, and a
 *     rate already written is never changed (a return filed at 5% stays at
 *     5%; `tax_rate_append_only`). `rateOn` is how a document asks.
 *   * The account is a posting account, approved and active, and one account
 *     never serves recoverable and non-recoverable tax at once (0012's
 *     trigger, asked here first so the message is ours).
 *   * Deactivated with a reason, never deleted.
 *
 * Every change is an audit event on the code.
 */
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, chartOfAccount, taxCode, taxRate } from '../db/schema';
import { AdminNotFoundError, AdminValidationError, permit, recordChange, requireText, type ActorContext } from './administration';
import { allocateFreeCode } from './numbering';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'tax_code';
export const TAX_DIRECTIONS = ['input', 'output'] as const;
export type TaxDirection = (typeof TAX_DIRECTIONS)[number];

const RATE_SCALE = 6;

export interface TaxCodeInput {
  readonly name: string;
  readonly direction: TaxDirection;
  readonly isRecoverable: boolean;
  readonly accountId: string;
}

/** A percentage as typed — "15", "2.5" — checked and held at six places. */
export function normaliseRate(value: string): string {
  const raw = value.replace(/[%\s]/g, '');
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(raw)) {
    throw new AdminValidationError('rate', 'is a percentage, such as 15 or 2.5');
  }
  const [whole, fraction = ''] = raw.split('.');
  const normalised = `${Number(whole)}.${fraction.padEnd(RATE_SCALE, '0')}`;
  if (Number(whole) > 100 || (Number(whole) === 100 && /[1-9]/.test(fraction))) {
    throw new AdminValidationError('rate', 'is at most 100%');
  }
  return normalised;
}

function assertDirection(value: string): TaxDirection {
  if (!(TAX_DIRECTIONS as readonly string[]).includes(value)) {
    throw new AdminValidationError('direction', 'is input (on purchases) or output (on sales)');
  }
  return value as TaxDirection;
}

async function assertAccount(tx: Tx, accountId: string, isRecoverable: boolean, except?: string) {
  const [account] = await tx.select().from(chartOfAccount).where(eq(chartOfAccount.id, accountId)).limit(1);
  if (!account) throw new AdminValidationError('account', 'is not on the chart of accounts');
  if (account.isGroup || !account.isActive || account.approvalStatus !== 'approved') {
    throw new AdminValidationError('account', `${account.code} is not an active, approved posting account`);
  }
  // Asked here so the message is ours; 0012's trigger holds the same rule.
  const [clash] = await tx
    .select({ code: taxCode.code })
    .from(taxCode)
    .where(and(eq(taxCode.accountId, accountId), sql`${taxCode.isRecoverable} <> ${isRecoverable}`, except ? sql`${taxCode.code} <> ${except}` : sql`true`))
    .limit(1);
  if (clash) {
    throw new AdminValidationError(
      'account',
      `${account.code} already carries ${clash.code}, a ${isRecoverable ? 'non-recoverable' : 'recoverable'} tax; one account cannot hold both (§4.3)`,
    );
  }
  return account;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: taxCode.code,
      name: taxCode.name,
      direction: taxCode.direction,
      isRecoverable: taxCode.isRecoverable,
      active: taxCode.active,
      accountCode: chartOfAccount.code,
      accountName: chartOfAccount.name,
      // The rate in force today, the latest effective on or before it.
      currentRate: sql<string | null>`(select r.rate_percent::text from tax_rate r
                                          where r.tax_code = ${taxCode.code} and r.effective_from <= ${businessToday()}::date
                                          order by r.effective_from desc limit 1)`,
    })
    .from(taxCode)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, taxCode.accountId))
    .orderBy(asc(taxCode.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(taxCode).where(eq(taxCode.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('tax code', code);
  return row;
}

/** One code with its account, who wrote it, and every rate it has had, newest first. */
export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [account] = await tx
    .select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, row.accountId))
    .limit(1);
  const [creator] = row.createdBy
    ? await tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, row.createdBy)).limit(1)
    : [];
  const rates = await tx
    .select({
      id: taxRate.id,
      ratePercent: taxRate.ratePercent,
      effectiveFrom: taxRate.effectiveFrom,
      createdAt: taxRate.createdAt,
      createdBy: appUser.displayName,
    })
    .from(taxRate)
    .leftJoin(appUser, eq(appUser.id, taxRate.createdBy))
    .where(eq(taxRate.taxCodeRef, code))
    .orderBy(desc(taxRate.effectiveFrom));
  return { ...row, account: account!, createdByName: creator?.name ?? null, rates };
}

/** The rate a document dated `onDate` uses — the latest effective on or before it; null when there is none. */
export async function rateOn(tx: Tx, code: string, onDate: string): Promise<string | null> {
  const [row] = await tx
    .select({ rate: taxRate.ratePercent })
    .from(taxRate)
    .where(and(eq(taxRate.taxCodeRef, code), lte(taxRate.effectiveFrom, onDate)))
    .orderBy(desc(taxRate.effectiveFrom))
    .limit(1);
  return row?.rate ?? null;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: TaxCodeInput & { readonly ratePercent: string; readonly effectiveFrom: string },
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const name = requireText(input.name, 'name');
  const direction = assertDirection(input.direction);
  await assertAccount(tx, input.accountId, input.isRecoverable);
  const rate = normaliseRate(input.ratePercent);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new AdminValidationError('effectiveFrom', 'is a date');

  const code = await allocateFreeCode(
    tx,
    'TAX_CODE',
    async (candidate) => Boolean((await tx.select({ code: taxCode.code }).from(taxCode).where(eq(taxCode.code, candidate)))[0]),
    ctx.principal.userId,
  );
  await tx.insert(taxCode).values({
    code,
    name,
    direction,
    isRecoverable: input.isRecoverable,
    accountId: input.accountId,
    createdBy: ctx.principal.userId,
  });
  await tx.insert(taxRate).values({ taxCodeRef: code, ratePercent: rate, effectiveFrom: input.effectiveFrom, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, {
    action: 'tax_code.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, name, direction, isRecoverable: input.isRecoverable, rate, effectiveFrom: input.effectiveFrom },
  });
  return get(tx, code);
}

/** The name, the treatment and the account. The rate is changed by `addRate`, from a date. */
export async function update(tx: Tx, ctx: ActorContext, code: string, input: TaxCodeInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const name = requireText(input.name, 'name');
  const direction = assertDirection(input.direction);
  await assertAccount(tx, input.accountId, input.isRecoverable, code);
  await tx
    .update(taxCode)
    .set({ name, direction, isRecoverable: input.isRecoverable, accountId: input.accountId })
    .where(eq(taxCode.code, code));
  await recordChange(tx, ctx, {
    action: 'tax_code.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name, direction: before.direction, isRecoverable: before.isRecoverable, accountId: before.accountId },
    after: { name, direction, isRecoverable: input.isRecoverable, accountId: input.accountId },
  });
  return get(tx, code);
}

/**
 * A new rate from a date. Rates already written stay: a document dated before
 * `effectiveFrom` still reads the old one. One rate per date.
 */
export async function addRate(tx: Tx, ctx: ActorContext, code: string, input: { readonly ratePercent: string; readonly effectiveFrom: string }) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  await get(tx, code);
  const rate = normaliseRate(input.ratePercent);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new AdminValidationError('effectiveFrom', 'is a date');
  const [taken] = await tx
    .select({ id: taxRate.id })
    .from(taxRate)
    .where(and(eq(taxRate.taxCodeRef, code), eq(taxRate.effectiveFrom, input.effectiveFrom)))
    .limit(1);
  if (taken) {
    throw new AdminValidationError('effectiveFrom', `${code} already has a rate from ${input.effectiveFrom}; a rate is never changed, add one from another date`);
  }
  await tx.insert(taxRate).values({ taxCodeRef: code, ratePercent: rate, effectiveFrom: input.effectiveFrom, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, {
    action: 'tax_code.rate_added',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { rate, effectiveFrom: input.effectiveFrom },
  });
  return detail(tx, code);
}

export async function setActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason: string | null) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  if (before.active === active) return before;
  if (!active && !reason?.trim()) throw new AdminValidationError('reason', 'is required to deactivate a tax code');
  await tx.update(taxCode).set({ active }).where(eq(taxCode.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'tax_code.reactivated' : 'tax_code.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}
