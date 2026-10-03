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
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
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
  appUser,
  bank,
  businessPartner,
  currency as currencyTable,
  partnerBankAccount,
  partnerRoleRequiredField,
  workflowInstance,
} from '../db/schema';
import { accountNumberProblem, compactCode, ibanProblem, swiftProblem } from '../domain/bank-details';
import { SelfApprovalError } from '../domain/workflow';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as notifications from './notifications';
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
// Bank details — §4.4, §15; IMPROVEMENT-002 (several accounts, in full)
// ---------------------------------------------------------------------------

export interface BankAccountInput {
  /** The bank's name as on its letter; taken from the bank list when `bankCode` names one and this is empty. */
  readonly bankName?: string | null;
  /** Required unless an IBAN is given (the IBAN then stands for it). */
  readonly accountNumber?: string | null;
  readonly iban?: string | null;
  readonly swift?: string | null;
  readonly currency?: string;
  /** The beneficiary, as the bank holds the account. */
  readonly accountHolder?: string | null;
  readonly bankCode?: string | null;
  readonly bankBranch?: string | null;
  readonly bankAddress?: string | null;
  readonly intermediaryBank?: string | null;
  readonly intermediarySwift?: string | null;
  readonly note?: string | null;
  readonly confirmedNotDuplicate?: boolean;
}

/** Bank details that a bank would refuse — said before anybody verifies them. */
export class BankDetailsError extends Error {
  readonly code = 'BANK_DETAILS_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'BankDetailsError';
  }
}

const blankToNull = (value: string | null | undefined) => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

async function bankAccountRow(tx: Tx, bankAccountId: string) {
  const [row] = await tx.select().from(partnerBankAccount).where(eq(partnerBankAccount.id, bankAccountId)).limit(1);
  if (!row) throw new PartnerNotFoundError(bankAccountId);
  return row;
}

/**
 * Adds a set of bank details, in draft.
 *
 * It is not payable until somebody other than the person who entered it
 * verifies it. §15: "Supplier bank detail changes require independent
 * verification and approval before payment." A partner may hold several
 * payable accounts (IMPROVEMENT-002) — dinars and dollars, two banks — so a
 * new one is added beside the others, not in place of them.
 *
 * What a bank would refuse is refused here first: an IBAN that fails its
 * check digits or its country's length, a SWIFT/BIC of the wrong shape, a
 * currency that is not on the currency list, an account already on this
 * partner. The same number on another partner is the §4.4 duplicate warning.
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

  const bankCode = blankToNull(input.bankCode);
  const [listed] = bankCode ? await tx.select().from(bank).where(eq(bank.code, bankCode)).limit(1) : [];
  if (bankCode && !listed) throw new BankDetailsError(`${bankCode} is not on the bank list.`);
  const bankName = blankToNull(input.bankName) ?? listed?.name ?? null;
  if (!bankName) throw new BankDetailsError('Name the bank, or choose it from the bank list.');

  const iban = compactCode(input.iban) || null;
  const swift = compactCode(input.swift) || compactCode(listed?.swiftBic) || null;
  const intermediarySwift = compactCode(input.intermediarySwift) || null;
  for (const problem of [
    ibanProblem(iban),
    swiftProblem(swift),
    intermediarySwift ? swiftProblem(intermediarySwift)?.replace(/^/, 'Intermediary bank: ') ?? null : null,
    accountNumberProblem(input.accountNumber),
  ]) {
    if (problem) throw new BankDetailsError(problem);
  }
  const accountNumber = blankToNull(input.accountNumber) ?? iban;
  if (!accountNumber) throw new BankDetailsError('Give the account number or the IBAN.');
  // The beneficiary is the partner itself unless the letter says otherwise.
  const [owner] = await tx
    .select({ legalName: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, partnerId))
    .limit(1);
  if (!owner) throw new PartnerNotFoundError(partnerId);
  const accountHolder = blankToNull(input.accountHolder) ?? owner.legalName;

  const currencyCode = (input.currency ?? 'IQD').trim().toUpperCase();
  const [money] = await tx.select().from(currencyTable).where(eq(currencyTable.code, currencyCode)).limit(1);
  if (!money || !money.isActive) throw new BankDetailsError(`${currencyCode} is not an active currency.`);

  // §4.4 — duplicate search before saving bank accounts: by the number and by
  // the IBAN, which is the same account written the long way.
  const keys = [accountNumber, ...(iban ? [iban] : [])];
  const existing = await tx
    .select({
      id: partnerBankAccount.id,
      partnerId: partnerBankAccount.partnerId,
      partnerCode: businessPartner.code,
      legalName: businessPartner.legalName,
      deactivatedAt: partnerBankAccount.deactivatedAt,
    })
    .from(partnerBankAccount)
    .innerJoin(businessPartner, eq(businessPartner.id, partnerBankAccount.partnerId))
    .where(
      or(
        inArray(partnerBankAccount.accountNumber, keys),
        inArray(sql`upper(replace(coalesce(${partnerBankAccount.iban}, ''), ' ', ''))`, keys),
      ),
    );

  if (existing.some((row) => row.partnerId === partnerId && !row.deactivatedAt)) {
    throw new BankDetailsError(`${accountNumber} is already one of this partner's bank accounts.`);
  }
  const elsewhere = existing.filter((row) => row.partnerId !== partnerId);
  if (elsewhere.length > 0 && !input.confirmedNotDuplicate) {
    throw new DuplicatePartnerError(
      elsewhere.map((row) => ({
        partnerId: row.partnerId,
        partnerCode: row.partnerCode,
        legalName: row.legalName,
        matchedOn: ['bank account number'],
      })),
    );
  }

  const [created] = await tx
    .insert(partnerBankAccount)
    .values({
      partnerId,
      bankName,
      bankCode: listed?.code ?? null,
      bankBranch: blankToNull(input.bankBranch),
      bankAddress: blankToNull(input.bankAddress),
      accountNumber,
      iban,
      swift,
      intermediaryBank: blankToNull(input.intermediaryBank),
      intermediarySwift,
      currency: currencyCode,
      accountHolder,
      note: blankToNull(input.note),
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
    after: { partnerId, bankName, accountNumber, iban, swift, currency: currencyCode, accountHolder },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return created!;
}

/** Sends a set of details to be verified; the accounting managers are told. */
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

  const row = await bankAccountRow(tx, bankAccountId);
  if (row.deactivatedAt) throw new BankDetailsError('This bank account was taken out of use; add it again as a new set.');

  await statuses.assertTransitionAllowed(tx, BANK_DOCUMENT_TYPE, row.approvalStatus, 'submitted');

  await workflow.submit(tx, ctx, {
    documentTypeCode: BANK_DOCUMENT_TYPE,
    documentId: bankAccountId,
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

  // The rule `bank_details_awaiting_approval` (0016) has waited for this
  // event since Phase 01; nothing raised it, so a submitted account sat
  // unseen until somebody happened to open the supplier.
  const [partner] = await tx
    .select({ code: businessPartner.code, legalName: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, row.partnerId))
    .limit(1);
  const [submitted] = await tx
    .select({ revision: sql<number>`max(${workflowInstance.revision})` })
    .from(workflowInstance)
    .where(and(eq(workflowInstance.documentTypeCode, BANK_DOCUMENT_TYPE), eq(workflowInstance.documentId, bankAccountId)));
  await notifications.raise(
    tx,
    {
      eventType: 'partner_bank_account.submitted',
      objectType: BANK_DOCUMENT_TYPE,
      objectId: bankAccountId,
      occurrence: String(submitted?.revision ?? 1),
    },
    {
      reference: partner ? `${partner.code} · ${row.bankName} ${row.accountNumber}` : `${row.bankName} ${row.accountNumber}`,
      supplier: partner?.legalName ?? null,
      swift: row.swift,
      currency: row.currency,
    },
    { branchCode: ctx.branchCode, actorUserId: ctx.principal.userId },
  );
}

/**
 * Verifies a set of bank details: it becomes payable beside the partner's
 * other accounts, and the default if the partner has none.
 *
 * §15 requires the verification to be independent: the seeded route refuses
 * whoever submitted it, and the person who entered the details is refused
 * here too, so the two halves of the control are two people.
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

  const row = await bankAccountRow(tx, bankAccountId);
  if (row.deactivatedAt) throw new BankDetailsError('This bank account was taken out of use; it cannot be verified.');
  // the super user approves alone, by direction 2026-10-03.
  if (row.createdBy && row.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new SelfApprovalError(ctx.principal.userId);
  }

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

  const [defaultRow] = await tx
    .select({ id: partnerBankAccount.id })
    .from(partnerBankAccount)
    .where(and(eq(partnerBankAccount.partnerId, row.partnerId), eq(partnerBankAccount.isDefault, true)))
    .limit(1);

  await tx
    .update(partnerBankAccount)
    .set({
      approvalStatus: 'approved',
      isActive: true,
      isDefault: !defaultRow,
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
    after: { approvalStatus: 'approved', isActive: true, isDefault: !defaultRow, accountNumber: row.accountNumber },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Sends a submitted set back to draft, with what to correct. */
export async function returnBankAccount(
  tx: Tx,
  ctx: ActorContext,
  bankAccountId: string,
  reason: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: bankAccountId,
    requestId: ctx.requestId ?? null,
  });
  if (!reason.trim()) throw new BankDetailsError('Say what is wrong with the details, so they can be corrected.');
  const row = await bankAccountRow(tx, bankAccountId);
  await statuses.assertTransitionAllowed(tx, BANK_DOCUMENT_TYPE, row.approvalStatus, 'draft');

  await workflow.decide(tx, {
    documentTypeCode: BANK_DOCUMENT_TYPE,
    documentId: bankAccountId,
    actor: { userId: ctx.principal.userId, roles: ctx.principal.roleCodes, isDepartmentManager: false },
    decision: 'rejected',
    reason: reason.trim(),
  });
  await tx.update(partnerBankAccount).set({ approvalStatus: 'draft' }).where(eq(partnerBankAccount.id, bankAccountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'partner_bank_account.returned',
    objectType: BANK_DOCUMENT_TYPE,
    objectId: bankAccountId,
    branchCode: ctx.branchCode,
    before: { approvalStatus: row.approvalStatus },
    after: { approvalStatus: 'draft' },
    reason: reason.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Makes a verified account the one a payment run pays to. */
export async function setDefaultBankAccount(tx: Tx, ctx: ActorContext, bankAccountId: string): Promise<void> {
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: bankAccountId,
    requestId: ctx.requestId ?? null,
  });
  const [row] = await tx
    .select()
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.id, bankAccountId))
    .limit(1)
    .for('update');
  if (!row) throw new PartnerNotFoundError(bankAccountId);
  if (row.approvalStatus !== 'approved' || !row.isActive) {
    throw new BankDetailsError('Only a verified account in use can be the default.');
  }
  if (row.isDefault) return;
  const [previous] = await tx
    .update(partnerBankAccount)
    .set({ isDefault: false })
    .where(and(eq(partnerBankAccount.partnerId, row.partnerId), eq(partnerBankAccount.isDefault, true)))
    .returning({ id: partnerBankAccount.id, accountNumber: partnerBankAccount.accountNumber });
  await tx.update(partnerBankAccount).set({ isDefault: true }).where(eq(partnerBankAccount.id, bankAccountId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'partner_bank_account.default_set',
    objectType: BANK_DOCUMENT_TYPE,
    objectId: bankAccountId,
    branchCode: ctx.branchCode,
    before: { defaultAccount: previous?.accountNumber ?? null },
    after: { defaultAccount: row.accountNumber },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Takes an account out of use, with the reason — never deleted. A default
 * taken out hands the default to the most recently verified account left.
 */
export async function deactivateBankAccount(
  tx: Tx,
  ctx: ActorContext,
  bankAccountId: string,
  reason: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: bankAccountId,
    requestId: ctx.requestId ?? null,
  });
  if (!reason.trim()) throw new BankDetailsError('Say why the account is taken out of use.');
  const [row] = await tx
    .select()
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.id, bankAccountId))
    .limit(1)
    .for('update');
  if (!row) throw new PartnerNotFoundError(bankAccountId);
  if (row.deactivatedAt) throw new BankDetailsError('This bank account is already out of use.');

  await tx
    .update(partnerBankAccount)
    .set({
      isActive: false,
      isDefault: false,
      deactivatedAt: new Date(),
      deactivatedBy: ctx.principal.userId,
      deactivationReason: reason.trim(),
    })
    .where(eq(partnerBankAccount.id, bankAccountId));

  let promoted: string | null = null;
  if (row.isDefault) {
    const [next] = await tx
      .select({ id: partnerBankAccount.id, accountNumber: partnerBankAccount.accountNumber })
      .from(partnerBankAccount)
      .where(
        and(
          eq(partnerBankAccount.partnerId, row.partnerId),
          eq(partnerBankAccount.isActive, true),
          eq(partnerBankAccount.approvalStatus, 'approved'),
        ),
      )
      .orderBy(desc(partnerBankAccount.approvedAt))
      .limit(1);
    if (next) {
      await tx.update(partnerBankAccount).set({ isDefault: true }).where(eq(partnerBankAccount.id, next.id));
      promoted = next.accountNumber;
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'partner_bank_account.deactivated',
    objectType: BANK_DOCUMENT_TYPE,
    objectId: bankAccountId,
    branchCode: ctx.branchCode,
    before: { isActive: row.isActive, isDefault: row.isDefault, approvalStatus: row.approvalStatus },
    after: { isActive: false, isDefault: false, defaultNow: promoted },
    reason: reason.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * The details a payment may be made to when nobody names one: the default,
 * else the most recently verified account in use.
 */
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
    .orderBy(desc(partnerBankAccount.isDefault), desc(partnerBankAccount.approvedAt))
    .limit(1);

  return row ?? null;
}

/**
 * A partner's accounts for its profile: in use first (the default leading),
 * then those waiting, then those taken out of use — with who entered,
 * verified and retired each.
 */
export async function bankAccountsOf(tx: Tx, partnerId: string) {
  const rows = await tx
    .select()
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.partnerId, partnerId))
    .orderBy(
      desc(partnerBankAccount.isDefault),
      desc(partnerBankAccount.isActive),
      sql`${partnerBankAccount.deactivatedAt} is not null`,
      desc(partnerBankAccount.createdAt),
    );
  const ids = [...new Set(rows.flatMap((row) => [row.createdBy, row.approvedBy, row.deactivatedBy]).filter((id): id is string => Boolean(id)))];
  const people = ids.length
    ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, ids))
    : [];
  const nameOf = (id: string | null) => (id ? (people.find((person) => person.id === id)?.name ?? null) : null);
  return rows.map((row) => ({
    ...row,
    state: row.deactivatedAt
      ? ('inactive' as const)
      : row.approvalStatus === 'approved' && row.isActive
        ? ('verified' as const)
        : row.approvalStatus === 'submitted'
          ? ('submitted' as const)
          : ('draft' as const),
    createdByName: nameOf(row.createdBy),
    approvedByName: nameOf(row.approvedBy),
    deactivatedByName: nameOf(row.deactivatedBy),
  }));
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
