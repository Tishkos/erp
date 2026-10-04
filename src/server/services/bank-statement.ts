/**
 * Bank statement import and manual entry — Phase 07.6, §17, §23.
 *
 * > §17: *"Import or manual entry of bank statements, per the statement format
 * > on the account master."*
 * > Appendix B: *"Unique import key; match status; book-to-bank reconciliation."*
 *
 * The whole of this module is about getting the bank's own account of events
 * into the system **without changing it**. Nothing posts, nothing is inferred,
 * and nothing is quietly dropped: a line that cannot be read is kept as text
 * with the reason, because the person who has to fix it needs to see what the
 * bank actually sent.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  bankCashAccount,
  bankStatement,
  bankStatementLine,
  bankStatementRejectedLine,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertLineUsable,
  assertStatementBalances,
  importKeyFor,
  type StatementLineInput,
} from '../domain/bank-statement';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import { allocateDocumentNumber } from './numbering';
import { parseDelimited } from '../domain/import';

export const DOCUMENT_TYPE = 'bank_statement';
export const PERMISSION_OBJECT = 'bank_statement';
const SEQUENCE_KEY = 'BANK_STATEMENT';

export interface ImportStatementInput {
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly openingBalanceIqd: bigint;
  readonly closingBalanceIqd: bigint;
  readonly bankReference?: string | null;
  readonly importBatchId?: string | null;
  readonly lines: readonly StatementLineInput[];
  /** Rows the parser could not read — kept, not discarded. */
  readonly rejected?: readonly { lineNo: number; rawText: string; problem: string }[];
}

export interface ImportResult {
  readonly id: string;
  readonly statementNo: string;
  readonly imported: number;
  /** Lines already present under the same import key — the re-import case. */
  readonly duplicates: number;
  readonly rejected: number;
}

export interface OpenStatementInput {
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly openingBalanceIqd: bigint;
  readonly closingBalanceIqd: bigint;
  readonly bankReference?: string | null;
  readonly importBatchId?: string | null;
}

/**
 * §17 — the statement header: whose account, which period, and the bank's own
 * two balances.
 *
 * The header is stated rather than derived, and always by a person, even when
 * the lines come from a file. It is the claim the file will be checked against —
 * a closing balance the system worked out from the lines would agree with them
 * by construction, and agreeing with them is exactly what has to be proved.
 */
export async function openStatement(
  tx: Tx,
  ctx: ActorContext,
  input: OpenStatementInput,
): Promise<{ id: string; statementNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const account = await loadAccount(tx, input.bankCashAccountId);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.periodTo.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(bankStatement)
    .values({
      statementNo: allocated.documentNo,
      bankCashAccountId: input.bankCashAccountId,
      branchCode: input.branchCode,
      bankReference: input.bankReference ?? null,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      currency: account.currency,
      openingBalanceIqd: toDecimalString(input.openingBalanceIqd, 4n),
      closingBalanceIqd: toDecimalString(input.closingBalanceIqd, 4n),
      importBatchId: input.importBatchId ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: bankStatement.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_statement.opened',
    objectType: DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      statementNo: allocated.documentNo,
      account: account.code,
      period: `${input.periodFrom}..${input.periodTo}`,
      openingBalanceIqd: toDecimalString(input.openingBalanceIqd, 4n),
      closingBalanceIqd: toDecimalString(input.closingBalanceIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, statementNo: allocated.documentNo };
}

/**
 * One line, from a file row or from a screen — the same path for both.
 *
 * Returns `duplicate` rather than throwing when the key is already present.
 * A re-import is not an error; it is the normal consequence of overlapping
 * downloads, and a file that raised forty errors for forty lines already held
 * would teach people to ignore the errors.
 */
export async function appendLine(
  tx: Tx,
  ctx: ActorContext,
  statementId: string,
  line: StatementLineInput,
): Promise<{ id: string | null; duplicate: boolean; importKey: string }> {
  const [statement] = await tx
    .select()
    .from(bankStatement)
    .where(eq(bankStatement.id, statementId))
    .limit(1);

  if (!statement) throw new Error(`No bank statement with id '${statementId}'.`);
  if (statement.status !== 'draft') {
    throw new Error(
      `Statement ${statement.statementNo} is '${statement.status}'. Lines are added while it is a ` +
        'draft; a closed statement has been agreed and adding to it would change what was agreed (§17).',
    );
  }

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: statement.branchCode,
  });

  assertLineUsable(line);

  const account = await loadAccount(tx, statement.bankCashAccountId);

  // The line's own position is the ordinal. It cannot be counted from what is
  // already stored: on a second pass the count would have grown, every key
  // would be new, and the re-import this exists to prevent would go straight
  // through. The position comes from the file and is the same on every pass.
  const importKey = importKeyFor(
    {
      accountCode: account.code,
      bookingDate: line.bookingDate,
      amountIqd: line.amountIqd,
      reference: line.reference,
      ordinal: line.ordinal ?? line.lineNo,
    },
    line.bankReference,
  );

  const inserted = await tx
    .insert(bankStatementLine)
    .values({
      statementId,
      lineNo: line.lineNo,
      importKey,
      bookingDate: line.bookingDate,
      valueDate: line.valueDate,
      amountIqd: toDecimalString(line.amountIqd, 4n),
      reference: line.reference,
      counterparty: line.counterparty,
      description: line.description,
    })
    .onConflictDoNothing({ target: bankStatementLine.importKey })
    .returning({ id: bankStatementLine.id });

  return {
    id: inserted[0]?.id ?? null,
    duplicate: inserted.length === 0,
    importKey,
  };
}

/** §17 and §23 — a row of the file nobody could read, kept with its reason. */
export async function rejectLine(
  tx: Tx,
  statementId: string,
  row: { lineNo: number; rawText: string; problem: string },
): Promise<void> {
  await tx.insert(bankStatementRejectedLine).values({
    statementId,
    lineNo: row.lineNo,
    rawText: row.rawText,
    problem: row.problem,
  });
}

/**
 * §17 — closes the statement, and only if it adds up.
 *
 * Opening plus movement equals closing, or the statement stays a draft. A
 * truncated download still looks like a statement, and reconciling to one would
 * agree the G/L to a number the bank never said — which is worse than not
 * reconciling at all, because it comes with a tick next to it.
 */
export async function closeStatement(
  tx: Tx,
  ctx: ActorContext,
  statementId: string,
): Promise<{ movementIqd: bigint }> {
  const [statement] = await tx
    .select()
    .from(bankStatement)
    .where(eq(bankStatement.id, statementId))
    .limit(1);

  if (!statement) throw new Error(`No bank statement with id '${statementId}'.`);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: statement.branchCode,
  });

  if (statement.status !== 'draft') {
    throw new Error(`Statement ${statement.statementNo} is already '${statement.status}'.`);
  }

  const lines = await tx
    .select({ amountIqd: bankStatementLine.amountIqd })
    .from(bankStatementLine)
    .where(eq(bankStatementLine.statementId, statementId));

  assertStatementBalances({
    openingIqd: parseDecimal(statement.openingBalanceIqd, 4n),
    closingIqd: parseDecimal(statement.closingBalanceIqd, 4n),
    lines: lines.map((line) => ({ amountIqd: parseDecimal(line.amountIqd, 4n) })),
  });

  await tx
    .update(bankStatement)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(bankStatement.id, statementId));

  const movementIqd = lines.reduce(
    (total, line) => total + parseDecimal(line.amountIqd, 4n),
    0n,
  );

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_statement.closed',
    objectType: DOCUMENT_TYPE,
    objectId: statementId,
    branchCode: statement.branchCode,
    before: { status: statement.status },
    after: {
      status: 'approved',
      lines: lines.length,
      movementIqd: toDecimalString(movementIqd, 4n),
    },
    outcome: 'success',
  });

  return { movementIqd };
}

/**
 * §17 — one whole statement in one call: header, lines, rejections, close.
 *
 * The path a manual entry or a programmatic feed takes. The file-import centre
 * uses the same three steps with the framework's batch in between, so there is
 * one implementation of what a statement line is and one of what makes a
 * statement acceptable.
 *
 * **Importing the same statement twice does not duplicate lines.** Each line
 * carries a key derived from the transaction rather than from its position in
 * the file; a second import of the same download inserts nothing and says how
 * many it recognised. That is a stronger guarantee than checking the statement
 * reference, which the same file exported over a different date range would not
 * share.
 */
export async function importStatement(
  tx: Tx,
  ctx: ActorContext,
  input: ImportStatementInput,
): Promise<ImportResult> {
  const opened = await openStatement(tx, ctx, input);

  let imported = 0;
  let duplicates = 0;

  for (const line of input.lines) {
    const result = await appendLine(tx, ctx, opened.id, line);
    if (result.duplicate) duplicates += 1;
    else imported += 1;
  }

  for (const row of input.rejected ?? []) {
    await rejectLine(tx, opened.id, row);
  }

  await closeStatement(tx, ctx, opened.id);

  return {
    id: opened.id,
    statementNo: opened.statementNo,
    imported,
    duplicates,
    rejected: (input.rejected ?? []).length,
  };
}

/** By its document number — how a file row names the statement it belongs to. */
export async function findByNo(tx: Tx, statementNo: string) {
  const [statement] = await tx
    .select()
    .from(bankStatement)
    .where(eq(bankStatement.statementNo, statementNo))
    .limit(1);

  if (!statement) {
    throw new Error(
      `No bank statement numbered '${statementNo}'. Open the statement first — whose account, ` +
        'which period, and the bank’s own opening and closing balances — then import its lines (§17).',
    );
  }
  return statement;
}

async function loadAccount(tx: Tx, id: string) {
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, id))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${id}'.`);
  if (account.accountType !== 'bank') {
    throw new Error(
      `${account.code} is a ${account.accountType} account. A statement comes from a bank; ` +
        'a cash float is agreed by counting it instead (§17, 07.5).',
    );
  }
  return account;
}

/**
 * The statement with its lines and whatever could not be read.
 *
 * Rejected rows come back with it rather than from a separate call, because a
 * statement read without them is a statement that looks complete and is not.
 */
export async function view(tx: Tx, id: string) {
  const [statement] = await tx
    .select()
    .from(bankStatement)
    .where(eq(bankStatement.id, id))
    .limit(1);

  if (!statement) throw new Error(`No bank statement with id '${id}'.`);

  const lines = await tx
    .select()
    .from(bankStatementLine)
    .where(eq(bankStatementLine.statementId, id))
    .orderBy(bankStatementLine.lineNo);

  const rejected = await tx
    .select()
    .from(bankStatementRejectedLine)
    .where(eq(bankStatementRejectedLine.statementId, id))
    .orderBy(bankStatementRejectedLine.lineNo);

  const movement = lines.reduce((total, line) => total + parseDecimal(line.amountIqd, 4n), 0n);

  return { statement, lines, rejected, movementIqd: movement };
}

/**
 * §17 — the lines that still have no counterpart, oldest first.
 *
 * The starting point for 07.7's workspace and, on its own, the answer to
 * criterion 4: *"unmatched and unidentified items are reported and aged."*
 */
export async function unmatchedLines(
  tx: Tx,
  filter: { bankCashAccountId?: string; asOf?: string } = {},
) {
  return tx
    .select({
      statementNo: bankStatement.statementNo,
      accountId: bankStatement.bankCashAccountId,
      lineId: bankStatementLine.id,
      lineNo: bankStatementLine.lineNo,
      bookingDate: bankStatementLine.bookingDate,
      valueDate: bankStatementLine.valueDate,
      amountIqd: bankStatementLine.amountIqd,
      reference: bankStatementLine.reference,
      counterparty: bankStatementLine.counterparty,
      matchStatus: bankStatementLine.matchStatus,
    })
    .from(bankStatementLine)
    .innerJoin(bankStatement, eq(bankStatement.id, bankStatementLine.statementId))
    .where(
      and(
        sql`${bankStatementLine.matchStatus} in ('unmatched', 'suggested')`,
        filter.bankCashAccountId
          ? eq(bankStatement.bankCashAccountId, filter.bankCashAccountId)
          : sql`true`,
        filter.asOf ? sql`${bankStatementLine.bookingDate} <= ${filter.asOf}::date` : sql`true`,
      ),
    )
    .orderBy(bankStatementLine.bookingDate, bankStatementLine.lineNo);
}

/** Everything the parser refused, across statements — the 07.6 gate's report. */
export async function rejectedReport(tx: Tx, branchCode?: string | null) {
  return tx
    .select({
      statementNo: bankStatement.statementNo,
      lineNo: bankStatementRejectedLine.lineNo,
      rawText: bankStatementRejectedLine.rawText,
      problem: bankStatementRejectedLine.problem,
    })
    .from(bankStatementRejectedLine)
    .innerJoin(bankStatement, eq(bankStatement.id, bankStatementRejectedLine.statementId))
    .where(branchCode ? eq(bankStatement.branchCode, branchCode) : sql`true`)
    .orderBy(bankStatement.statementNo, bankStatementRejectedLine.lineNo);
}

// ---------------------------------------------------------------------------
// Entry from the Bank Reconciliation screen — REQ-ACC-001 Part D-3
// ---------------------------------------------------------------------------

/** The columns a pasted statement is read by — the import centre's own names. */
export const PASTE_COLUMNS = ['booking_date', 'value_date', 'amount_iqd', 'reference', 'counterparty', 'description', 'bank_reference'] as const;

export interface AddedLines {
  readonly added: number;
  readonly duplicates: number;
  readonly rejected: number;
}

async function draftStatement(tx: Tx, statementId: string) {
  const [statement] = await tx.select().from(bankStatement).where(eq(bankStatement.id, statementId)).limit(1).for('update');
  if (!statement) throw new Error(`No bank statement with id '${statementId}'.`);
  if (statement.status !== 'draft') {
    throw new Error(
      `Statement ${statement.statementNo} is '${statement.status}'. Lines are added while it is a draft; ` +
        'a closed statement has been agreed (§17).',
    );
  }
  return statement;
}

async function nextLineNo(tx: Tx, statementId: string): Promise<number> {
  const result = (await tx.execute(sql`
    select coalesce(max(line_no), 0) + 1 as next from (
      select line_no from bank_statement_line where statement_id = ${statementId}
      union all
      select line_no from bank_statement_rejected_line where statement_id = ${statementId}
    ) l`)) as unknown as { rows: { next: number }[] };
  return Number(result.rows[0]?.next ?? 1);
}

/**
 * Lines typed on the screen or pasted from the bank's file, onto a draft
 * statement — through `appendLine`, the one path every line takes, so the
 * import key, the value-date rule and the zero rule are the same as the
 * import centre's. A row that cannot be read is kept with its reason
 * (`rejectLine`), never dropped. One audit event says what came in.
 */
export async function addLines(
  tx: Tx,
  ctx: ActorContext,
  statementId: string,
  input: {
    readonly lines: readonly Omit<StatementLineInput, 'lineNo'>[];
    readonly rejected?: readonly { readonly rawText: string; readonly problem: string }[];
    readonly source: 'typed' | 'pasted';
  },
): Promise<AddedLines> {
  const statement = await draftStatement(tx, statementId);
  await authz.authorize(ctx.principal, input.source === 'pasted' ? 'import' : 'create', PERMISSION_OBJECT, {
    branchCode: statement.branchCode,
  });

  let lineNo = await nextLineNo(tx, statementId);
  let added = 0;
  let duplicates = 0;
  for (const [index, line] of input.lines.entries()) {
    // A pasted row keeps its position in the file as the key's ordinal, so the
    // same file pasted twice adds nothing the second time.
    const ordinal = input.source === 'pasted' ? (line.ordinal ?? index + 1) : lineNo;
    const result = await appendLine(tx, ctx, statementId, { ...line, lineNo, ordinal });
    if (result.duplicate) duplicates += 1;
    else {
      added += 1;
      lineNo += 1;
    }
  }
  for (const row of input.rejected ?? []) {
    await rejectLine(tx, statementId, { lineNo, rawText: row.rawText, problem: row.problem });
    lineNo += 1;
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_statement.lines_added',
    objectType: DOCUMENT_TYPE,
    objectId: statementId,
    branchCode: statement.branchCode,
    after: { source: input.source, added, duplicates, rejected: (input.rejected ?? []).length },
    outcome: 'success',
  });
  return { added, duplicates, rejected: (input.rejected ?? []).length };
}

/**
 * The bank's file, pasted: a header row naming `PASTE_COLUMNS` (only
 * `booking_date` and `amount_iqd` are required; a missing value date is the
 * booking date, as the import centre reads it), then one line per row,
 * comma- or tab-separated. Pure — `addLines` does the writing.
 */
export function readPastedLines(content: string): {
  readonly lines: Omit<StatementLineInput, 'lineNo'>[];
  readonly rejected: { rawText: string; problem: string }[];
} {
  const text = content.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const { columns, rows } = parseDelimited(text, { delimiter });
  const known = columns.map((column) => column.toLowerCase());
  for (const required of ['booking_date', 'amount_iqd']) {
    if (!known.includes(required)) throw new Error(`The pasted statement has no "${required}" column. Its first row names the columns.`);
  }
  const raw = text.split(/\r?\n/).slice(1).filter((line) => line.trim() !== '');
  const lines: Omit<StatementLineInput, 'lineNo'>[] = [];
  const rejected: { rawText: string; problem: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const cell = (name: string) => {
      const column = columns[known.indexOf(name)];
      return column === undefined ? null : (row.values[column] ?? null);
    };
    try {
      const bookingDate = cell('booking_date');
      const amount = cell('amount_iqd');
      if (!bookingDate || !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) throw new Error('booking_date is not a date (YYYY-MM-DD).');
      if (!amount || !/^-?\d+(\.\d{1,4})?$/.test(amount.replace(/[,\s]/g, ''))) throw new Error('amount_iqd is not an amount.');
      const valueDate = cell('value_date') ?? bookingDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate)) throw new Error('value_date is not a date (YYYY-MM-DD).');
      const line = {
        ordinal: index + 1,
        bookingDate,
        valueDate,
        amountIqd: parseDecimal(amount.replace(/[,\s]/g, ''), 4n),
        reference: cell('reference'),
        counterparty: cell('counterparty'),
        description: cell('description'),
        bankReference: cell('bank_reference'),
      };
      assertLineUsable({ ...line, lineNo: index + 1 });
      lines.push(line);
    } catch (error) {
      rejected.push({ rawText: raw[index] ?? '', problem: error instanceof Error ? error.message : String(error) });
    }
  }
  return { lines, rejected };
}

