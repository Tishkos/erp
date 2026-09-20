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
import { businessPartner, itemSupplier, paymentTerms } from '../db/schema';
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
  input: PartnerInput & { readonly code?: string; readonly confirmedNotDuplicate?: boolean },
) {
  const legalName = requireText(input.legalName, 'legalName');

  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(legalName), async (candidate) => {
        const [row] = await tx
          .select({ code: businessPartner.code })
          .from(businessPartner)
          .where(eq(businessPartner.code, candidate));
        return Boolean(row);
      });

  const [existing] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, isCustomer: businessPartner.isCustomer, isSupplier: businessPartner.isSupplier })
    .from(businessPartner)
    .where(eq(businessPartner.code, code))
    .limit(1);

  if (existing) {
    // The code is taken. If it is taken by a partner that simply lacks this
    // role, grant it; otherwise the person is trying to create a duplicate.
    const alreadyInRole = role === 'customer' ? existing.isCustomer : existing.isSupplier;
    if (alreadyInRole) {
      throw new AdminValidationError('code', `'${code}' is already a ${role}`);
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

  const created = await createPartner(tx, ctx, {
    code,
    legalName,
    tradeName: input.tradeName ?? null,
    isCustomer: role === 'customer',
    isSupplier: role === 'supplier',
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

/** Active partners in a role — for the pickers later phases will need. */
export async function listActiveInRole(tx: Tx, role: PartnerRole) {
  return tx
    .select({
      id: businessPartner.id,
      code: businessPartner.code,
      name: businessPartner.legalName,
      // Carried with the partner because the documents they head need it: a
      // due date the screen can fill before the invoice is saved (§16).
      paymentTermsCode: businessPartner.paymentTermsCode,
    })
    .from(businessPartner)
    .where(
      and(
        eq(businessPartner.active, true),
        role === 'customer'
          ? eq(businessPartner.isCustomer, true)
          : eq(businessPartner.isSupplier, true),
      ),
    )
    .orderBy(asc(businessPartner.code));
}

export { loadPartner };
