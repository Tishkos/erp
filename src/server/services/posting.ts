/**
 * The posting engine — Phase 02.7.
 *
 * §24: "Module developers shall call shared services for numbering, currency,
 * workflow, posting, attachments and audit logging. Duplicating these
 * mechanisms inside each module will create inconsistent controls and expensive
 * maintenance."
 *
 * So this is the only code in the system that writes a journal from an
 * operational document. Every module from Phase 04 onward calls `post()` and
 * none of them knows an account number.
 *
 * ── The four guarantees ─────────────────────────────────────────────────────
 *
 *   atomic        one transaction. §24: "either all journal/subledger/inventory
 *                 records commit, or none do." The caller's transaction is
 *                 used, never a new one, so a module's own writes commit with
 *                 the posting or not at all.
 *
 *   idempotent    the source reference is unique. Posting the same event twice
 *                 returns the first journal rather than making a second — §23:
 *                 "Repeated delivery of the same idempotent request creates
 *                 only one ERP transaction."
 *
 *   traceable     every line keeps its source document, source line, the rule
 *                 that chose its account, and the actor.
 *
 *   after-commit  events fire once the transaction has committed, so a
 *                 subscriber that throws cannot roll back a financial posting
 *                 (§24). `postAndCommit` owns that ordering.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  assertRequestWellFormed,
  resolveLineAccount,
  resolveRule,
  type PlannedLine,
  type PostingPlan,
  type PostingRequest,
  type PostingRule,
} from '../domain/posting';
import { logger } from '../logging';
import { assertCurrencyAllowed, assertPostable } from '../domain/chart-of-accounts';
import { assertMappedAccount } from '../domain/posting-map';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import type { DimensionType, SuppliedDimensions } from '../domain/dimensions';
import {
  bankCashAccount,
  chartOfAccount,
  journalEntry,
  journalLine,
  postingFailure,
  postingLog,
  postingRule as postingRuleTable,
} from '../db/schema';
import { applyScope, db, withScope, type RequestScope, type Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as coa from './chart-of-accounts';
import * as dimensionService from './dimensions';
import * as periodService from './periods';
import * as rateService from './exchange-rates';
import * as subledgerService from './subledger';
import { allocateDocumentNumber } from './numbering';

/**
 * Which bank or cash account a G/L account belongs to, if any.
 *
 * Only asked for an account flagged as a `bank` control account — every other
 * account has no bank subledger and wants no party. One row at most, by
 * `bank_cash_account_gl_uniq`.
 */
async function bankAccountCodeFor(
  tx: Tx,
  account: { readonly id: string; readonly controlAccount: string | null },
): Promise<string | null> {
  if (account.controlAccount !== 'bank') return null;
  const [row] = await tx
    .select({ code: bankCashAccount.code })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.glAccountId, account.id))
    .limit(1);
  return row?.code ?? null;
}

export const PERMISSION_OBJECT = 'posting_rule';
const SEQUENCE_KEY = 'JOURNAL_ENTRY';

export interface PostingResult {
  readonly journalEntryId: string;
  readonly entryNo: string;
  /** True when this event had already posted and the existing journal was returned. */
  readonly wasDuplicate: boolean;
  readonly plan: PostingPlan;
}

// ---------------------------------------------------------------------------
// Account determination
// ---------------------------------------------------------------------------

/** Every rule for an event, loaded once per posting rather than once per line. */
async function rulesForEvent(tx: Tx, eventType: string): Promise<PostingRule[]> {
  const rows = await tx
    .select({
      id: postingRuleTable.id,
      eventType: postingRuleTable.eventType,
      lineRole: postingRuleTable.lineRole,
      itemGroup: postingRuleTable.itemGroup,
      partnerGroup: postingRuleTable.partnerGroup,
      warehouseCode: postingRuleTable.warehouseCode,
      projectCode: postingRuleTable.projectCode,
      branchCode: postingRuleTable.branchCode,
      accountId: postingRuleTable.accountId,
      accountCode: chartOfAccount.code,
      isActive: postingRuleTable.isActive,
    })
    .from(postingRuleTable)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, postingRuleTable.accountId))
    .where(eq(postingRuleTable.eventType, eventType));

  return rows;
}

// ---------------------------------------------------------------------------
// Planning — the preview and the posting are the same code path
// ---------------------------------------------------------------------------

/**
 * Builds the journal that would be written, and validates everything about it,
 * without writing anything.
 *
 * 02.7's gate: "Posting preview shows the exact journal that will be produced,
 * and the produced journal matches it." That holds because `post` calls this
 * and then writes the result — a preview assembled separately would be a
 * description of what someone believed would happen.
 */
export async function plan(
  tx: Tx,
  ctx: ActorContext,
  request: PostingRequest,
): Promise<PostingPlan> {
  assertRequestWellFormed(request);

  const rules = await rulesForEvent(tx, request.eventType);
  const currency = request.currency ?? 'IQD';

  const lines: PlannedLine[] = [];
  let totalDebitIqd = 0n;
  let totalCreditIqd = 0n;

  for (const [index, line] of request.lines.entries()) {
    // A line that names its own account consults no rule: the account is a
    // property of the document (a bank transfer's two sides, a receipt's bank),
    // and `resolveRule` would either fail for want of a mapping or succeed and
    // send the money somewhere else. Everything after this point is identical —
    // the account is still checked postable, still checked for currency, and
    // its §4.2 dimensions are still enforced.
    const criteria = { branchCode: request.branchCode, ...(line.criteria ?? {}) };
    const selection = resolveLineAccount(rules, request.eventType, line, criteria);
    const account = await coa.loadAccount(tx, selection.accountId);

    // The engine posts on behalf of an approved source document, so a control
    // account is legitimate here — §14.3 restricts *manual* posting to them.
    assertPostable(account, { source: 'system' });
    assertCurrencyAllowed(account, currency);
    assertMappedAccount(request.eventType, line.role, account);

    const dimensions: SuppliedDimensions = {
      branch: request.branchCode,
      ...(line.dimensions as SuppliedDimensions | undefined),
    };
    await dimensionService.assertDimensionsValid(
      tx,
      account,
      request.documentTypeCode ?? request.eventType,
      dimensions,
    );

    const debit = line.debit ? parseDecimal(line.debit, MONEY_SCALE) : 0n;
    const credit = line.credit ? parseDecimal(line.credit, MONEY_SCALE) : 0n;
    const converted = await rateService.convertOn(
      tx,
      debit > 0n ? debit : credit,
      currency,
      request.postingDate,
    );

    if (debit > 0n) totalDebitIqd += converted.amountIqd;
    else totalCreditIqd += converted.amountIqd;

    lines.push({
      lineNo: index + 1,
      role: line.role,
      accountId: account.id,
      accountCode: account.code,
      postingRuleId: selection.postingRuleId,
      accountSource: selection.source,
      debit: toDecimalString(debit),
      credit: toDecimalString(credit),
      currency,
      debitIqd: toDecimalString(debit > 0n ? converted.amountIqd : 0n),
      creditIqd: toDecimalString(credit > 0n ? converted.amountIqd : 0n),
      debitUsd: toDecimalString(debit > 0n ? converted.amountUsd : 0n),
      creditUsd: toDecimalString(credit > 0n ? converted.amountUsd : 0n),
      dimensions,
      sourceLineId: line.sourceLineId ?? null,
      description: line.description ?? null,
      /*
       * The bank subledger's party.
       *
       * Taken from the line when the document named it, and otherwise derived
       * from the account itself: `bank_cash_account_gl_uniq` guarantees that at
       * most one bank or cash account carries a given G/L account, so the
       * mapping back is unambiguous — a constraint doing the work an argument
       * would otherwise have to.
       *
       * Deriving it rather than requiring it is deliberate. Eleven services
       * post to a bank role, and a rule that every one of them must remember
       * an extra field is a rule the twelfth will break; the symptom would be
       * a refusal to post, discovered by whoever was trying to bank a receipt.
       * Until 2026-09-29 none of them supplied it and the refusal was real —
       * it simply had not been met yet, because no live G/L account carried
       * the `bank` control flag.
       */
      bankAccountCode: line.bankAccountCode ?? (await bankAccountCodeFor(tx, account)),
      loanNo: line.loanNo ?? null,
    });
  }

  if (totalDebitIqd !== totalCreditIqd) {
    // Caught here as well as by the database, so the module gets a sentence
    // naming its own event rather than a constraint violation (§25).
    const { JournalUnbalancedError } = await import('../domain/journal');
    throw new JournalUnbalancedError(totalDebitIqd, totalCreditIqd);
  }

  return {
    eventType: request.eventType,
    source: request.source,
    branchCode: request.branchCode,
    documentDate: request.documentDate,
    postingDate: request.postingDate,
    description: request.description ?? null,
    lines,
    totalDebitIqd: toDecimalString(totalDebitIqd),
    totalCreditIqd: toDecimalString(totalCreditIqd),
  };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** Has this exact source event already produced a journal? */
async function existingJournalFor(tx: Tx, request: PostingRequest) {
  const [row] = await tx
    .select({ id: journalEntry.id, entryNo: journalEntry.entryNo })
    .from(journalEntry)
    .where(
      and(
        eq(journalEntry.sourceModule, request.source.module),
        eq(journalEntry.sourceDocId, request.source.documentId),
        eq(journalEntry.sourceEvent, request.source.event),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Posts an operational event.
 *
 * Runs inside the caller's transaction — deliberately. §24 requires the
 * journal, the subledger entries and the module's own records to commit
 * together, and that is only possible if they share a transaction. A posting
 * engine that opened its own would make partial financial state reachable.
 */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  request: PostingRequest,
): Promise<PostingResult> {
  const startedAt = Date.now();

  // §23 — a repeated delivery returns the original result rather than posting
  // again. Checked before any work, and guaranteed by a unique index after it.
  const already = await existingJournalFor(tx, request);
  if (already) {
    const preview = await plan(tx, ctx, request);
    await tx.insert(postingLog).values({
      eventType: request.eventType,
      sourceModule: request.source.module,
      sourceDocId: request.source.documentId,
      sourceEvent: request.source.event,
      journalEntryId: already.id,
      wasDuplicate: true,
      postedBy: ctx.principal.userId,
      branchCode: request.branchCode,
      durationMs: Date.now() - startedAt,
    });

    return {
      journalEntryId: already.id,
      entryNo: already.entryNo,
      wasDuplicate: true,
      plan: preview,
    };
  }

  const posting = await plan(tx, ctx, request);

  // §14.6 — the period must accept this date. A system posting has no override:
  // an operational document cannot decide to breach a closed period.
  await periodService.authorisePosting(tx, ctx, {
    postingDate: request.postingDate,
    documentType: request.eventType,
    documentId: `${request.source.module}:${request.source.documentId}`,
    allowOverride: false,
  });

  const period = await periodService.periodFor(tx, request.postingDate);
  const year = Number(request.postingDate.slice(0, 4));
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
      documentDate: request.documentDate,
      postingDate: request.postingDate,
      fiscalPeriodId: period.id,
      branchCode: request.branchCode,
      description: request.description ?? null,
      journalType: 'standard',
      source: 'system',
      status: 'draft',
      sourceModule: request.source.module,
      sourceDocId: request.source.documentId,
      sourceEvent: request.source.event,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: journalEntry.id, entryNo: journalEntry.entryNo });

  for (const line of posting.lines) {
    await tx.insert(journalLine).values({
      journalEntryId: created!.id,
      lineNo: line.lineNo,
      accountId: line.accountId,
      debitTxn: line.debit,
      creditTxn: line.credit,
      currency: line.currency,
      debitIqd: line.debitIqd,
      creditIqd: line.creditIqd,
      debitUsd: line.debitUsd,
      creditUsd: line.creditUsd,
      branchCode: request.branchCode,
      departmentCode: (line.dimensions as SuppliedDimensions).department ?? null,
      businessLineCode: (line.dimensions as SuppliedDimensions).business_line ?? null,
      projectCode: (line.dimensions as SuppliedDimensions).project ?? null,
      warehouseCode: (line.dimensions as SuppliedDimensions).warehouse ?? null,
      businessPartnerCode: (line.dimensions as SuppliedDimensions).business_partner ?? null,
      employeeCode: (line.dimensions as SuppliedDimensions).employee ?? null,
      lineDescription: line.description,
      sourceLineId: line.sourceLineId,
      postingRuleId: line.postingRuleId,
      lineRole: line.role,
      bankAccountCode: line.bankAccountCode,
      loanNo: line.loanNo,
    });
  }

  // §3.3 — an approved operational document posts automatically. There is no
  // approval step here: the approval happened on the source document.
  await tx
    .update(journalEntry)
    .set({
      status: 'posted',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      postedAt: new Date(),
    })
    .where(eq(journalEntry.id, created!.id));

  // §24 — journal and subledger commit together or not at all. The same call
  // the manual path makes, so both produce subledgers identically.
  await subledgerService.writeForJournal(tx, created!.id);

  await tx.insert(postingLog).values({
    eventType: request.eventType,
    sourceModule: request.source.module,
    sourceDocId: request.source.documentId,
    sourceEvent: request.source.event,
    journalEntryId: created!.id,
    wasDuplicate: false,
    postedBy: ctx.principal.userId,
    branchCode: request.branchCode,
    durationMs: Date.now() - startedAt,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'posting.posted',
    objectType: 'journal_entry',
    objectId: created!.id,
    branchCode: request.branchCode,
    after: {
      entryNo: created!.entryNo,
      eventType: request.eventType,
      source: request.source,
      totalIqd: posting.totalDebitIqd,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return {
    journalEntryId: created!.id,
    entryNo: created!.entryNo,
    wasDuplicate: false,
    plan: posting,
  };
}

// ---------------------------------------------------------------------------
// Post-commit events (§24)
// ---------------------------------------------------------------------------

export interface PostedEvent {
  readonly eventType: string;
  readonly journalEntryId: string;
  readonly entryNo: string;
  readonly source: PostingRequest['source'];
  readonly branchCode: string;
}

type Subscriber = (event: PostedEvent) => void | Promise<void>;

const subscribers: Subscriber[] = [];

/**
 * Registers a post-commit subscriber.
 *
 * In-process for now. Durable delivery is pg-boss, enqueued inside the posting
 * transaction so an event cannot be lost — that is Phase 01.10, and the
 * ordering guarantee below is what it will preserve.
 */
export function onPosted(subscriber: Subscriber): () => void {
  subscribers.push(subscriber);
  return () => {
    const index = subscribers.indexOf(subscriber);
    if (index >= 0) subscribers.splice(index, 1);
  };
}

export function clearSubscribers(): void {
  subscribers.length = 0;
}

/**
 * §24 — "The posting engine emits events after commit so downstream
 * notifications cannot cause partial financial posting."
 *
 * A subscriber that throws is recorded and ignored. The posting is already
 * committed and is not in question; a failing notification is a notification
 * problem.
 */
async function emitPosted(event: PostedEvent): Promise<void> {
  for (const subscriber of [...subscribers]) {
    try {
      await subscriber(event);
    } catch (error) {
      logger.error('posting subscriber failed; the posting stands', {
        error,
        entryNo: event.entryNo,
        eventType: event.eventType,
      });
    }
  }
}

/**
 * Posts in its own transaction, then emits — the ordering §24 requires.
 *
 * Modules with their own writes should call `post` inside their transaction
 * instead, and emit afterwards, so that their records and the journal commit
 * together.
 */
export async function postAndCommit(
  scope: RequestScope,
  ctx: ActorContext,
  request: PostingRequest,
): Promise<PostingResult> {
  let result: PostingResult;

  try {
    result = await withScope(scope, (tx) => post(tx, ctx, request));
  } catch (error) {
    // The transaction has rolled back, so the failure must be recorded on a
    // connection of its own — otherwise the only record of it disappears with
    // the thing that failed. Same reasoning as the refused-request audit.
    await recordFailure(scope, ctx, request, error);
    throw error;
  }

  await emitPosted({
    eventType: request.eventType,
    journalEntryId: result.journalEntryId,
    entryNo: result.entryNo,
    source: request.source,
    branchCode: request.branchCode,
  });

  return result;
}

// ---------------------------------------------------------------------------
// The failed-posting queue (§24)
// ---------------------------------------------------------------------------

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return 'UNKNOWN';
}

export async function recordFailure(
  scope: RequestScope,
  ctx: ActorContext,
  request: PostingRequest,
  error: unknown,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Its own transaction, so the record of the failure survives the rollback
    // of the posting that failed — and its own scope, because that transaction
    // starts unscoped and the row-level policy on posting_failure would
    // otherwise refuse a branch it cannot see (§22).
    await applyScope(tx, scope);

    await tx.insert(postingFailure).values({
      eventType: request.eventType,
      sourceModule: request.source.module,
      sourceDocId: request.source.documentId,
      sourceEvent: request.source.event,
      request: request as unknown as Record<string, unknown>,
      errorCode: errorCodeOf(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      attemptedBy: ctx.principal.userId,
      branchCode: request.branchCode,
    });
  });
}

/** Failures still awaiting attention. */
export async function openFailures(tx: Tx) {
  return tx
    .select()
    .from(postingFailure)
    .where(isNull(postingFailure.resolvedAt))
    .orderBy(postingFailure.occurredAt);
}

/**
 * Replays a failed posting.
 *
 * The stored request is replayed verbatim, so a fix applied to the *mapping* is
 * what makes the difference — not an edited payload. If it succeeds the failure
 * is closed out and points at the journal it eventually produced.
 */
export async function retryFailure(
  scope: RequestScope,
  ctx: ActorContext,
  failureId: bigint,
): Promise<PostingResult> {
  // Scoped, like every other read: the queue is branch-scoped by RLS, so an
  // unscoped select finds nothing and would report a failure in another branch
  // as one that does not exist.
  const failure = await withScope(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(postingFailure)
      .where(eq(postingFailure.id, failureId))
      .limit(1);
    return row;
  });

  if (!failure) throw new Error(`No posting failure with id ${failureId}.`);
  if (failure.resolvedAt) throw new Error('That posting failure has already been resolved.');

  const request = failure.request as unknown as PostingRequest;
  const result = await postAndCommit(scope, ctx, request);

  await withScope(scope, (tx) =>
    tx
      .update(postingFailure)
      .set({
        resolvedAt: new Date(),
        resolvedJournalId: result.journalEntryId,
        retryCount: failure.retryCount + 1,
      })
      .where(eq(postingFailure.id, failureId)),
  );

  return result;
}

// ---------------------------------------------------------------------------
// Mapping maintenance
// ---------------------------------------------------------------------------

export interface DefineRuleInput {
  readonly eventType: string;
  readonly lineRole: string;
  readonly accountId: string;
  readonly itemGroup?: string | null;
  readonly partnerGroup?: string | null;
  readonly warehouseCode?: string | null;
  readonly projectCode?: string | null;
  readonly branchCode?: string | null;
  readonly description?: string | null;
}

export async function defineRule(
  tx: Tx,
  ctx: ActorContext,
  input: DefineRuleInput,
): Promise<{ id: string }> {
  const { authorize } = await import('./authorization');
  await authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });
  assertMappedAccount(
    input.eventType,
    input.lineRole,
    await coa.loadAccount(tx, input.accountId),
  );

  const [created] = await tx
    .insert(postingRuleTable)
    .values({
      eventType: input.eventType,
      lineRole: input.lineRole,
      accountId: input.accountId,
      itemGroup: input.itemGroup ?? null,
      partnerGroup: input.partnerGroup ?? null,
      warehouseCode: input.warehouseCode ?? null,
      projectCode: input.projectCode ?? null,
      branchCode: input.branchCode ?? null,
      description: input.description ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: postingRuleTable.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'posting_rule.configured',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: { ...input },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id };
}

/**
 * The account for one (event, line), with no criteria — what the Posting
 * Mappings screen sets.
 *
 * Replaces rather than adds. `defineRule` is the general act: a mapping
 * narrowed by item group, warehouse or branch sits *over* the plain one and
 * both are wanted. The screen sets the plain one, and setting it twice must
 * leave one rule — a second would match equally well and every posting through
 * it would fail with `AmbiguousPostingRuleError`, which is a worse state than
 * the unmapped one it came from.
 *
 * An account that cannot be posted to is refused by the database trigger with
 * a sentence of its own (§02.1, §3.3); the screen only offers accounts that
 * can, so the two agree.
 */
export async function setMapping(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly eventType: string; readonly lineRole: string; readonly accountId: string },
): Promise<void> {
  const { authorize } = await import('./authorization');
  await authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });
  assertMappedAccount(
    input.eventType,
    input.lineRole,
    await coa.loadAccount(tx, input.accountId),
  );

  const existing = await plainRule(tx, input.eventType, input.lineRole);
  let ruleId = existing?.id;

  if (existing) {
    if (existing.accountId === input.accountId && existing.isActive) return;
    await tx
      .update(postingRuleTable)
      .set({ accountId: input.accountId, isActive: true })
      .where(eq(postingRuleTable.id, existing.id));
  } else {
    const [created] = await tx
      .insert(postingRuleTable)
      .values({
        eventType: input.eventType,
        lineRole: input.lineRole,
        accountId: input.accountId,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: postingRuleTable.id });
    ruleId = created!.id;
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'posting_rule.configured',
    objectType: PERMISSION_OBJECT,
    objectId: ruleId!,
    branchCode: ctx.branchCode,
    before: existing ? { accountId: existing.accountId } : null,
    after: { eventType: input.eventType, lineRole: input.lineRole, accountId: input.accountId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Takes the mapping off a line.
 *
 * Deactivated, not deleted: a journal line records the rule it posted through,
 * and a deleted rule would take that trail with it. `ruleMatches` refuses an
 * inactive rule, so the line is unmapped from the next posting on.
 */
export async function clearMapping(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly eventType: string; readonly lineRole: string },
): Promise<void> {
  const { authorize } = await import('./authorization');
  await authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const existing = await plainRule(tx, input.eventType, input.lineRole);
  if (!existing || !existing.isActive) return;

  await tx
    .update(postingRuleTable)
    .set({ isActive: false })
    .where(eq(postingRuleTable.id, existing.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'posting_rule.cleared',
    objectType: PERMISSION_OBJECT,
    objectId: existing.id,
    branchCode: ctx.branchCode,
    before: { accountId: existing.accountId, isActive: true },
    after: { isActive: false },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** The rule for an (event, line) that states no criteria at all. */
async function plainRule(tx: Tx, eventType: string, lineRole: string) {
  const [row] = await tx
    .select()
    .from(postingRuleTable)
    .where(
      and(
        eq(postingRuleTable.eventType, eventType),
        eq(postingRuleTable.lineRole, lineRole),
        isNull(postingRuleTable.itemGroup),
        isNull(postingRuleTable.partnerGroup),
        isNull(postingRuleTable.warehouseCode),
        isNull(postingRuleTable.projectCode),
        isNull(postingRuleTable.branchCode),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The account a document would post a line to as things stand.
 *
 * What the invoice forms open on: the mapping in force, shown as the chosen
 * value so a person sees where the money is going before they raise anything,
 * and changes it there rather than on a screen of its own (by direction,
 * 2026-09-23). Null when nothing is mapped — the form then asks for a choice
 * instead of pretending to have one.
 */
export async function mappedAccountFor(
  tx: Tx,
  eventType: string,
  lineRole: string,
  branchCode: string,
): Promise<string | null> {
  const rules = await rulesForEvent(tx, eventType);
  try {
    return resolveRule(rules, eventType, lineRole, { branchCode }).accountId;
  } catch {
    return null;
  }
}

/** The mappings, for the Accounting Mapping screen (Appendix C). */
export async function rules(tx: Tx, eventType?: string) {
  const query = tx
    .select({
      id: postingRuleTable.id,
      eventType: postingRuleTable.eventType,
      lineRole: postingRuleTable.lineRole,
      accountId: postingRuleTable.accountId,
      accountCode: chartOfAccount.code,
      accountName: chartOfAccount.name,
      itemGroup: postingRuleTable.itemGroup,
      partnerGroup: postingRuleTable.partnerGroup,
      warehouseCode: postingRuleTable.warehouseCode,
      projectCode: postingRuleTable.projectCode,
      branchCode: postingRuleTable.branchCode,
      isActive: postingRuleTable.isActive,
    })
    .from(postingRuleTable)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, postingRuleTable.accountId));

  return eventType ? query.where(eq(postingRuleTable.eventType, eventType)) : query;
}

/** The posting log for one source document — the drill-down §3.3 requires. */
export async function logFor(tx: Tx, module: string, documentId: string) {
  return tx
    .select()
    .from(postingLog)
    .where(and(eq(postingLog.sourceModule, module), eq(postingLog.sourceDocId, documentId)))
    .orderBy(postingLog.occurredAt);
}

export { sql as _sql };
export type { DimensionType };
