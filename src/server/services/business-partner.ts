/**
 * Business Partner service — Phase 03.2.
 *
 * Two controls carry this module, and both are §4.4:
 *
 *   duplicate search before saving — because the damage from two records for
 *   one company is discovered late and is expensive to unwind;
 *
 *   approval before a bank detail change takes effect — because a supplier's
 *   account number is the highest-value fraud target in an ERP, and §15
 *   requires the verification to be independent.
 */
import { and, eq, ne, or, sql } from 'drizzle-orm';
import {
  DuplicatePartnerError,
  assertHasRole,
  assertRoleFields,
  matchedIdentifiers,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  type DuplicateMatch,
  type PartnerIdentity,
  type PartnerRole,
  type PartnerStatus,
} from '../domain/business-partner';
import {
  businessPartner,
  partnerBankAccount,
  partnerRoleRequiredField,
} from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as statuses from './statuses';
import * as workflow from './workflow';

export const PERMISSION_OBJECT = 'business_partner';
export const BANK_DOCUMENT_TYPE = 'partner_bank_account';

export class PartnerNotFoundError extends Error {
  readonly code = 'PARTNER_NOT_FOUND';
  constructor(id: string) {
    super(`No business partner with id '${id}'.`);
    this.name = 'PartnerNotFoundError';
  }
}

export interface CreatePartnerInput {
  readonly code: string;
  readonly legalName: string;
  readonly tradeName?: string | null;
  readonly isCustomer?: boolean;
  readonly isSupplier?: boolean;
  readonly status?: PartnerStatus;
  readonly registrationNo?: string | null;
  readonly taxIdentifier?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly creditLimitIqd?: string | null;
  readonly creditTermsDays?: string | null;
  /**
   * Set only after a user has seen the duplicate warning and confirmed the new
   * record is a genuinely different party. §4.4 requires the search to run
   * before saving; it does not require the answer to be final.
   */
  readonly confirmedNotDuplicate?: boolean;
}

/**
 * §4.4 — the duplicate search, run before saving.
 *
 * Returns matches rather than a boolean, because the user needs to see *which*
 * record and *why* it matched. A warning that says only "possible duplicate" is
 * a warning people learn to click through.
 */
export async function findDuplicates(
  tx: Tx,
  candidate: PartnerIdentity,
  excludePartnerId?: string,
): Promise<DuplicateMatch[]> {
  const name = normaliseName(candidate.legalName);
  const email = candidate.email ? normaliseEmail(candidate.email) : null;
  const phone = candidate.phone ? normalisePhone(candidate.phone) : null;

  const rows = await tx
    .select({
      id: businessPartner.id,
      code: businessPartner.code,
      legalName: businessPartner.legalName,
      registrationNo: businessPartner.registrationNo,
      taxIdentifier: businessPartner.taxIdentifier,
      email: businessPartner.email,
      phone: businessPartner.phone,
    })
    .from(businessPartner)
    .where(
      and(
        excludePartnerId ? ne(businessPartner.id, excludePartnerId) : sql`true`,
        or(
          // The comparison is done in SQL for the shortlist and confirmed in
          // the domain, so both sides use the same normalisation rules.
          sql`lower(regexp_replace(${businessPartner.legalName}, '[^a-zA-Z0-9 ]+', ' ', 'g')) like ${`%${name}%`}`,
          candidate.registrationNo
            ? eq(businessPartner.registrationNo, candidate.registrationNo.trim())
            : sql`false`,
          candidate.taxIdentifier
            ? eq(businessPartner.taxIdentifier, candidate.taxIdentifier.trim())
            : sql`false`,
          email ? sql`lower(${businessPartner.email}) = ${email}` : sql`false`,
          phone
            ? sql`regexp_replace(${businessPartner.phone}, '\\D+', '', 'g') like ${`%${phone}`}`
            : sql`false`,
        ),
      ),
    )
    .limit(25);

  const matches: DuplicateMatch[] = [];
  for (const row of rows) {
    const matchedOn = matchedIdentifiers(candidate, row);
    if (matchedOn.length > 0) {
      matches.push({
        partnerId: row.id,
        partnerCode: row.code,
        legalName: row.legalName,
        matchedOn,
      });
    }
  }

  return matches;
}

async function requiredFieldsFor(tx: Tx, role: PartnerRole): Promise<string[]> {
  const rows = await tx
    .select({ fieldName: partnerRoleRequiredField.fieldName })
    .from(partnerRoleRequiredField)
    .where(eq(partnerRoleRequiredField.role, role));

  return rows.map((r) => r.fieldName);
}

/**
 * Creates a partner, after the §4.4 duplicate search.
 *
 * The search runs on every save. If it finds anything the save is refused until
 * the caller confirms — and the confirmation is audited, so "we checked" is a
 * record rather than a claim.
 */
export async function createPartner(
  tx: Tx,
  ctx: ActorContext,
  input: CreatePartnerInput,
): Promise<{ id: string; code: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const isCustomer = input.isCustomer ?? false;
  const isSupplier = input.isSupplier ?? false;
  assertHasRole({ isCustomer, isSupplier });

  const values = { ...input } as Record<string, unknown>;
  if (isCustomer) assertRoleFields('customer', await requiredFieldsFor(tx, 'customer'), values);
  if (isSupplier) assertRoleFields('supplier', await requiredFieldsFor(tx, 'supplier'), values);

  const duplicates = await findDuplicates(tx, input);
  if (duplicates.length > 0 && !input.confirmedNotDuplicate) {
    throw new DuplicatePartnerError(duplicates);
  }

  const [created] = await tx
    .insert(businessPartner)
    .values({
      code: input.code,
      legalName: input.legalName,
      tradeName: input.tradeName ?? null,
      isCustomer,
      isSupplier,
      status: input.status ?? 'prospect',
      registrationNo: input.registrationNo ?? null,
      taxIdentifier: input.taxIdentifier ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      creditLimitIqd: input.creditLimitIqd ?? null,
      creditTermsDays: input.creditTermsDays ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: businessPartner.id, code: businessPartner.code });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'business_partner.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: {
      code: created!.code,
      legalName: input.legalName,
      isCustomer,
      isSupplier,
      status: input.status ?? 'prospect',
      duplicatesOverridden: duplicates.length > 0 ? duplicates.map((d) => d.partnerCode) : null,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return created!;
}

/**
 * §4.4 — "Sensitive master changes … require approval and before/after audit
 * values."
 *
 * Credit limit and status are sensitive; name and address are not. The list is
 * short and explicit rather than clever, because a reader needs to be able to
 * check it against the blueprint.
 */
const SENSITIVE_FIELDS = new Set(['creditLimitIqd', 'creditTermsDays', 'status']);

export async function updatePartner(
  tx: Tx,
  ctx: ActorContext,
  partnerId: string,
  changes: Partial<CreatePartnerInput>,
  reason?: string | null,
): Promise<void> {
  const touchesSensitive = Object.keys(changes).some((key) => SENSITIVE_FIELDS.has(key));

  await authz.authorize(ctx.principal, touchesSensitive ? 'approve' : 'edit_draft', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: partnerId,
    requestId: ctx.requestId ?? null,
  });

  const [before] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, partnerId))
    .limit(1);

  if (!before) throw new PartnerNotFoundError(partnerId);

  await tx
    .update(businessPartner)
    .set({ ...changes, updatedAt: new Date() } as never)
    .where(eq(businessPartner.id, partnerId));

  // §4.4 — both values, on every sensitive change.
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'business_partner.updated',
    objectType: PERMISSION_OBJECT,
    objectId: partnerId,
    branchCode: ctx.branchCode,
    before: Object.fromEntries(
      Object.keys(changes).map((key) => [key, (before as Record<string, unknown>)[key] ?? null]),
    ),
    after: { ...changes },
    reason: reason ?? null,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Bank details — §4.4, §15
// ---------------------------------------------------------------------------

export interface BankAccountInput {
  readonly bankName: string;
  readonly accountNumber: string;
  readonly iban?: string | null;
  readonly swift?: string | null;
  readonly currency?: string;
  readonly accountHolder?: string | null;
  readonly confirmedNotDuplicate?: boolean;
}

/**
 * Adds a set of bank details, in draft.
 *
 * It is not payable and does not replace anything until approved. §15:
 * "Supplier bank detail changes require independent verification and approval
 * before payment."
 */
export async function addBankAccount(
  tx: Tx,
  ctx: ActorContext,
  partnerId: string,
  input: BankAccountInput,
): Promise<{ id: string }> {
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: partnerId,
    requestId: ctx.requestId ?? null,
  });

  // §4.4 — duplicate search before saving bank accounts.
  const existing = await tx
    .select({ id: partnerBankAccount.id, partnerId: partnerBankAccount.partnerId })
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.accountNumber, input.accountNumber.trim()));

  const elsewhere = existing.filter((row) => row.partnerId !== partnerId);
  if (elsewhere.length > 0 && !input.confirmedNotDuplicate) {
    throw new DuplicatePartnerError(
      elsewhere.map((row) => ({
        partnerId: row.partnerId,
        partnerCode: '(another partner)',
        legalName: '',
        matchedOn: ['bank account number'],
      })),
    );
  }

  const [created] = await tx
    .insert(partnerBankAccount)
    .values({
      partnerId,
      bankName: input.bankName,
      accountNumber: input.accountNumber.trim(),
      iban: input.iban ?? null,
      swift: input.swift ?? null,
      currency: input.currency ?? 'IQD',
      accountHolder: input.accountHolder ?? null,
      approvalStatus: 'draft',
      isActive: false,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: partnerBankAccount.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'partner_bank_account.created',
    objectType: BANK_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    // The account number is not redacted: §4.4 requires before/after values on
    // sensitive master changes, and a bank detail change nobody can review is
    // not a controlled change. The audit trail's own access control is what
    // protects it.
    after: { partnerId, bankName: input.bankName, accountNumber: input.accountNumber },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return created!;
}

export async function submitBankAccount(
  tx: Tx,
  ctx: ActorContext,
  bankAccountId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: bankAccountId,
    requestId: ctx.requestId ?? null,
  });

  const [row] = await tx
    .select()
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.id, bankAccountId))
    .limit(1);

  if (!row) throw new PartnerNotFoundError(bankAccountId);

  await statuses.assertTransitionAllowed(tx, BANK_DOCUMENT_TYPE, row.approvalStatus, 'submitted');

  await workflow.submit(tx, {
    documentTypeCode: BANK_DOCUMENT_TYPE,
    documentId: bankAccountId,
    submittedBy: ctx.principal.userId,
    branchCode: ctx.branchCode,
  });

  await tx
    .update(partnerBankAccount)
    .set({ approvalStatus: 'submitted' })
    .where(eq(partnerBankAccount.id, bankAccountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'partner_bank_account.submitted',
    objectType: BANK_DOCUMENT_TYPE,
    objectId: bankAccountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: row.approvalStatus },
    after: { approvalStatus: 'submitted' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Approves a set of bank details, and retires whatever they replace.
 *
 * §15 requires the verification to be independent: the seeded route refuses
 * self-approval, so the person who entered the details cannot be the person who
 * approves them.
 */
export async function approveBankAccount(
  tx: Tx,
  ctx: ActorContext,
  bankAccountId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: bankAccountId,
    requestId: ctx.requestId ?? null,
  });

  const [row] = await tx
    .select()
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.id, bankAccountId))
    .limit(1);

  if (!row) throw new PartnerNotFoundError(bankAccountId);

  await statuses.assertTransitionAllowed(tx, BANK_DOCUMENT_TYPE, row.approvalStatus, 'approved');

  const outcome = await workflow.decide(tx, {
    documentTypeCode: BANK_DOCUMENT_TYPE,
    documentId: bankAccountId,
    actor: {
      userId: ctx.principal.userId,
      roles: ctx.principal.roleCodes,
      isDepartmentManager: false,
    },
    decision: 'approved',
  });

  if (!outcome.isComplete) return;

  // The previous details stay on the record as history; they simply stop being
  // the ones payments go to.
  await tx
    .update(partnerBankAccount)
    .set({ isActive: false })
    .where(
      and(
        eq(partnerBankAccount.partnerId, row.partnerId),
        eq(partnerBankAccount.isActive, true),
      ),
    );

  await tx
    .update(partnerBankAccount)
    .set({
      approvalStatus: 'approved',
      isActive: true,
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
    })
    .where(eq(partnerBankAccount.id, bankAccountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'partner_bank_account.approved',
    objectType: BANK_DOCUMENT_TYPE,
    objectId: bankAccountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: row.approvalStatus, isActive: false },
    after: { approvalStatus: 'approved', isActive: true, accountNumber: row.accountNumber },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** The details a payment may actually be made to — approved and active only. */
export async function payableBankAccount(tx: Tx, partnerId: string) {
  const [row] = await tx
    .select()
    .from(partnerBankAccount)
    .where(
      and(
        eq(partnerBankAccount.partnerId, partnerId),
        eq(partnerBankAccount.isActive, true),
        eq(partnerBankAccount.approvalStatus, 'approved'),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function loadPartner(tx: Tx, partnerId: string) {
  const [row] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, partnerId))
    .limit(1);

  if (!row) throw new PartnerNotFoundError(partnerId);
  return row;
}
