/**
 * Bank reconciliation workspace — Phase 07.7, §17.
 *
 * > §17: *"Automatic matching by amount, date, reference and counterparty, with
 * > manual confirmation."* · *"Resolution of unmatched items, bank fees,
 * > interest, returned payments and timing differences."* · *"Statement lines
 * > are immutable after reconciliation; corrections use reopen/adjustment
 * > workflow."* · *"Reconciliation cannot be finalised with unexplained
 * > differences unless an authorised adjustment is posted."*
 *
 * The workspace does four things and refuses to do a fifth. It **proposes**
 * matches, it lets a person **confirm** them, it lets an authorised adjustment
 * **explain** what is left, and it **agrees** the two balances. What it will not
 * do is finalise over a difference nobody has explained — there is no override
 * for that, because an override is precisely the thing §17 exists to remove.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  bankCashAccount,
  bankReconciliation,
  bankReconciliationMatch,
  bankReconciliationMatchLine,
  bankStatement,
  bankStatementLine,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertFinalisable,
  assertMatchBalances,
  proposeMatches,
  reconcile,
  type LedgerSide,
  type StatementSide,
  type Suggestion,
} from '../domain/bank-reconciliation';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as statuses from './statuses';
import * as treasury from './treasury';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'bank_reconciliation';
export const PERMISSION_OBJECT = 'bank_reconciliation';
const SEQUENCE_KEY = 'BANK_RECONCILIATION';

export class ReconciliationStateError extends Error {
  readonly code = 'RECONCILIATION_STATE_INVALID';
  constructor(reconciliationNo: string, status: string, detail: string) {
    super(`Reconciliation ${reconciliationNo} is '${status}': ${detail}`);
    this.name = 'ReconciliationStateError';
  }
}

async function load(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(bankReconciliation)
    .where(eq(bankReconciliation.id, id))
    .limit(1);
  if (!row) throw new Error(`No bank reconciliation with id '${id}'.`);
  return row;
}

// ---------------------------------------------------------------------------
// Opening the workspace
// ---------------------------------------------------------------------------

/**
 * §17 — opens the workspace for one closed statement.
 *
 * The statement must be closed first: 07.6's close is where opening plus
 * movement is checked against the bank's own closing balance, and reconciling
 * against a statement that has not passed that check would agree the G/L to a
 * number the bank never said.
 */
export async function open(
  tx: Tx,
  ctx: ActorContext,
  statementId: string,
): Promise<{ id: string; reconciliationNo: string }> {
  const [statement] = await tx
    .select()
    .from(bankStatement)
    .where(eq(bankStatement.id, statementId))
    .limit(1);

  if (!statement) throw new Error(`No bank statement with id '${statementId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: statement.branchCode,
  });

  if (statement.status === 'draft') {
    throw new Error(
      `Statement ${statement.statementNo} has not been closed. A statement is checked against the ` +
        "bank's own opening and closing balances when it closes (§17, 07.6); reconciling against " +
        'one that has not passed that check would prove nothing.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: statement.branchCode, year: Number(statement.periodTo.slice(0, 4)) },
    ctx.principal.userId,
  );

  const ledgerBalanceIqd = await ledgerBalance(
    tx,
    ctx,
    statement.bankCashAccountId,
    statement.periodTo,
  );

  const [created] = await tx
    .insert(bankReconciliation)
    .values({
      reconciliationNo: allocated.documentNo,
      bankCashAccountId: statement.bankCashAccountId,
      branchCode: statement.branchCode,
      statementId,
      asOfDate: statement.periodTo,
      statementClosingIqd: statement.closingBalanceIqd,
      ledgerBalanceIqd: toDecimalString(ledgerBalanceIqd, 4n),
      differenceIqd: toDecimalString(
        parseDecimal(statement.closingBalanceIqd, 4n) - ledgerBalanceIqd,
        4n,
      ),
      preparedBy: ctx.principal.userId,
    })
    .returning({ id: bankReconciliation.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.opened',
    objectType: DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: statement.branchCode,
    after: {
      reconciliationNo: allocated.documentNo,
      statementNo: statement.statementNo,
      asOf: statement.periodTo,
      statementClosingIqd: statement.closingBalanceIqd,
      ledgerBalanceIqd: toDecimalString(ledgerBalanceIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, reconciliationNo: allocated.documentNo };
}

/** The G/L balance of the account's mapped G/L account at a date. */
async function ledgerBalance(
  tx: Tx,
  ctx: ActorContext,
  bankCashAccountId: string,
  asOf: string,
): Promise<bigint> {
  const [account] = await tx
    .select({ code: bankCashAccount.code })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, bankCashAccountId))
    .limit(1);

  const [position] = await treasury.balances(tx, ctx, asOf, { accountCode: account!.code });
  return parseDecimal(position?.balanceIqd ?? '0', 4n);
}

// ---------------------------------------------------------------------------
// Matching — §17
// ---------------------------------------------------------------------------

/** Unmatched ledger entries on the bank's G/L account, up to the date. */
async function unmatchedLedger(tx: Tx, reconciliationId: string): Promise<LedgerSide[]> {
  const result = await tx.execute(sql`
    select l.id                                              as "id",
           e.posting_date::text                              as "postingDate",
           (l.debit_iqd - l.credit_iqd)::text                 as "amountIqd",
           coalesce(l.line_description, e.description)        as "reference",
           l.business_partner_code                            as "counterparty"
      from journal_line l
      join journal_entry e on e.id = l.journal_entry_id
      join bank_reconciliation r on r.id = ${reconciliationId}
      join bank_cash_account b on b.id = r.bank_cash_account_id
     where l.account_id = b.gl_account_id
       and e.status in ('posted', 'reversed')
       and e.posting_date <= r.as_of_date
       and not exists (
         select 1 from bank_reconciliation_match_line m where m.journal_line_id = l.id)
     order by e.posting_date, l.line_no
  `);

  const rows = (result as unknown as { rows: Record<string, string | null>[] }).rows;

  return rows.map((row) => ({
    id: row.id as string,
    postingDate: row.postingDate as string,
    amountIqd: parseDecimal(row.amountIqd as string, 4n),
    reference: row.reference ?? null,
    counterparty: row.counterparty ?? null,
  }));
}

/** Unmatched statement lines on this reconciliation's statement. */
async function unmatchedStatement(
  tx: Tx,
  reconciliation: typeof bankReconciliation.$inferSelect,
): Promise<StatementSide[]> {
  const rows = await tx
    .select({
      id: bankStatementLine.id,
      bookingDate: bankStatementLine.bookingDate,
      amountIqd: bankStatementLine.amountIqd,
      reference: bankStatementLine.reference,
      counterparty: bankStatementLine.counterparty,
    })
    .from(bankStatementLine)
    .where(
      and(
        eq(bankStatementLine.statementId, reconciliation.statementId),
        sql`not exists (select 1 from bank_reconciliation_match_line m
                         where m.statement_line_id = ${bankStatementLine.id})`,
      ),
    )
    .orderBy(bankStatementLine.lineNo);

  return rows.map((row) => ({
    id: row.id,
    bookingDate: row.bookingDate,
    amountIqd: parseDecimal(row.amountIqd, 4n),
    reference: row.reference,
    counterparty: row.counterparty,
  }));
}

/**
 * §17 — proposes matches and **writes none of them as agreed**.
 *
 * Every proposal is stored as `suggested`, with the score and the reasons that
 * produced it. The 07.7 gate is that automatic matching *"never auto-commits
 * without confirmation"*, and the way to be sure of that is for this function to
 * have no way of writing a confirmation: `confirmMatch` is where a person's name
 * gets attached, and it is a different function with a different permission.
 */
export async function suggestMatches(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ suggested: number; proposals: Suggestion[] }> {
  const reconciliation = await load(tx, id);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: reconciliation.branchCode,
  });

  if (reconciliation.status !== 'draft') {
    throw new ReconciliationStateError(
      reconciliation.reconciliationNo,
      reconciliation.status,
      'matching happens while it is open.',
    );
  }

  const statementLines = await unmatchedStatement(tx, reconciliation);
  const ledgerItems = await unmatchedLedger(tx, id);
  const proposals = proposeMatches(statementLines, ledgerItems);

  const statementAmounts = new Map(statementLines.map((line) => [line.id, line.amountIqd]));
  const ledgerAmounts = new Map(ledgerItems.map((item) => [item.id, item.amountIqd]));

  let matchNo = await nextMatchNo(tx, id);

  for (const proposal of proposals) {
    const [match] = await tx
      .insert(bankReconciliationMatch)
      .values({
        reconciliationId: id,
        matchNo,
        state: 'suggested',
        confidence: proposal.confidence,
        why: proposal.why,
      })
      .returning({ id: bankReconciliationMatch.id });

    for (const statementLineId of proposal.statementLineIds) {
      await tx.insert(bankReconciliationMatchLine).values({
        matchId: match!.id,
        statementLineId,
        amountIqd: toDecimalString(statementAmounts.get(statementLineId)!, 4n),
      });
    }
    for (const journalLineId of proposal.ledgerItemIds) {
      await tx.insert(bankReconciliationMatchLine).values({
        matchId: match!.id,
        journalLineId,
        amountIqd: toDecimalString(ledgerAmounts.get(journalLineId)!, 4n),
      });
    }

    await tx
      .update(bankStatementLine)
      .set({ matchStatus: 'suggested' })
      .where(inArray(bankStatementLine.id, [...proposal.statementLineIds]));

    matchNo += 1;
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.suggested',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: reconciliation.branchCode,
    after: { suggested: proposals.length },
    outcome: 'success',
  });

  return { suggested: proposals.length, proposals };
}

async function nextMatchNo(tx: Tx, reconciliationId: string): Promise<number> {
  const result = (await tx.execute(sql`
    select coalesce(max(match_no), 0) + 1 as "next"
      from bank_reconciliation_match where reconciliation_id = ${reconciliationId}
  `)) as unknown as { rows: { next: number }[] };
  return Number(result.rows[0]?.next ?? 1);
}

/**
 * §17 — a person agrees a match, and their name goes on it.
 *
 * Confirming re-checks that the two sides total the same rather than trusting
 * what was suggested. A suggestion written yesterday against a journal reversed
 * this morning is a suggestion about money that no longer moved that way.
 */
export async function confirmMatch(
  tx: Tx,
  ctx: ActorContext,
  matchId: string,
): Promise<void> {
  const [match] = await tx
    .select()
    .from(bankReconciliationMatch)
    .where(eq(bankReconciliationMatch.id, matchId))
    .limit(1);

  if (!match) throw new Error(`No reconciliation match with id '${matchId}'.`);
  const reconciliation = await load(tx, match.reconciliationId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: reconciliation.branchCode,
  });

  if (reconciliation.status !== 'draft') {
    throw new ReconciliationStateError(
      reconciliation.reconciliationNo,
      reconciliation.status,
      'matches are confirmed while it is open.',
    );
  }
  if (match.state === 'confirmed') return;

  const lines = await tx
    .select()
    .from(bankReconciliationMatchLine)
    .where(eq(bankReconciliationMatchLine.matchId, matchId));

  assertMatchBalances(
    lines.filter((l) => l.statementLineId).map((l) => parseDecimal(l.amountIqd, 4n)),
    lines.filter((l) => l.journalLineId).map((l) => parseDecimal(l.amountIqd, 4n)),
  );

  await tx
    .update(bankReconciliationMatch)
    .set({ state: 'confirmed', confirmedBy: ctx.principal.userId, confirmedAt: new Date() })
    .where(eq(bankReconciliationMatch.id, matchId));

  for (const line of lines) {
    if (!line.statementLineId) continue;
    await tx
      .update(bankStatementLine)
      .set({ matchStatus: 'matched' })
      .where(eq(bankStatementLine.id, line.statementLineId));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.match_confirmed',
    objectType: DOCUMENT_TYPE,
    objectId: match.reconciliationId,
    branchCode: reconciliation.branchCode,
    after: {
      matchNo: match.matchNo,
      confidence: match.confidence,
      why: match.why,
      statementLines: lines.filter((l) => l.statementLineId).length,
      ledgerLines: lines.filter((l) => l.journalLineId).length,
    },
    outcome: 'success',
  });
}

/**
 * §17 and §12.5 — a match a person built by hand, of any shape.
 *
 * This is the path the Money Transfer batch takes: several ledger entries
 * against one statement line. It is also how somebody corrects a suggestion the
 * system got wrong, which is why it exists alongside the automatic matching
 * rather than only for the batch case.
 */
export async function matchManually(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { statementLineIds: readonly string[]; journalLineIds: readonly string[] },
): Promise<{ matchId: string }> {
  const reconciliation = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: reconciliation.branchCode,
  });

  if (reconciliation.status !== 'draft') {
    throw new ReconciliationStateError(
      reconciliation.reconciliationNo,
      reconciliation.status,
      'matches are made while it is open.',
    );
  }
  if (input.statementLineIds.length === 0 || input.journalLineIds.length === 0) {
    throw new Error(
      'A match needs at least one line on each side. One side alone is an unmatched item, which ' +
        'the reconciliation already knows about (§17).',
    );
  }

  const statementLines = await tx
    .select({ id: bankStatementLine.id, amountIqd: bankStatementLine.amountIqd })
    .from(bankStatementLine)
    .where(inArray(bankStatementLine.id, [...input.statementLineIds]));

  const ledgerResult = (await tx.execute(sql`
    select l.id as "id", (l.debit_iqd - l.credit_iqd)::text as "amountIqd"
      from journal_line l where l.id in (${sql.join(input.journalLineIds.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { rows: { id: string; amountIqd: string }[] };

  assertMatchBalances(
    statementLines.map((l) => parseDecimal(l.amountIqd, 4n)),
    ledgerResult.rows.map((l) => parseDecimal(l.amountIqd, 4n)),
  );

  const matchNo = await nextMatchNo(tx, id);
  const [match] = await tx
    .insert(bankReconciliationMatch)
    .values({
      reconciliationId: id,
      matchNo,
      state: 'confirmed',
      why: 'Matched by hand',
      confirmedBy: ctx.principal.userId,
      confirmedAt: new Date(),
    })
    .returning({ id: bankReconciliationMatch.id });

  for (const line of statementLines) {
    await tx.insert(bankReconciliationMatchLine).values({
      matchId: match!.id,
      statementLineId: line.id,
      amountIqd: line.amountIqd,
    });
    await tx
      .update(bankStatementLine)
      .set({ matchStatus: 'matched' })
      .where(eq(bankStatementLine.id, line.id));
  }
  for (const line of ledgerResult.rows) {
    await tx.insert(bankReconciliationMatchLine).values({
      matchId: match!.id,
      journalLineId: line.id,
      amountIqd: line.amountIqd,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.match_manual',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: reconciliation.branchCode,
    after: {
      matchNo,
      statementLines: statementLines.length,
      ledgerLines: ledgerResult.rows.length,
    },
    outcome: 'success',
  });

  return { matchId: match!.id };
}

// ---------------------------------------------------------------------------
// Adjustments — §17
// ---------------------------------------------------------------------------

/**
 * §17 — *"resolution of … bank fees, interest, returned payments."*
 *
 * A statement line the books have never seen is not a mismatch, it is a
 * transaction nobody recorded: the bank took a fee, or paid interest, or sent a
 * payment back. The resolution is to **record it** — a real journal through the
 * Phase 02 engine, against an account the person names — and then match the
 * statement line to the entry that posting created.
 *
 * That is what makes the 07.7 gate's *"an authorised adjustment posts through
 * the Phase 02 engine"* true rather than aspirational: there is no adjustment
 * that is not a posting, and no way to make the difference go away without one.
 */
export async function postAdjustment(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    statementLineId: string;
    accountId: string;
    description: string;
    departmentCode?: string | null;
    businessLineCode?: string | null;
  },
): Promise<{ journalEntryId: string; matchId: string }> {
  const reconciliation = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: reconciliation.branchCode,
  });

  if (reconciliation.status !== 'draft') {
    throw new ReconciliationStateError(
      reconciliation.reconciliationNo,
      reconciliation.status,
      'adjustments are posted while it is open.',
    );
  }
  if (!input.description.trim()) {
    throw new Error(
      'An adjustment needs a description (§17). It is the only record of what the difference ' +
        'actually was, and a reconciliation full of unnamed adjustments explains nothing.',
    );
  }

  const [line] = await tx
    .select()
    .from(bankStatementLine)
    .where(eq(bankStatementLine.id, input.statementLineId))
    .limit(1);

  if (!line) throw new Error(`No statement line with id '${input.statementLineId}'.`);
  if (line.statementId !== reconciliation.statementId) {
    throw new Error(
      `That statement line belongs to another statement. An adjustment explains a difference on ` +
        `${reconciliation.reconciliationNo}'s own statement.`,
    );
  }

  const [account] = await tx
    .select({ glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, reconciliation.bankCashAccountId))
    .limit(1);

  const amount = parseDecimal(line.amountIqd, 4n);
  const criteria = { branchCode: reconciliation.branchCode };
  const dimensions = {
    branch: reconciliation.branchCode,
    department: input.departmentCode ?? null,
    business_line: input.businessLineCode ?? null,
  };

  // Money in is a debit to the bank; money out is a credit. The other side is
  // the account the person named — a charge, an income, a clearing account.
  const bankSide =
    amount > 0n
      ? { role: 'bank', accountId: account!.glAccountId, debit: toDecimalString(amount, 4n) }
      : { role: 'bank', accountId: account!.glAccountId, credit: toDecimalString(-amount, 4n) };
  const otherSide =
    amount > 0n
      ? { role: 'reconciliation_adjustment', accountId: input.accountId, credit: toDecimalString(amount, 4n) }
      : { role: 'reconciliation_adjustment', accountId: input.accountId, debit: toDecimalString(-amount, 4n) };

  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.reconciliation_adjustment',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'treasury', documentId: id, event: `adjustment-${line.id}` },
    branchCode: reconciliation.branchCode,
    documentDate: line.bookingDate,
    postingDate: line.bookingDate,
    description: `${reconciliation.reconciliationNo} adjustment — ${input.description.trim()}`,
    lines: [
      { ...bankSide, criteria, dimensions: { branch: reconciliation.branchCode } },
      { ...otherSide, criteria, dimensions },
    ],
  });

  // The posting created a line on the bank account; match the statement line to
  // it, so the adjustment is not merely posted but accounted for.
  const created = (await tx.execute(sql`
    select l.id as "id", (l.debit_iqd - l.credit_iqd)::text as "amountIqd"
      from journal_line l
      join bank_cash_account b on b.gl_account_id = l.account_id
     where l.journal_entry_id = ${result.journalEntryId}
       and b.id = ${reconciliation.bankCashAccountId}
     limit 1
  `)) as unknown as { rows: { id: string; amountIqd: string }[] };

  const matchNo = await nextMatchNo(tx, id);
  const [match] = await tx
    .insert(bankReconciliationMatch)
    .values({
      reconciliationId: id,
      matchNo,
      state: 'confirmed',
      why: `Adjustment: ${input.description.trim()}`,
      fromAdjustment: result.journalEntryId,
      confirmedBy: ctx.principal.userId,
      confirmedAt: new Date(),
    })
    .returning({ id: bankReconciliationMatch.id });

  await tx.insert(bankReconciliationMatchLine).values({
    matchId: match!.id,
    statementLineId: line.id,
    amountIqd: line.amountIqd,
  });
  await tx.insert(bankReconciliationMatchLine).values({
    matchId: match!.id,
    journalLineId: created.rows[0]!.id,
    amountIqd: created.rows[0]!.amountIqd,
  });

  await tx
    .update(bankStatementLine)
    .set({ matchStatus: 'matched' })
    .where(eq(bankStatementLine.id, line.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.adjustment_posted',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: reconciliation.branchCode,
    after: {
      statementLine: line.lineNo,
      amountIqd: line.amountIqd,
      journalEntryId: result.journalEntryId,
      description: input.description.trim(),
    },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId, matchId: match!.id };
}

// ---------------------------------------------------------------------------
// The arithmetic, and finalising
// ---------------------------------------------------------------------------

export interface ReconciliationPosition {
  readonly statementClosingIqd: bigint;
  readonly ledgerBalanceIqd: bigint;
  readonly depositsInTransitIqd: bigint;
  readonly unpresentedPaymentsIqd: bigint;
  readonly reconciledBalanceIqd: bigint;
  readonly differenceIqd: bigint;
  readonly balanced: boolean;
  readonly unmatchedStatementLines: number;
  readonly unmatchedLedgerItems: number;
}

/**
 * §17 acceptance criterion 3 — where the two balances stand right now.
 *
 * Timing differences come from the *unmatched ledger* side: entries the company
 * has recorded that the bank has not shown. Deposits in transit are the debits
 * among them, unpresented payments the credits. Nothing here treats them as
 * errors — they are the explanation, and the reconciliation is finished when
 * they are the *whole* explanation.
 */
export async function position(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<ReconciliationPosition> {
  const reconciliation = await load(tx, id);

  const ledgerItems = await unmatchedLedger(tx, id);
  const statementLines = await unmatchedStatement(tx, reconciliation);

  const depositsInTransitIqd = ledgerItems
    .filter((item) => item.amountIqd > 0n)
    .reduce((total, item) => total + item.amountIqd, 0n);
  const unpresentedPaymentsIqd = ledgerItems
    .filter((item) => item.amountIqd < 0n)
    .reduce((total, item) => total - item.amountIqd, 0n);

  const ledgerBalanceIqd = await ledgerBalance(
    tx,
    ctx,
    reconciliation.bankCashAccountId,
    reconciliation.asOfDate,
  );

  const result = reconcile({
    statementClosingIqd: parseDecimal(reconciliation.statementClosingIqd, 4n),
    ledgerBalanceIqd,
    depositsInTransitIqd,
    unpresentedPaymentsIqd,
  });

  return {
    statementClosingIqd: parseDecimal(reconciliation.statementClosingIqd, 4n),
    ledgerBalanceIqd,
    depositsInTransitIqd,
    unpresentedPaymentsIqd,
    reconciledBalanceIqd: result.reconciledBalanceIqd,
    differenceIqd: result.differenceIqd,
    balanced: result.balanced,
    unmatchedStatementLines: statementLines.length,
    unmatchedLedgerItems: ledgerItems.length,
  };
}

/**
 * §17 — finalises, and only if it balances.
 *
 * There is no override parameter and that is the point. §17 says a
 * reconciliation *"cannot be finalised with unexplained differences unless an
 * authorised adjustment is posted"* — and an adjustment does not waive the rule,
 * it removes the difference by explaining it. A flag would let somebody finalise
 * over a difference they had not explained, which is the exact outcome the
 * sentence exists to prevent.
 *
 * An unmatched **statement** line also blocks it. Every line the bank sent is
 * either the company's own entry or something that needs recording; leaving one
 * neither matched nor adjusted means the difference has been absorbed rather
 * than explained.
 */
export async function finalise(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<ReconciliationPosition> {
  const reconciliation = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: reconciliation.branchCode,
  });

  if (reconciliation.status !== 'draft') {
    throw new ReconciliationStateError(
      reconciliation.reconciliationNo,
      reconciliation.status,
      'it has already been finalised.',
    );
  }

  const current = await position(tx, ctx, id);

  if (current.unmatchedStatementLines > 0) {
    throw new Error(
      `${reconciliation.reconciliationNo} still has ${current.unmatchedStatementLines} statement ` +
        'line(s) neither matched nor adjusted (§17). Every line the bank sent is either an entry ' +
        'the company already made or a transaction nobody recorded; leaving one out absorbs the ' +
        'difference rather than explaining it.',
    );
  }

  assertFinalisable(current);

  const suggested = await tx
    .select({ id: bankReconciliationMatch.id })
    .from(bankReconciliationMatch)
    .where(
      and(
        eq(bankReconciliationMatch.reconciliationId, id),
        eq(bankReconciliationMatch.state, 'suggested'),
      ),
    );

  if (suggested.length > 0) {
    throw new Error(
      `${reconciliation.reconciliationNo} has ${suggested.length} suggested match(es) nobody has ` +
        'confirmed (§17). Automatic matching proposes; a person agrees. Finalising over an ' +
        'unconfirmed suggestion would be the system agreeing with itself.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, reconciliation.status, 'approved');

  await tx
    .update(bankReconciliation)
    .set({
      status: 'approved',
      ledgerBalanceIqd: toDecimalString(current.ledgerBalanceIqd, 4n),
      depositsInTransitIqd: toDecimalString(current.depositsInTransitIqd, 4n),
      unpresentedPaymentsIqd: toDecimalString(current.unpresentedPaymentsIqd, 4n),
      differenceIqd: toDecimalString(current.differenceIqd, 4n),
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankReconciliation.id, id));

  await tx
    .update(bankStatement)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(bankStatement.id, reconciliation.statementId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.finalised',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: reconciliation.branchCode,
    before: { status: reconciliation.status },
    after: {
      status: 'approved',
      statementClosingIqd: toDecimalString(current.statementClosingIqd, 4n),
      depositsInTransitIqd: toDecimalString(current.depositsInTransitIqd, 4n),
      unpresentedPaymentsIqd: toDecimalString(current.unpresentedPaymentsIqd, 4n),
      ledgerBalanceIqd: toDecimalString(current.ledgerBalanceIqd, 4n),
      differenceIqd: '0.0000',
    },
    outcome: 'success',
  });

  return current;
}

/**
 * §17 — *"corrections use reopen/adjustment workflow."*
 *
 * Reopening is a named act with a reason, counted and audited. It does not
 * delete the previous agreement — the audit trail keeps it — but it does undo
 * its effects: the matches go back to suggestions, the statement lines become
 * editable again, and the reconciliation is a draft that must balance again
 * before anybody can sign it a second time.
 *
 * Counting reopens is deliberate. One is a correction; five on the same
 * statement is a story somebody should read.
 */
export async function reopen(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const reconciliation = await load(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: reconciliation.branchCode,
  });

  if (reconciliation.status !== 'approved') {
    throw new ReconciliationStateError(
      reconciliation.reconciliationNo,
      reconciliation.status,
      'only a finalised reconciliation can be reopened.',
    );
  }
  if (!reason.trim()) {
    throw new Error(
      'Reopening a finalised reconciliation needs a reason (§17, §5.4). Somebody agreed this ' +
        'balance; undoing that without saying why leaves the trail unreadable.',
    );
  }

  await statuses.assertTransitionAllowed(
    tx,
    DOCUMENT_TYPE,
    reconciliation.status,
    'draft',
    reason.trim(),
  );

  const matches = await tx
    .select({ id: bankReconciliationMatch.id })
    .from(bankReconciliationMatch)
    .where(eq(bankReconciliationMatch.reconciliationId, id));

  await tx
    .update(bankReconciliationMatch)
    .set({ state: 'suggested', confirmedBy: null, confirmedAt: null })
    .where(eq(bankReconciliationMatch.reconciliationId, id));

  await tx
    .update(bankStatementLine)
    .set({ matchStatus: 'suggested' })
    .where(eq(bankStatementLine.statementId, reconciliation.statementId));

  await tx
    .update(bankReconciliation)
    .set({
      status: 'draft',
      approvedBy: null,
      approvedAt: null,
      reopenedBy: ctx.principal.userId,
      reopenedAt: new Date(),
      reopenReason: reason.trim(),
      reopenCount: sql`${bankReconciliation.reopenCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(bankReconciliation.id, id));

  await tx
    .update(bankStatement)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(bankStatement.id, reconciliation.statementId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_reconciliation.reopened',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: reconciliation.branchCode,
    before: { status: 'approved', matches: matches.length },
    after: { status: 'draft', reopenCount: reconciliation.reopenCount + 1 },
    reason: reason.trim(),
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// Reading — §17 acceptance criterion 4
// ---------------------------------------------------------------------------

export async function view(tx: Tx, ctx: ActorContext, id: string) {
  const reconciliation = await load(tx, id);
  const matches = await tx
    .select()
    .from(bankReconciliationMatch)
    .where(eq(bankReconciliationMatch.reconciliationId, id))
    .orderBy(bankReconciliationMatch.matchNo);

  return { reconciliation, matches, position: await position(tx, ctx, id) };
}

/**
 * §17 acceptance criterion 4 — *"unmatched and unidentified items are reported
 * and aged."*
 *
 * Both sides, because both matter and they mean different things: a statement
 * line nobody has matched is money the bank moved that the books do not show,
 * and a ledger entry nobody has matched is money the books show that the bank
 * has not. The first is usually a missing entry; the second is usually time.
 */
export async function unmatchedReport(tx: Tx, ctx: ActorContext, id: string) {
  const reconciliation = await load(tx, id);
  const statementLines = await unmatchedStatement(tx, reconciliation);
  const ledgerItems = await unmatchedLedger(tx, id);

  const ageOf = (isoDate: string) => {
    const days = Math.round(
      (Date.parse(`${reconciliation.asOfDate}T00:00:00Z`) - Date.parse(`${isoDate}T00:00:00Z`)) /
        86_400_000,
    );
    return days;
  };

  return {
    statement: statementLines.map((line) => ({
      ...line,
      amountIqd: toDecimalString(line.amountIqd, 4n),
      ageDays: ageOf(line.bookingDate),
    })),
    ledger: ledgerItems.map((item) => ({
      ...item,
      amountIqd: toDecimalString(item.amountIqd, 4n),
      ageDays: ageOf(item.postingDate),
      kind: item.amountIqd > 0n ? ('deposit_in_transit' as const) : ('unpresented' as const),
    })),
  };
}
