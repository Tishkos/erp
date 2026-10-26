/**
 * Customers and suppliers — Phase 2 requirements 2 and 3.
 *
 * *"Customer records can be created and maintained with the basic information
 *  required for future Accounts Receivable, sales and collection
 *  transactions."* — and the same sentence again for suppliers.
 *
 * ── Two screens, one record ────────────────────────────────────────────────
 * The sponsor asks for customers and suppliers separately, and that is how the
 * menu offers them: two screens, each asking only what its role needs. But §6
 * is explicit that *"one record serves CRM, Sales, Finance, Projects,
 * Logistics and Money Transfer"*, and §3.1 requires one authoritative record
 * per party. A company that both buys from us and sells to us is one legal
 * person; two records for it would make netting their balances impossible and
 * would let the two halves disagree about their own address.
 *
 * So customer and supplier are **roles on one record**. Opening the Customers
 * screen and adding a company that already exists as a supplier gives that
 * company the customer role — it does not make a second company. The record
 * page shows both roles, and says when a partner holds both.
 *
 * This file is the master-data layer over `business-partner.ts`: the lists the
 * screens read, the code a new partner is given, and the deactivation. The
 * duplicate search, the role-required-fields check and the bank-detail
 * approval lifecycle all live in that module and are called from here — none
 * of them is reimplemented, because two implementations of "is this a
 * duplicate?" would eventually answer differently.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessPartner, currency as currencyTable, itemSupplier, paymentTerms } from '../db/schema';
import * as audit from './audit';
import {
  AdminNotFoundError,
  AdminValidationError,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import { can } from '../domain/permissions';
import { allocateFreeCode } from './numbering';
import { createPartner, loadPartner, updatePartner, PERMISSION_OBJECT } from './business-partner';

export { PERMISSION_OBJECT };

export type PartnerRole = 'customer' | 'supplier';

export const PARTNER_STATUSES = ['prospect', 'active', 'on_hold', 'blocked', 'inactive'] as const;
export type PartnerStatusValue = (typeof PARTNER_STATUSES)[number];

export interface PartnerInput {
  readonly legalName: string;
  readonly tradeName?: string | null;
  readonly registrationNo?: string | null;
  readonly taxIdentifier?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly paymentTermsCode?: string | null;
  readonly creditLimitIqd?: string | null;
  readonly creditTermsDays?: string | null;
  /** The currency they deal in (0428): one of Currencies and Rates', or empty for not said. */
  readonly currency?: string | null;
}

/** A currency named for a partner must be one of Currencies and Rates', in use. Empty is "not said". */
async function assertCurrency(tx: Tx, code: string | null | undefined): Promise<string | null> {
  const wanted = (code ?? '').trim().toUpperCase();
  if (!wanted) return null;
  const [row] = await tx
    .select({ code: currencyTable.code, active: currencyTable.isActive })
    .from(currencyTable)
    .where(eq(currencyTable.code, wanted))
    .limit(1);
  if (!row?.active) throw new AdminValidationError('currency', `'${wanted}' is not a currency in use. Choose one from Currencies and Rates.`);
  return row.code;
}

/** Sets the partner's currency, audited with before and after. */
async function setCurrency(tx: Tx, ctx: ActorContext, partnerId: string, currency: string | null): Promise<void> {
  const [before] = await tx.select({ code: businessPartner.code, currency: businessPartner.currency }).from(businessPartner).where(eq(businessPartner.id, partnerId)).limit(1);
  if (!before || (before.currency ?? null) === currency) return;
  await tx.update(businessPartner).set({ currency, updatedAt: new Date() }).where(eq(businessPartner.id, partnerId));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'business_partner.currency_set',
    objectType: PERMISSION_OBJECT,
    objectId: partnerId,
    branchCode: ctx.branchCode,
    before: { code: before.code, currency: before.currency },
    after: { code: before.code, currency },
    outcome: 'success',
  });
}

/**
 * The partners holding a role, or — with no role — all of them.
 *
 * A partner holding both roles appears on both screens. That is the point: it
 * is the same record, seen from the side the reader is working on.
 */
export async function listByRole(tx: Tx, role?: PartnerRole) {
  return tx
    .select({
      id: businessPartner.id,
      code: businessPartner.code,
      legalName: businessPartner.legalName,
      tradeName: businessPartner.tradeName,
      isCustomer: businessPartner.isCustomer,
      isSupplier: businessPartner.isSupplier,
      status: businessPartner.status,
      email: businessPartner.email,
      phone: businessPartner.phone,
      paymentTermsCode: businessPartner.paymentTermsCode,
      creditLimitIqd: businessPartner.creditLimitIqd,
      active: businessPartner.active,
    })
    .from(businessPartner)
    .where(
      role === 'customer'
        ? eq(businessPartner.isCustomer, true)
        : role === 'supplier'
          ? eq(businessPartner.isSupplier, true)
          : sql`true`,
    )
    .orderBy(asc(businessPartner.code));
}

export async function getByCode(tx: Tx, code: string) {
  const [row] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.code, code))
    .limit(1);
  if (!row) throw new AdminNotFoundError('business partner', code);
  return row;
}

export async function detail(tx: Tx, code: string) {
  const row = await getByCode(tx, code);
  const [terms] = row.paymentTermsCode
    ? await tx
        .select({ name: paymentTerms.name })
        .from(paymentTerms)
        .where(eq(paymentTerms.code, row.paymentTermsCode))
        .limit(1)
    : [];
  // What a supplier is on the hook for — shown so that removing the supplier
  // role explains itself before the database refuses it.
  const items = row.isSupplier
    ? await tx
        .select({ itemId: itemSupplier.itemId, isDefault: itemSupplier.isDefault })
        .from(itemSupplier)
        .where(eq(itemSupplier.supplierId, row.id))
    : [];
  return {
    ...row,
    paymentTermsName: terms?.name ?? null,
    itemCount: items.length,
    defaultForItems: items.filter((i) => i.isDefault).length,
  };
}

async function assertTerms(tx: Tx, code: string | null): Promise<string | null> {
  if (!code) return null;
  const [row] = await tx
    .select({ code: paymentTerms.code, active: paymentTerms.active })
    .from(paymentTerms)
    .where(eq(paymentTerms.code, code))
    .limit(1);
  if (!row) throw new AdminValidationError('paymentTermsCode', 'is not a known payment term');
  if (!row.active) throw new AdminValidationError('paymentTermsCode', 'is not active');
  return row.code;
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

/**
 * Creates a partner in the given role, or adds the role to the partner that is
 * already there.
 *
 * The second case is the one that matters. Someone opening Customers and
 * typing the name of an existing supplier means "this supplier is also a
 * customer", not "make me a second record" — and §3.1 does not permit the
 * second reading. `business-partner.ts` would refuse the duplicate anyway; the
 * point of handling it here is that the person gets what they meant.
 */
export async function createInRole(
  tx: Tx,
  ctx: ActorContext,
  role: PartnerRole,
  input: PartnerInput & { readonly confirmedNotDuplicate?: boolean },
) {
  const legalName = requireText(input.legalName, 'legalName');

  // The same name, exactly, is the same partner: a supplier typed in on the
  // Customers screen is a supplier who is also a customer (§3.1).
  const [existing] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, isCustomer: businessPartner.isCustomer, isSupplier: businessPartner.isSupplier })
    .from(businessPartner)
    .where(sql`lower(btrim(${businessPartner.legalName})) = lower(${legalName})`)
    .limit(1);

  if (existing) {
    const alreadyInRole = role === 'customer' ? existing.isCustomer : existing.isSupplier;
    if (alreadyInRole) {
      throw new AdminValidationError('legalName', `'${legalName}' is already a ${role} (${existing.code})`);
    }
    await updatePartner(
      tx,
      ctx,
      existing.id,
      role === 'customer' ? { isCustomer: true } : { isSupplier: true },
      `also a ${role}`,
    );
    return { id: existing.id, code: existing.code };
  }

  // Minted, never typed — Critical Rule 1 (migration 0208). CUS- for a
  // customer, SUP- for a supplier; a partner that later takes the other role
  // keeps the code it was given.
  const code = await allocateFreeCode(
    tx,
    role === 'customer' ? 'CUSTOMER_CODE' : 'SUPPLIER_CODE',
    async (candidate) => {
      const [row] = await tx
        .select({ code: businessPartner.code })
        .from(businessPartner)
        .where(eq(businessPartner.code, candidate));
      return Boolean(row);
    },
    ctx.principal.userId,
  );

  const created = await createPartner(tx, ctx, {
    code,
    legalName,
    tradeName: input.tradeName ?? null,
    isCustomer: role === 'customer',
    isSupplier: role === 'supplier',
    // §6 — a partner is usable on a document once it is approved (status
    // `active`); a prospect is not, and a purchase order or sales order
    // against one is refused. Approving is the `approve` grant on the record
    // (§4.4: status is a sensitive field). Whoever holds it enters the partner
    // approved — it is their decision to make, and making them take a second
    // step to agree with themselves is ceremony. Whoever does not (the
    // accounting officer) enters a prospect, which somebody who does approves
    // on its record (`approve` below).
    //
    // Until 2026-10-04 every partner made here was a prospect and nothing
    // could approve it, so a supplier the screens called "Active" could not
    // be ordered from.
    status: can(ctx.principal, 'approve', PERMISSION_OBJECT) ? 'active' : 'prospect',
    registrationNo: input.registrationNo ?? null,
    taxIdentifier: input.taxIdentifier ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    address: input.address ?? null,
    creditLimitIqd: assertAmount(input.creditLimitIqd, 'creditLimitIqd'),
    creditTermsDays: input.creditTermsDays?.trim() || null,
    confirmedNotDuplicate: input.confirmedNotDuplicate ?? false,
  });

  // The terms are not part of `createPartner`'s input, so they are set after —
  // still in this transaction, so a partner is never briefly termless.
  const terms = await assertTerms(tx, input.paymentTermsCode ?? null);
  if (terms) {
    await tx
      .update(businessPartner)
      .set({ paymentTermsCode: terms })
      .where(eq(businessPartner.id, created.id));
  }
  // The currency they deal in, chosen on the New customer form (0428).
  const currency = await assertCurrency(tx, input.currency);
  if (currency) await setCurrency(tx, ctx, created.id, currency);
  return created;
}

/** Edits the record behind either screen. */
export async function updateByCode(tx: Tx, ctx: ActorContext, code: string, input: PartnerInput) {
  const before = await getByCode(tx, code);
  await updatePartner(tx, ctx, before.id, {
    legalName: requireText(input.legalName, 'legalName'),
    tradeName: input.tradeName?.trim() || null,
    registrationNo: input.registrationNo?.trim() || null,
    taxIdentifier: input.taxIdentifier?.trim() || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    address: input.address?.trim() || null,
    creditLimitIqd: assertAmount(input.creditLimitIqd, 'creditLimitIqd'),
    creditTermsDays: input.creditTermsDays?.trim() || null,
  });
  const terms = await assertTerms(tx, input.paymentTermsCode ?? null);
  await tx
    .update(businessPartner)
    .set({ paymentTermsCode: terms })
    .where(eq(businessPartner.id, before.id));
  // A form that asks the currency sends it; one that does not leaves it as it is (0428).
  if (input.currency !== undefined) await setCurrency(tx, ctx, before.id, await assertCurrency(tx, input.currency));
  return getByCode(tx, code);
}

/**
 * Adds or removes a role.
 *
 * Removing the supplier role from a partner that items are linked to is
 * refused by the database — this asks first, so the answer arrives as a
 * sentence rather than as a constraint violation.
 */
export async function setRole(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  role: PartnerRole,
  held: boolean,
) {
  const before = await getByCode(tx, code);
  const other = role === 'customer' ? before.isSupplier : before.isCustomer;
  if (!held && !other) {
    throw new AdminValidationError(
      'role',
      'a partner must be a customer, a supplier, or both — this is their only role',
    );
  }
  if (!held && role === 'supplier') {
    const [linked] = await tx
      .select({ itemId: itemSupplier.itemId })
      .from(itemSupplier)
      .where(eq(itemSupplier.supplierId, before.id))
      .limit(1);
    if (linked) {
      throw new AdminValidationError('role', 'is the named supplier of at least one item');
    }
  }
  await updatePartner(
    tx,
    ctx,
    before.id,
    role === 'customer' ? { isCustomer: held } : { isSupplier: held },
    held ? `granted the ${role} role` : `removed the ${role} role`,
  );
  return getByCode(tx, code);
}

export async function setActive(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  active: boolean,
  reason: string | null,
) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, code);
  const before = await getByCode(tx, code);
  if (before.active === active) return before;
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate a partner');
  }
  await tx
    .update(businessPartner)
    .set({ active, updatedAt: new Date() })
    .where(eq(businessPartner.id, before.id));
  await recordChange(tx, ctx, {
    action: active ? 'business_partner.reactivated' : 'business_partner.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: before.id,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return getByCode(tx, code);
}

/**
 * §6 — a prospect becomes an approved partner (status `active`), usable on a
 * purchase order, a sales order and the documents' pickers.
 *
 * Status is a sensitive field (§4.4), so this is the `approve` grant on the
 * record; `updatePartner` asks for it again and keeps the before and after.
 * Only a prospect is approved here, and only a partner in use — a
 * deactivated one is reactivated first, so the two switches are never
 * flipped by one click.
 */
export async function approve(tx: Tx, ctx: ActorContext, code: string) {
  await permit(ctx, 'approve', PERMISSION_OBJECT, code);
  const before = await getByCode(tx, code);
  if (before.status !== 'prospect') {
    throw new AdminValidationError('status', `is ${before.status.replace('_', ' ')}; only a prospect is approved`);
  }
  if (!before.active) {
    throw new AdminValidationError('active', 'the partner is deactivated; reactivate it before approving it');
  }
  await updatePartner(tx, ctx, before.id, { status: 'active' }, 'approved');
  return getByCode(tx, code);
}

/**
 * Partners in a role that a new document may name — for the pickers.
 *
 * Usable means in use (`active`) **and** approved (status `active`): the rule
 * `domain/business-partner.assertUsableForTransaction` states and the
 * purchase order's check (and migration 0031's trigger) enforces. A picker
 * that offered a prospect let the buyer fill in a whole purchase invoice for
 * an import and be refused at the end (2026-10-04).
 */
export async function listActiveInRole(tx: Tx, role: PartnerRole) {
  return tx
    .select({
      id: businessPartner.id,
      code: businessPartner.code,
      name: businessPartner.legalName,
      // Carried with the partner because the documents they head need it: a
      // due date the screen can fill before the invoice is saved (§16).
      paymentTermsCode: businessPartner.paymentTermsCode,
      // The currency they deal in (0428) — what a payment or receipt form says beside their name.
      currency: businessPartner.currency,
    })
    .from(businessPartner)
    .where(
      and(
        eq(businessPartner.active, true),
        eq(businessPartner.status, 'active'),
        role === 'customer'
          ? eq(businessPartner.isCustomer, true)
          : eq(businessPartner.isSupplier, true),
      ),
    )
    .orderBy(asc(businessPartner.code));
}

export { loadPartner };
