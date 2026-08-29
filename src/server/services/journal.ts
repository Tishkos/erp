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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  JournalValidationError,
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
  appUser,
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
import * as attachmentService from './attachments';

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

export class JournalNotDraftError extends Error {
  readonly code = 'JOURNAL_NOT_DRAFT';
  constructor(
    readonly entryNo: string,
    readonly status: string,
  ) {
    // §7 — once a document leaves draft it is never deleted, only reversed.
    // Say which of the two applies rather than only refusing.
    super(
      `${entryNo} is ${status}, not a draft, so it cannot be deleted. ` +
        'Only a draft can be thrown away. An entry that has been posted is corrected by reversing it, ' +
        'which leaves both facts on the record: that it was posted, and that it was undone.',
    );
    this.name = 'JournalNotDraftError';
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

  // The currency follows the account: since 2026-08-29 the ledger is kept in
  // IQD alone, and an account tied to another currency names it itself.
  const currency = input.currency ?? account.currencyRestriction ?? 'IQD';
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

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.line_added',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    after: {
      lineNo: draft.lineNo,
      account: `${account.code} · ${account.name}`,
      debitIqd: toDecimalString(draft.debitIqd),
      creditIqd: toDecimalString(draft.creditIqd),
      currency,
      department: dimensions.department ?? null,
      description: input.description ?? null,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { lineNo: draft.lineNo };
}

/**
 * Changes a line on a draft — the account, the amount, the side, the note or
 * the department — in place.
 *
 * By direction (2026-08-29) the lines are typed straight into the grid, and a
 * grid a person can move around in is a grid where a cell can be changed after
 * it was left. Removing and re-adding the line would renumber the rest, which
 * is not what happened; the line keeps its number and its figures are
 * re-derived the same way `addLine` derived them, from the posting date.
 */
export async function updateLine(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  lineId: string,
  input: AddLineInput,
): Promise<{ lineNo: number }> {
  assertRateNotSupplied(input as unknown as Record<string, unknown>);

  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  if (entry.status !== 'draft') {
    throw new Error(
      `Journal ${entry.entryNo} is ${entry.status} and its lines can no longer be changed.`,
    );
  }

  const [existing] = await tx
    .select()
    .from(journalLine)
    .where(and(eq(journalLine.id, lineId), eq(journalLine.journalEntryId, journalEntryId)))
    .limit(1);
  if (!existing) {
    throw new Error(`That line is not on journal ${entry.entryNo}.`);
  }

  const account = await coa.loadAccount(tx, input.accountId);
  assertPostable(account, { source: 'manual', actorIsFinanceManager: canPost(ctx) });

  const currency = input.currency ?? account.currencyRestriction ?? 'IQD';
  assertCurrencyAllowed(account, currency);

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

  const draft: JournalLineDraft = {
    lineNo: existing.lineNo,
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

  await tx
    .update(journalLine)
    .set({
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
      departmentCode: dimensions.department ?? null,
      lineDescription: input.description ?? null,
    })
    .where(eq(journalLine.id, lineId));

  const [previousAccount] = await tx
    .select({ code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, existing.accountId))
    .limit(1);
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.line_changed',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: {
      lineNo: existing.lineNo,
      account: previousAccount ? `${previousAccount.code} · ${previousAccount.name}` : null,
      debitIqd: existing.debitIqd,
      creditIqd: existing.creditIqd,
      currency: existing.currency,
      department: existing.departmentCode,
      description: existing.lineDescription,
    },
    after: {
      lineNo: existing.lineNo,
      account: `${account.code} · ${account.name}`,
      debitIqd: toDecimalString(draft.debitIqd),
      creditIqd: toDecimalString(draft.creditIqd),
      currency,
      department: dimensions.department ?? null,
      description: input.description ?? null,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { lineNo: existing.lineNo };
}

/**
 * Changes the header of a draft — the two dates and the description.
 *
 * A journal now opens the moment "New journal" is pressed, dated today, so
 * these are corrected on the document rather than asked for in a dialog
 * first. The posting date decides the period and the rates, so moving it
 * re-derives every line's IQD and USD figures at the new date; and it stays
 * inside the year the entry was numbered in, because the number carries the
 * year (§14.2) and a number that says one year over a date that says another
 * is a document nobody can file.
 */
export async function updateHeader(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  input: {
    readonly documentDate?: string | null;
    readonly postingDate?: string | null;
    readonly description?: string | null;
  },
): Promise<void> {
  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  if (entry.status !== 'draft') {
    throw new Error(`Journal ${entry.entryNo} is ${entry.status} and can no longer be changed.`);
  }

  const postingDate = input.postingDate?.trim() || entry.postingDate;
  const documentDate = input.documentDate?.trim() || postingDate;
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(postingDate) || !isoDate.test(documentDate)) {
    throw new JournalValidationError('Dates are written as YYYY-MM-DD.');
  }
  if (documentDate > postingDate) {
    throw new JournalValidationError(
      'The document date cannot be after the posting date: a paper cannot be written after the entry that records it.',
    );
  }
  if (postingDate.slice(0, 4) !== entry.postingDate.slice(0, 4)) {
    throw new JournalValidationError(
      `${entry.entryNo} is numbered in ${entry.postingDate.slice(0, 4)}, so it posts in that year. For another year, open a new entry.`,
    );
  }

  const period = await periodService.periodFor(tx, postingDate);
  const description =
    input.description === undefined ? entry.description : input.description?.trim() || null;

  await tx
    .update(journalEntry)
    .set({ documentDate, postingDate, fiscalPeriodId: period.id, description })
    .where(eq(journalEntry.id, journalEntryId));

  // The rates follow the posting date, so every line is measured again.
  if (postingDate !== entry.postingDate) {
    const lines = await tx
      .select()
      .from(journalLine)
      .where(eq(journalLine.journalEntryId, journalEntryId));
    for (const line of lines) {
      const debit = parseDecimal(line.debitTxn, MONEY_SCALE);
      const credit = parseDecimal(line.creditTxn, MONEY_SCALE);
      const converted = await rateService.convertOn(
        tx,
        debit > 0n ? debit : credit,
        line.currency,
        postingDate,
      );
      await tx
        .update(journalLine)
        .set({
          debitIqd: toDecimalString(debit > 0n ? converted.amountIqd : 0n),
          creditIqd: toDecimalString(credit > 0n ? converted.amountIqd : 0n),
          debitUsd: toDecimalString(debit > 0n ? converted.amountUsd : 0n),
          creditUsd: toDecimalString(credit > 0n ? converted.amountUsd : 0n),
          txnRateId: converted.txnRateId,
          usdRateId: converted.usdRateId,
        })
        .where(eq(journalLine.id, line.id));
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.updated',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: {
      documentDate: entry.documentDate,
      postingDate: entry.postingDate,
      description: entry.description,
    },
    after: { documentDate, postingDate, description },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Removes a line from a draft.
 *
 * Only ever a draft: once submitted the entry is a document and §7 keeps it —
 * correction is rejection or reversal, never surgery. The database says the
 * same thing through the D31 guard trigger, so a caller that never comes
 * through here is refused all the same; the check here exists to say it in a
 * sentence rather than a constraint name.
 *
 * The remaining lines are renumbered to close the gap — an accountant reads
 * "1, 3" as a line that is missing, not a line that was removed. The shift
 * runs in two steps because the (entry, line_no) unique index is immediate:
 * moved out of range first, then down into place, every intermediate state
 * unique and positive. The header's totals follow by trigger, the same way
 * they follow an insert.
 */
export async function removeLine(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  lineId: string,
): Promise<void> {
  const entry = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  if (entry.status !== 'draft') {
    throw new Error(
      `Journal ${entry.entryNo} is ${entry.status} and its lines can no longer be changed.`,
    );
  }

  const [line] = await tx
    .select()
    .from(journalLine)
    .where(and(eq(journalLine.id, lineId), eq(journalLine.journalEntryId, journalEntryId)))
    .limit(1);
  if (!line) {
    throw new Error(`That line is not on journal ${entry.entryNo}.`);
  }

  await tx.delete(journalLine).where(eq(journalLine.id, lineId));

  await tx.execute(
    sql`update journal_line set line_no = line_no + 1000
         where journal_entry_id = ${journalEntryId} and line_no > ${line.lineNo}`,
  );
  await tx.execute(
    sql`update journal_line set line_no = line_no - 1001
         where journal_entry_id = ${journalEntryId} and line_no > 1000`,
  );

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.line_removed',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: {
      lineNo: line.lineNo,
      account: await tx
        .select({ code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(eq(chartOfAccount.id, line.accountId))
        .limit(1)
        .then(([a]) => (a ? `${a.code} · ${a.name}` : null)),
      debitIqd: line.debitIqd,
      creditIqd: line.creditIqd,
      currency: line.currency,
      description: line.lineDescription,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
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

/**
 * Throwing away a draft.
 *
 * §7 says a saved record is not deleted — and that rule is about *documents*,
 * things that have entered the flow and that somebody may later be asked to
 * account for. A draft has entered nothing: nobody has approved it, no ledger
 * has moved, and the only thing it holds is a person's unfinished typing.
 * Forcing them to keep it forever fills the list with abandoned work and makes
 * the real entries harder to find.
 *
 * Two things keep §7 intact anyway:
 *
 *   - The audit event is written **before** the rows go, so the trail still
 *     says this entry existed, what number it held, and who discarded it.
 *   - The number is not returned to the series. The gap stays, because §14.2
 *     says a number is never reused, and a reader who sees JV-2026-00007
 *     missing can be told what happened to it.
 *
 * Anything past draft is refused here and by the status rules underneath.
 */
export async function discardDraft(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
): Promise<{ entryNo: string }> {
  const entry = await loadHeader(tx, journalEntryId);

  // Whoever may edit the draft may throw it away: discarding is the furthest
  // edit there is, and inventing a separate verb would need a grant on every
  // role before anybody could use it.
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: entry.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  if (entry.status !== 'draft') {
    throw new JournalNotDraftError(entry.entryNo, entry.status);
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.discarded',
    objectType: PERMISSION_OBJECT,
    objectId: journalEntryId,
    branchCode: entry.branchCode,
    before: {
      entryNo: entry.entryNo,
      status: entry.status,
      postingDate: entry.postingDate,
      description: entry.description,
      totalDebitIqd: entry.totalDebitIqd,
    },
    after: null,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  // Attachments hang off the document by type and id rather than by a foreign
  // key, so nothing would remove them with it — and an attachment to a
  // document that no longer exists is unreachable, not preserved.
  await attachmentService.discardFor(tx, PERMISSION_OBJECT, journalEntryId);

  await tx.delete(journalLine).where(eq(journalLine.journalEntryId, journalEntryId));
  await tx.delete(journalEntry).where(eq(journalEntry.id, journalEntryId));

  return { entryNo: entry.entryNo };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Reverses a posted journal — Phase 1 requirement 3.
 *
 * "A posted entry cannot be edited or deleted. If a correction is required,
 * the original entry is reversed through a linked full reversal."
 *
 * Full reversal, and nothing else: every line of the original comes back with
 * its sides swapped and its **own** figures — the same IQD and USD amounts,
 * carrying the same rate references. Re-deriving them at today's rate would
 * leave a residue in the ledger and call it a correction, which is the thing
 * a reversal exists to avoid.
 *
 * The reversal is created and posted in one act. It is not a proposal anybody
 * drafts: it is the mirror of a document that has already been approved, and
 * the authority to reverse is the authority to post it. The database holds
 * both ends of that promise — the link cannot later be edited away, a reversal
 * cannot itself be reversed, and a journal is reversed once.
 */
export async function reverse(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  input: { readonly reason: string; readonly postingDate?: string | null },
): Promise<{ id: string; entryNo: string }> {
  const original = await loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: original.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  const reason = input.reason?.trim();
  if (!reason) {
    throw new JournalValidationError(
      'A reversal records why the original was wrong; give a reason.',
    );
  }

  if (original.status !== 'posted') {
    throw new JournalValidationError(
      `Journal ${original.entryNo} is ${original.status}; only a posted journal is reversed.`,
    );
  }
  if (original.reversesId) {
    throw new JournalValidationError(
      `Journal ${original.entryNo} is itself a reversal and cannot be reversed (§14.3).`,
    );
  }
  if (original.reversedById) {
    throw new JournalValidationError(`Journal ${original.entryNo} has already been reversed.`);
  }

  // §14.3 — the reversal is never dated before what it undoes. Today, unless
  // the original posted later than today, in which case the original's own
  // date is the earliest honest answer.
  const today = new Date().toISOString().slice(0, 10);
  const requested = input.postingDate?.trim() || today;
  const postingDate = requested < original.postingDate ? original.postingDate : requested;

  const period = await periodService.periodFor(tx, postingDate);
  // A reversal still has to land in a period that accepts postings; a closed
  // month is closed to corrections too, and reopening it is somebody's decision.
  await periodService.authorisePosting(tx, ctx, {
    postingDate,
    documentType: DOCUMENT_TYPE,
    documentId: original.entryNo,
  });

  const { documentNo: entryNo } = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { year: Number(postingDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  // Draft first, because a posted journal will not accept lines — the same
  // rule that makes the original immutable applies to this one the moment it
  // is posted, so the lines go on while it is still a draft.
  const [created] = await tx
    .insert(journalEntry)
    .values({
      entryNo,
      // The reversal has no paper of its own, so its document date is the day
      // it takes effect. Anything else can put the document date after the
      // posting date, which the ledger refuses — rightly, since a document
      // cannot be written after the entry that records it.
      documentDate: postingDate,
      postingDate,
      fiscalPeriodId: period.id,
      branchCode: original.branchCode,
      description: `Reversal of ${original.entryNo} — ${reason}`,
      journalType: original.journalType,
      source: 'manual',
      status: 'draft',
      reversesId: original.id,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: journalEntry.id, entryNo: journalEntry.entryNo });

  const lines = await tx
    .select()
    .from(journalLine)
    .where(eq(journalLine.journalEntryId, journalEntryId))
    .orderBy(asc(journalLine.lineNo));

  if (lines.length === 0) {
    throw new JournalValidationError(
      `Journal ${original.entryNo} has no lines, so there is nothing to reverse.`,
    );
  }

  for (const line of lines) {
    await tx.insert(journalLine).values({
      journalEntryId: created!.id,
      lineNo: line.lineNo,
      accountId: line.accountId,
      // The swap, and the whole of it: debit becomes credit, credit becomes
      // debit, in every currency the line was measured in.
      debitTxn: line.creditTxn,
      creditTxn: line.debitTxn,
      currency: line.currency,
      debitIqd: line.creditIqd,
      creditIqd: line.debitIqd,
      debitUsd: line.creditUsd,
      creditUsd: line.debitUsd,
      txnRateId: line.txnRateId,
      usdRateId: line.usdRateId,
      branchCode: line.branchCode,
      departmentCode: line.departmentCode,
      businessLineCode: line.businessLineCode,
      projectCode: line.projectCode,
      warehouseCode: line.warehouseCode,
      businessPartnerCode: line.businessPartnerCode,
      employeeCode: line.employeeCode,
      bankAccountCode: line.bankAccountCode,
      lineDescription: line.lineDescription,
      sourceLineId: line.id,
    });
  }

  const now = new Date();
  await tx
    .update(journalEntry)
    .set({ status: 'posted', approvedBy: ctx.principal.userId, approvedAt: now, postedAt: now })
    .where(eq(journalEntry.id, created!.id));

  // And the original is closed, pointing at what undid it.
  await tx
    .update(journalEntry)
    .set({ status: 'reversed', reversedById: created!.id })
    .where(eq(journalEntry.id, journalEntryId));

  await subledgerService.writeForJournal(tx, created!.id);

  for (const [id, action, after] of [
    [created!.id, 'journal_entry.reversal_posted', { entryNo, reverses: original.entryNo, postingDate }],
    [journalEntryId, 'journal_entry.reversed', { status: 'reversed', reversedBy: entryNo }],
  ] as const) {
    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action,
      objectType: PERMISSION_OBJECT,
      objectId: id,
      branchCode: original.branchCode,
      after,
      reason,
      outcome: 'success',
      requestId: ctx.requestId ?? null,
    });
  }

  return { id: created!.id, entryNo };
}

/** The two halves of a reversal, for the screen that lists them. */
export async function reversals(tx: Tx) {
  const reversal = alias(journalEntry, 'reversal');
  return tx
    .select({
      originalId: journalEntry.id,
      originalNo: journalEntry.entryNo,
      originalPostingDate: journalEntry.postingDate,
      originalAmount: journalEntry.totalDebitIqd,
      reversalId: reversal.id,
      reversalNo: reversal.entryNo,
      reversalPostingDate: reversal.postingDate,
      reason: reversal.description,
      reversedBy: reversal.createdBy,
    })
    .from(journalEntry)
    .innerJoin(reversal, eq(reversal.id, journalEntry.reversedById))
    .orderBy(desc(reversal.postingDate), desc(reversal.entryNo));
}

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

/**
 * The journals a person may see, newest posting date first.
 *
 * No branch predicate: row-level security has already decided which branches
 * this user's transaction can read, and adding a second filter here would let
 * the two disagree — which is how a report ends up quietly showing less than
 * the person is entitled to and nobody notices for a quarter.
 */
/** §14 — is this person in a Finance department, and so able to raise entries? */
export async function isInFinanceDepartment(tx: Tx, userId: string): Promise<boolean> {
  const rows = await financeDepartmentsOf(tx, userId);
  return rows.some((row) => row.isFinance);
}

export async function listAll(tx: Tx) {
  const raiser = alias(appUser, 'raiser');
  return tx
    .select({
      id: journalEntry.id,
      entryNo: journalEntry.entryNo,
      documentDate: journalEntry.documentDate,
      postingDate: journalEntry.postingDate,
      description: journalEntry.description,
      branchCode: journalEntry.branchCode,
      status: journalEntry.status,
      totalDebitIqd: journalEntry.totalDebitIqd,
      reversesId: journalEntry.reversesId,
      reversedById: journalEntry.reversedById,
      createdBy: journalEntry.createdBy,
      raisedBy: raiser.displayName,
    })
    .from(journalEntry)
    .leftJoin(raiser, eq(raiser.id, journalEntry.createdBy))
    .orderBy(desc(journalEntry.postingDate), desc(journalEntry.entryNo));
}

/** One journal by its number — what a person knows, rather than its id. */
export async function byEntryNo(tx: Tx, entryNo: string) {
  const [row] = await tx
    .select()
    .from(journalEntry)
    .where(eq(journalEntry.entryNo, entryNo))
    .limit(1);
  if (!row) throw new JournalNotFoundError(entryNo);
  return row;
}

/**
 * The journal as its record page shows it: the header, its lines with the
 * accounts named, who raised it, and — if it has been reversed or is itself a
 * reversal — the entry at the other end of that link.
 */
export async function detail(tx: Tx, entryNo: string) {
  const header = await byEntryNo(tx, entryNo);
  const lines = await tx
    .select({
      id: journalLine.id,
      lineNo: journalLine.lineNo,
      accountId: journalLine.accountId,
      accountCode: chartOfAccount.code,
      accountName: chartOfAccount.name,
      debitIqd: journalLine.debitIqd,
      creditIqd: journalLine.creditIqd,
      // §24's four-part tuple, read back whole. The USD pair was stored and
      // never shown, which is why an entry could not be checked in the
      // reporting currency without leaving the entry.
      debitUsd: journalLine.debitUsd,
      creditUsd: journalLine.creditUsd,
      currency: journalLine.currency,
      debitTxn: journalLine.debitTxn,
      creditTxn: journalLine.creditTxn,
      description: journalLine.lineDescription,
      departmentCode: journalLine.departmentCode,
    })
    .from(journalLine)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, journalLine.accountId))
    .where(eq(journalLine.journalEntryId, header.id))
    .orderBy(asc(journalLine.lineNo));

  const people = await tx
    .select({ id: appUser.id, displayName: appUser.displayName })
    .from(appUser)
    .where(
      inArray(
        appUser.id,
        [header.createdBy, header.approvedBy].filter((id): id is string => Boolean(id)),
      ),
    );
  const name = (id: string | null) =>
    id ? (people.find((person) => person.id === id)?.displayName ?? null) : null;

  const linkedId = header.reversedById ?? header.reversesId;
  const [linked] = linkedId
    ? await tx
        .select({ id: journalEntry.id, entryNo: journalEntry.entryNo, status: journalEntry.status })
        .from(journalEntry)
        .where(eq(journalEntry.id, linkedId))
        .limit(1)
    : [];

  return {
    header,
    lines,
    raisedBy: name(header.createdBy),
    approvedBy: name(header.approvedBy),
    linked: linked
      ? { ...linked, relation: header.reversedById ? ('reversed_by' as const) : ('reverses' as const) }
      : null,
  };
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
