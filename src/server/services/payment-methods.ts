/**
 * Payment methods — Phase 2 requirement 8.
 *
 * *"Standard payment methods can be created and maintained for future receipts
 *  and payments, such as cash, bank transfer and cheque."*
 *
 * ── Method and kind are not the same thing ─────────────────────────────────
 * The three examples the requirement gives are *methods*. The `kind` beneath
 * them — bank, cash or transfer — is the rail the money actually moves on, and
 * it is what later phases branch on: a cash method draws on a cash account, a
 * bank method on a bank account, a transfer on the money-transfer module.
 *
 * A cheque is therefore a method of kind `bank`. It settles through a bank
 * account and reconciles against a bank statement, which is everything the
 * system needs to know about it; naming a fourth kind would add a branch to
 * every payment path that behaved identically to `bank`.
 *
 * ── The fee ────────────────────────────────────────────────────────────────
 * §4.3 lists fees on the method. A fee needs somewhere to post, and a fee with
 * nowhere to post is a cost nobody accounts for — so the account is required
 * exactly when the percentage is non-zero. The database says the same; this
 * says it in words, before a person gets there.
 */
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { chartOfAccount, paymentMethod } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  codeFromName,
  normaliseCode,
  permit,
  recordChange,
  requireText,
  uniqueCode,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'payment_method';

export const PAYMENT_METHOD_KINDS = ['bank', 'cash', 'transfer'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface PaymentMethodInput {
  readonly name: string;
  readonly kind: string;
  readonly feePercent?: string | null;
  readonly feeAccountId?: string | null;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: paymentMethod.code,
      name: paymentMethod.name,
      kind: paymentMethod.kind,
      feePercent: paymentMethod.feePercent,
      feeAccountId: paymentMethod.feeAccountId,
      feeAccountCode: chartOfAccount.code,
      feeAccountName: chartOfAccount.name,
      active: paymentMethod.active,
    })
    .from(paymentMethod)
    .leftJoin(chartOfAccount, eq(chartOfAccount.id, paymentMethod.feeAccountId))
    .orderBy(asc(paymentMethod.code));
}

export async function listActive(tx: Tx) {
  return tx
    .select({ code: paymentMethod.code, name: paymentMethod.name, kind: paymentMethod.kind })
    .from(paymentMethod)
    .where(eq(paymentMethod.active, true))
    .orderBy(asc(paymentMethod.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(paymentMethod).where(eq(paymentMethod.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('payment method', code);
  return row;
}

export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [account] = row.feeAccountId
    ? await tx
        .select({ code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(eq(chartOfAccount.id, row.feeAccountId))
        .limit(1)
    : [];
  return { ...row, feeAccount: account ? `${account.code} · ${account.name}` : null };
}

function assertKind(value: string): PaymentMethodKind {
  if (!(PAYMENT_METHOD_KINDS as readonly string[]).includes(value)) {
    throw new AdminValidationError('kind', 'must be bank, cash or transfer');
  }
  return value as PaymentMethodKind;
}

/** A fee and the account it posts to, checked together. */
async function assertFee(tx: Tx, percent: string | null | undefined, accountId: string | null) {
  const raw = (percent ?? '').trim();
  const value = raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new AdminValidationError('feePercent', 'must be between 0 and 100');
  }
  if (value === 0) return { feePercent: '0', feeAccountId: null };

  if (!accountId) {
    throw new AdminValidationError('feeAccountId', 'is required when a fee is charged');
  }
  const [account] = await tx
    .select({ id: chartOfAccount.id, isGroup: chartOfAccount.isGroup })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, accountId))
    .limit(1);
  if (!account) throw new AdminValidationError('feeAccountId', 'is not a known account');
  // A header carries the sum of what is beneath it; nothing posts to it.
  if (account.isGroup) throw new AdminValidationError('feeAccountId', 'is a header, not a posting account');

  return { feePercent: raw, feeAccountId: account.id };
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: PaymentMethodInput & { readonly code?: string },
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(name), async (candidate) => {
        const [row] = await tx
          .select({ code: paymentMethod.code })
          .from(paymentMethod)
          .where(eq(paymentMethod.code, candidate));
        return Boolean(row);
      });

  const [existing] = await tx
    .select({ code: paymentMethod.code })
    .from(paymentMethod)
    .where(eq(paymentMethod.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already a payment method`);

  const kind = assertKind(input.kind);
  const fee = await assertFee(tx, input.feePercent, input.feeAccountId ?? null);

  await tx.insert(paymentMethod).values({ code, name, kind, ...fee, active: true });
  await recordChange(tx, ctx, {
    action: 'payment_method.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, name, kind, ...fee },
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: PaymentMethodInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const name = requireText(input.name, 'name');
  const kind = assertKind(input.kind);
  const fee = await assertFee(tx, input.feePercent, input.feeAccountId ?? null);

  await tx.update(paymentMethod).set({ name, kind, ...fee }).where(eq(paymentMethod.code, code));
  await recordChange(tx, ctx, {
    action: 'payment_method.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: {
      name: before.name,
      kind: before.kind,
      feePercent: before.feePercent,
      feeAccountId: before.feeAccountId,
    },
    after: { name, kind, ...fee },
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
    throw new AdminValidationError('reason', 'is required to deactivate a payment method');
  }
  await tx.update(paymentMethod).set({ active }).where(eq(paymentMethod.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'payment_method.reactivated' : 'payment_method.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}
