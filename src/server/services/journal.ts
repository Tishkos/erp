/**
 * Journal Entry service — Phase 02.5 and 02.6.
 *
 * §14.4, the four bullets, in order:
 *   · a Finance user creates and submits to the Finance Manager
 *   · a Finance Manager creates and posts directly
 *   · approval posts automatically and locks
 *   · a posted Journal Entry cannot be edited or deleted
 *
 * The third is why `approve` sets the status to `posted` rather than to
 * `approved`: §24 warns that "approval itself does not automatically mean
 * accounting posting unless configured", and for a Journal Entry it *is* so
 * configured. An approved-but-unposted journal is a state this service cannot
 * produce, which is the 02.6 gate.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  assertFinanceDepartment,
  assertJournalValid,
  assertLineWellFormed,
  type JournalHeaderDraft,
  type JournalLineDraft,
} from '../domain/journal';
import { assertCurrencyAllowed, assertPostable } from '../domain/chart-of-accounts';
import { assertRateNotSupplied } from '../domain/exchange-rates';
import { can } from '../domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import type { SuppliedDimensions } from '../domain/dimensions';
import {
  chartOfAccount,
  department,
  journalEntry,
  journalLine,
  userDepartmentScope,
} from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as coa from './chart-of-accounts';
import { allocateDocumentNumber } from './numbering';
import * as dimensionService from './dimensions';
import * as periodService from './periods';
import * as rateService from './exchange-rates';
import * as statuses from './statuses';
import * as subledgerService from './subledger';
import * as workflow from './workflow';

export const DOCUMENT_TYPE = 'journal_entry';
export const PERMISSION_OBJECT = 'journal_entry';
const SEQUENCE_KEY = 'JOURNAL_ENTRY';

export class JournalNotFoundError extends Error {
  readonly code = 'JOURNAL_NOT_FOUND';
  constructor(id: string) {
    super(`No journal entry with id '${id}'.`);
    this.name = 'JournalNotFoundError';
  }
}

export class JournalBranchMismatchError extends Error {
  readonly code = 'JOURNAL_BRANCH_MISMATCH';
  constructor(
    readonly journalBranch: string,
    readonly lineBranch: string,
  ) {
    // §25 — the field, the reason, the corrective action.
    super(
      `This journal is in branch ${journalBranch}, so its lines cannot be in ${lineBranch}. ` +
        'One Journal Entry contains one branch only (§14.3). ' +
        `Raise a separate journal in ${lineBranch}, or leave the line's branch unset to inherit ${journalBranch}.`,
    );
    this.name = 'JournalBranchMismatchError';
  }
}

export interface CreateJournalInput {
  readonly branchCode: string;
  readonly documentDate: string;
  readonly postingDate: string;
  readonly description?: string | null;
}

export interface AddLineInput {
  readonly accountId: string;
  /** Decimal string. Exactly one of debit or credit. */
  readonly debit?: string | null;
  readonly credit?: string | null;
  /** Transaction currency. Defaults to the ledger currency. */
  readonly currency?: string;
  readonly dimensions?: SuppliedDimensions;
  readonly description?: string | null;
  /** Phase 07 master; carried now because §14.2 lists it on the line. */
  readonly bankAccountCode?: string | null;
}

/**
 * §14 — "Journal Entries belong exclusively to the Finance Department."
 *
 * Read from the user's department assignments, so the answer to "who is in
 * Finance?" lives in one place (§5.1) rather than in a role name this module
 * would have to know.
 */
async function financeDepartmentsOf(tx: Tx, userId: string) {
  return tx
    .select({ code: department.code, isFinance: department.isFinance })
    .from(userDepartmentScope)
    .innerJoin(department, eq(department.code, userDepartmentScope.departmentCode))
    .where(eq(userDepartmentScope.userId, userId));
}

/** Whether this actor may post — §14.4's "Finance Manager". */
function canPost(ctx: ActorContext): boolean {
  return can(ctx.principal, 'post', PERMISSION_OBJECT);
}

/**
 * Opens a draft journal.
 *
 * The number is allocated now, not at posting. §14.2 says it is "generated
 * automatically and never reused"; a draft that is abandoned therefore leaves a
 * gap, which the 01.5 report explains. Allocating at posting instead would mean
 * the accountant cannot refer to the journal they are working on.
 */
export async function createDraft(
  tx: Tx,
  ctx: ActorContext,
  input: CreateJournalInput,
): Promise<{ id: string; entryNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
    requestId: ctx.requestId ?? null,
  });

  assertFinanceDepartment(
    ctx.principal.userId,
    await financeDepartmentsOf(tx, ctx.principal.userId),
  );

  // The period must exist before the entry can reference it. Whether posting
  // into it is *allowed* is asked at submission, when the journal claims to be
  // finished — see `submit`.
  const period = await periodService.periodFor(tx, input.postingDate);

  // The year comes from the posting date, not from today: a back-dated journal
  // belongs to its own year's series (§14.6, 01.5).
  const year = Number(input.postingDate.slice(0, 4));
  const { documentNo: entryNo } = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { year },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(journalEntry)
    .values({
      entryNo,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalPeriodId: period.id,
      branchCode: input.branchCode,
      description: input.description ?? null,
      journalType: 'standard',
      source: 'manual',
      status: 'draft',
      createdBy: ctx.principal.userId,
    })
    .returning({ id: journalEntry.id, entryNo: journalEntry.entryNo });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      entryNo: created!.entryNo,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      period: period.name,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, entryNo: created!.entryNo };
}

/**
 * Adds a line, resolving everything the line does not get to choose.
 *
 * The caller supplies an account, a side, an amount and a currency. The rate
 * comes from the posting date (§14.3 — it "cannot be edited inside Journal
 * Entry"), the IQD and USD figures are derived from it, and the dimensions are
 * validated against the account and the document type (§4.2).
 */
export async function addLine(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  input: AddLineInput,
): Promise<{ lineNo: number }> {
  // §14.3 — the rate is never accepted from the document.
  assertRateNotSupplied(input as unknown as Record<string, unknown>);

  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  if (entry.status !== 'draft') {
    // §24 — "Submission freezes controlled fields."
    throw new Error(
      `Journal ${entry.entryNo} is ${entry.status} and its lines can no longer be changed.`,
    );
  }

  const account = await coa.loadAccount(tx, input.accountId);

  // §3.3 and §14.3, in one call: active, approved, not a group, and — for a
  // control account — only by someone who may post.
  assertPostable(account, { source: 'manual', actorIsFinanceManager: canPost(ctx) });

  const currency = input.currency ?? 'IQD';
  assertCurrencyAllowed(account, currency);

  // §14.3 and Appendix C, Manual Standard Journal: "one branch". A line takes
  // the journal's branch, and a caller who supplies a different one is told so
  // rather than having it silently replaced — the database trigger refuses the
  // same thing, and a service that quietly disagreed with the database would
  // leave the caller believing something untrue about what they just wrote.
  const suppliedBranch = input.dimensions?.branch;
  if (suppliedBranch && suppliedBranch !== entry.branchCode) {
    throw new JournalBranchMismatchError(entry.branchCode, suppliedBranch);
  }

  const dimensions = { ...(input.dimensions ?? {}), branch: entry.branchCode };
  await dimensionService.assertDimensionsValid(tx, account, DOCUMENT_TYPE, dimensions);

  const debit = input.debit ? parseDecimal(input.debit, MONEY_SCALE) : 0n;
  const credit = input.credit ? parseDecimal(input.credit, MONEY_SCALE) : 0n;
  const amountTxn = debit > 0n ? debit : credit;

  const converted = await rateService.convertOn(tx, amountTxn, currency, entry.postingDate);

  const nextLineNo = await nextLineNumber(tx, journalEntryId);

  const draft: JournalLineDraft = {
    lineNo: nextLineNo,
    accountId: account.id,
    accountCode: account.code,
    debitTxn: debit,
    creditTxn: credit,
    currency,
    debitIqd: debit > 0n ? converted.amountIqd : 0n,
    creditIqd: credit > 0n ? converted.amountIqd : 0n,
    debitUsd: debit > 0n ? converted.amountUsd : 0n,
    creditUsd: credit > 0n ? converted.amountUsd : 0n,
    dimensions,
  };

  assertLineWellFormed(draft);

  await tx.insert(journalLine).values({
    journalEntryId,
    lineNo: draft.lineNo,
    accountId: account.id,
    debitTxn: toDecimalString(draft.debitTxn),
    creditTxn: toDecimalString(draft.creditTxn),
    currency,
    debitIqd: toDecimalString(draft.debitIqd),
    creditIqd: toDecimalString(draft.creditIqd),
    debitUsd: toDecimalString(draft.debitUsd),
    creditUsd: toDecimalString(draft.creditUsd),
    txnRateId: converted.txnRateId,
    usdRateId: converted.usdRateId,
    branchCode: entry.branchCode,
    departmentCode: dimensions.department ?? null,
    businessLineCode: dimensions.business_line ?? null,
    projectCode: dimensions.project ?? null,
    warehouseCode: dimensions.warehouse ?? null,
    businessPartnerCode: dimensions.business_partner ?? null,
    employeeCode: dimensions.employee ?? null,
    bankAccountCode: input.bankAccountCode ?? null,
    lineDescription: input.description ?? null,
  });

  return { lineNo: draft.lineNo };
}

async function nextLineNumber(tx: Tx, journalEntryId: string): Promise<number> {
  const rows = await tx
    .select({ lineNo: journalLine.lineNo })
    .from(journalLine)
    .where(eq(journalLine.journalEntryId, journalEntryId));

  return rows.reduce((max, row) => Math.max(max, row.lineNo), 0) + 1;
}

/**
 * Submits the journal — and posts it if the actor may post (§14.4).
 *
 * A Finance user submits to the Finance Manager. A Finance Manager "creates and
 * posts directly", so for them submission and posting are one act rather than
 * two clicks that mean the same thing.
 */
export async function submit(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  options: { overrideReason?: string | null } = {},
): Promise<{ status: 'submitted' | 'posted' }> {
  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  assertFinanceDepartment(
    ctx.principal.userId,
    await financeDepartmentsOf(tx, ctx.principal.userId),
  );

  const lines = await loadLines(tx, journalEntryId);
  assertJournalValid(toHeaderDraft(entry), lines);

  // §14.6 — may this date be posted into? Records the override if it is one.
  await periodService.authorisePosting(tx, ctx, {
    postingDate: entry.postingDate,
    documentType: DOCUMENT_TYPE,
    documentId: entry.entryNo,
    overrideReason: options.overrideReason ?? null,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, entry.status, 'submitted');

  await workflow.submit(tx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: journalEntryId,
    submittedBy: ctx.principal.userId,
    branchCode: entry.branchCode,
  });

  await tx
    .update(journalEntry)
    .set({ status: 'submitted' })
    .where(eq(journalEntry.id, journalEntryId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: { status: entry.status },
    after: { status: 'submitted', totalIqd: entry.totalDebitIqd },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  if (canPost(ctx)) {
    await approve(tx, ctx, journalEntryId);
    return { status: 'posted' };
  }

  return { status: 'submitted' };
}

/**
 * Approves and posts, in one transaction.
 *
 * §14.4 — "approval posts automatically and locks". The two happen together or
 * neither does, so an approved-but-unposted journal is unreachable.
 */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
): Promise<void> {
  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, entry.status, 'posted');

  const outcome = await workflow.decide(tx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: journalEntryId,
    actor: {
      userId: ctx.principal.userId,
      roles: ctx.principal.roleCodes,
      isDepartmentManager: false,
    },
    decision: 'approved',
  });

  if (!outcome.isComplete) return;

  await tx
    .update(journalEntry)
    .set({
      status: 'posted',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      postedAt: new Date(),
    })
    .where(eq(journalEntry.id, journalEntryId));

  // §1.2 — the subledgers are written from the journal, in the same
  // transaction. Reconciliation is then a property of how the entries exist,
  // not a report that runs afterwards and hopes.
  await subledgerService.writeForJournal(tx, journalEntryId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.posted',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: { status: entry.status },
    after: {
      status: 'posted',
      entryNo: entry.entryNo,
      totalDebitIqd: entry.totalDebitIqd,
      totalCreditIqd: entry.totalCreditIqd,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

export async function reject(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  reason: string,
): Promise<void> {
  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, entry.status, 'rejected', reason);

  await workflow.decide(tx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: journalEntryId,
    actor: {
      userId: ctx.principal.userId,
      roles: ctx.principal.roleCodes,
      isDepartmentManager: false,
    },
    decision: 'rejected',
    reason,
  });

  await tx
    .update(journalEntry)
    .set({ status: 'rejected' })
    .where(eq(journalEntry.id, journalEntryId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.rejected',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: { status: entry.status },
    after: { status: 'rejected' },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadHeader(tx: Tx, id: string) {
  const [row] = await tx.select().from(journalEntry).where(eq(journalEntry.id, id)).limit(1);
  if (!row) throw new JournalNotFoundError(id);
  return row;
}

function toHeaderDraft(row: Awaited<ReturnType<typeof loadHeader>>): JournalHeaderDraft {
  return {
    branchCode: row.branchCode,
    documentDate: row.documentDate,
    postingDate: row.postingDate,
    journalType: row.journalType,
    description: row.description,
  };
}

export async function loadLines(tx: Tx, journalEntryId: string): Promise<JournalLineDraft[]> {
  const rows = await tx
    .select({ line: journalLine, accountCode: chartOfAccount.code })
    .from(journalLine)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, journalLine.accountId))
    .where(eq(journalLine.journalEntryId, journalEntryId))
    .orderBy(asc(journalLine.lineNo));

  return rows.map(({ line, accountCode }) => ({
    lineNo: line.lineNo,
    accountId: line.accountId,
    accountCode,
    debitTxn: parseDecimal(line.debitTxn, MONEY_SCALE),
    creditTxn: parseDecimal(line.creditTxn, MONEY_SCALE),
    currency: line.currency,
    debitIqd: parseDecimal(line.debitIqd, MONEY_SCALE),
    creditIqd: parseDecimal(line.creditIqd, MONEY_SCALE),
    debitUsd: parseDecimal(line.debitUsd, MONEY_SCALE),
    creditUsd: parseDecimal(line.creditUsd, MONEY_SCALE),
    dimensions: {
      branch: line.branchCode,
      department: line.departmentCode,
      business_line: line.businessLineCode,
      project: line.projectCode,
      warehouse: line.warehouseCode,
      business_partner: line.businessPartnerCode,
      employee: line.employeeCode,
    },
    description: line.lineDescription,
  }));
}

/** The journal as a screen or a report shows it. */
export async function load(tx: Tx, id: string) {
  const header = await loadHeader(tx, id);
  const lines = await loadLines(tx, id);
  return { header, lines };
}

/** Journals awaiting a decision — the Finance Manager's inbox. */
export async function pending(tx: Tx, branchCode?: string) {
  return tx
    .select({
      id: journalEntry.id,
      entryNo: journalEntry.entryNo,
      postingDate: journalEntry.postingDate,
      totalDebitIqd: journalEntry.totalDebitIqd,
      createdBy: journalEntry.createdBy,
    })
    .from(journalEntry)
    .where(
      branchCode
        ? and(eq(journalEntry.status, 'submitted'), eq(journalEntry.branchCode, branchCode))
        : eq(journalEntry.status, 'submitted'),
    )
    .orderBy(asc(journalEntry.postingDate));
}
