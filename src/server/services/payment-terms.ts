/**
 * Payment terms — Phase 2 requirement 7.
 *
 * *"Standard payment terms can be created and maintained so they can be
 *  assigned later to customers, suppliers and related transactions."*
 *
 * A term answers one question: given a document dated D, when is it due? The
 * arithmetic that answers it already exists, pure and tested, in
 * `domain/payment-terms.ts` — this file is the maintenance around it, and it
 * calls that domain to *check* what it is about to save.
 *
 * ── Why instalments are validated as a set ─────────────────────────────────
 * §16 allows a term to fall due in parts. The parts must total 100%: a term
 * adding to 90% leaves a tenth of every invoice raised under it never falling
 * due, and nobody notices until the ledger is chased. The rows arrive one at a
 * time from a form, so only the finished set can be judged — which is why the
 * whole schedule is replaced in one transaction and checked before it commits.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessPartner, paymentTermInstalment, paymentTerms } from '../db/schema';
import {
  assertInstalmentsComplete,
  DUE_DATE_BASIS,
  dueDateFor,
  type DueDateBasis,
} from '../domain/payment-terms';
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

export const PERMISSION_OBJECT = 'payment_term';

export interface InstalmentInput {
  readonly daysAfter: number;
  /** A percentage, as a decimal string. */
  readonly percentage: string;
}

export interface PaymentTermsInput {
  readonly name: string;
  readonly basis: string;
  readonly dueDays: number;
  readonly discountPercent?: string | null;
  readonly discountDays?: number | null;
  readonly instalments?: readonly InstalmentInput[];
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: paymentTerms.code,
      name: paymentTerms.name,
      basis: paymentTerms.basis,
      dueDays: paymentTerms.dueDays,
      discountPercent: paymentTerms.discountPercent,
      discountDays: paymentTerms.discountDays,
      active: paymentTerms.active,
    })
    .from(paymentTerms)
    .orderBy(asc(paymentTerms.code));
}

export async function listActive(tx: Tx) {
  return tx
    .select({ code: paymentTerms.code, name: paymentTerms.name })
    .from(paymentTerms)
    .where(eq(paymentTerms.active, true))
    .orderBy(asc(paymentTerms.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(paymentTerms).where(eq(paymentTerms.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('payment terms', code);
  return row;
}

export async function instalmentsOf(tx: Tx, code: string) {
  return tx
    .select({
      sequence: paymentTermInstalment.sequence,
      daysAfter: paymentTermInstalment.daysAfter,
      percentage: paymentTermInstalment.percentage,
    })
    .from(paymentTermInstalment)
    .where(eq(paymentTermInstalment.termsCode, code))
    .orderBy(asc(paymentTermInstalment.sequence));
}

/**
 * The record page's view: the term, its schedule, and a worked example.
 *
 * The example is the point of the screen. "30 days, end of month" is a
 * sentence two people read differently; a date computed from a real document
 * date is not, and it is computed by the same function the invoice will use.
 */
export async function detail(tx: Tx, code: string, exampleDate: string) {
  const row = await get(tx, code);
  const instalments = await instalmentsOf(tx, code);
  const partners = await tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.paymentTermsCode, code))
    .orderBy(asc(businessPartner.code));

  const dueDate = dueDateFor(
    {
      code: row.code,
      name: row.name,
      basis: row.basis as DueDateBasis,
      dueDays: row.dueDays,
      instalments: instalments.map((i) => ({
        sequence: i.sequence,
        daysAfter: i.daysAfter,
        percentage: i.percentage,
      })),
    },
    exampleDate,
  );

  return { ...row, instalments, partners, exampleDate, dueDate };
}

function assertBasis(value: string): DueDateBasis {
  if (!(DUE_DATE_BASIS as readonly string[]).includes(value)) {
    throw new AdminValidationError('basis', 'must be the document date or the end of the month');
  }
  return value as DueDateBasis;
}

function assertDays(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 3650) {
    throw new AdminValidationError(field, 'must be a whole number of days between 0 and 3650');
  }
  return value;
}

/**
 * The early-settlement discount: both parts or neither.
 *
 * A percentage with no deadline is a discount that never expires; a deadline
 * with no percentage is worth nothing. The database refuses each half alone —
 * this says so in words a person can act on before it gets there.
 */
function assertDiscount(percent: string | null, days: number | null) {
  const hasPercent = percent !== null && percent.trim() !== '';
  const hasDays = days !== null;
  if (hasPercent !== hasDays) {
    throw new AdminValidationError(
      'discount',
      'needs both a percentage and a number of days, or neither',
    );
  }
  if (!hasPercent) return { discountPercent: null, discountDays: null };

  const value = Number(percent);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new AdminValidationError('discountPercent', 'must be greater than 0 and at most 100');
  }
  return { discountPercent: percent!.trim(), discountDays: assertDays(days!, 'discountDays') };
}

/** Replaces the whole schedule, and refuses one that does not add to 100%. */
async function writeInstalments(
  tx: Tx,
  code: string,
  name: string,
  basis: DueDateBasis,
  dueDays: number,
  instalments: readonly InstalmentInput[],
) {
  const rows = instalments
    .filter((i) => String(i.percentage).trim() !== '')
    .map((instalment, index) => ({
      termsCode: code,
      sequence: index + 1,
      daysAfter: assertDays(instalment.daysAfter, 'daysAfter'),
      percentage: String(instalment.percentage).trim(),
    }));

  // Checked before it is written, by the same function the invoice trusts.
  assertInstalmentsComplete({
    code,
    name,
    basis,
    dueDays,
    instalments: rows.map((r) => ({
      sequence: r.sequence,
      daysAfter: r.daysAfter,
      percentage: r.percentage,
    })),
  });

  await tx.delete(paymentTermInstalment).where(eq(paymentTermInstalment.termsCode, code));
  if (rows.length > 0) await tx.insert(paymentTermInstalment).values(rows);
  return rows;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: PaymentTermsInput & { readonly code?: string },
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(name), async (candidate) => {
        const [row] = await tx
          .select({ code: paymentTerms.code })
          .from(paymentTerms)
          .where(eq(paymentTerms.code, candidate));
        return Boolean(row);
      });

  const [existing] = await tx
    .select({ code: paymentTerms.code })
    .from(paymentTerms)
    .where(eq(paymentTerms.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already a payment term`);

  const basis = assertBasis(input.basis);
  const dueDays = assertDays(input.dueDays, 'dueDays');
  const discount = assertDiscount(input.discountPercent ?? null, input.discountDays ?? null);

  await tx.insert(paymentTerms).values({ code, name, basis, dueDays, ...discount, active: true });
  const rows = await writeInstalments(tx, code, name, basis, dueDays, input.instalments ?? []);

  await recordChange(tx, ctx, {
    action: 'payment_term.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, name, basis, dueDays, ...discount, instalments: rows.length },
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: PaymentTermsInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const beforeInstalments = await instalmentsOf(tx, code);

  const name = requireText(input.name, 'name');
  const basis = assertBasis(input.basis);
  const dueDays = assertDays(input.dueDays, 'dueDays');
  const discount = assertDiscount(input.discountPercent ?? null, input.discountDays ?? null);

  await tx.update(paymentTerms).set({ name, basis, dueDays, ...discount }).where(eq(paymentTerms.code, code));
  const rows = await writeInstalments(tx, code, name, basis, dueDays, input.instalments ?? []);

  await recordChange(tx, ctx, {
    action: 'payment_term.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: {
      name: before.name,
      basis: before.basis,
      dueDays: before.dueDays,
      discountPercent: before.discountPercent,
      discountDays: before.discountDays,
      instalments: beforeInstalments.length,
    },
    after: { name, basis, dueDays, ...discount, instalments: rows.length },
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
    throw new AdminValidationError('reason', 'is required to deactivate a payment term');
  }
  // A partner whose terms were retired would have no answer to "when is this
  // due?" the next time an invoice is raised for them.
  if (!active) {
    const [inUse] = await tx
      .select({ code: businessPartner.code })
      .from(businessPartner)
      .where(and(eq(businessPartner.paymentTermsCode, code), eq(businessPartner.active, true)))
      .limit(1);
    if (inUse) {
      throw new AdminValidationError('code', `is still the payment term of partner ${inUse.code}`);
    }
  }
  await tx.update(paymentTerms).set({ active }).where(eq(paymentTerms.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'payment_term.reactivated' : 'payment_term.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}
