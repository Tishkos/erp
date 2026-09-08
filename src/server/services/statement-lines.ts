/**
 * The Statement Mapping — Finance's own report layouts, by direction
 * 2026-09-03.
 *
 * Four reports, four hierarchies: Finance creates the headers and lines of
 * the Income Statement, the Balance Sheet, the Cash Flow Statement and the
 * Statement of Changes in Equity, orders them, and connects accounts to them
 * when the accounts are opened. This service is every change the mapping
 * screens can make, each one authorised on the statements' own permission
 * object and written to the audit trail.
 *
 * What Finance cannot do here is make a report lie about its own arithmetic:
 * an income line always names the role it plays, a balance-sheet line its
 * side, a cash-flow line its activity — so the subtotals, the two halves of
 * the Balance Sheet and the three sections of the Cash Flow Statement keep
 * meaning what they say whatever layout is built on top of them.
 *
 * The seeded lines carry `isSystem`: the type defaults name them, so they
 * move and rename freely but never leave.
 */
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { chartOfAccount, financialStatementLine } from '../db/schema';
import {
  BALANCE_SIDES,
  CASH_FLOW_CATEGORIES,
  INCOME_ROLES,
  LineCatalogue,
  STATEMENT_FACES,
  StatementLineError,
  TITLES,
  type BalanceSide,
  type CashFlowCategory,
  type IncomeRole,
  type StatementFace,
  type StatementLineRow,
} from '../domain/financial-statements';
import { codeFromName, permit, recordChange, requireText, uniqueCode, type ActorContext } from './administration';

export const PERMISSION_OBJECT = 'financial_statement';

/** How deep a layout may nest. Deeper than this stops reading as a statement. */
const MAX_DEPTH = 4;

/** The four mapping columns, by the report each one answers for. */
export const MAPPING_COLUMNS = {
  income_statement: chartOfAccount.incomeStatementLine,
  balance_sheet: chartOfAccount.balanceSheetLine,
  cash_flow: chartOfAccount.cashFlowLine,
  changes_in_equity: chartOfAccount.changesInEquityLine,
} as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every line, as the domain catalogue. Loaded once per request. */
export async function catalogue(tx: Tx): Promise<LineCatalogue> {
  const rows = await tx
    .select()
    .from(financialStatementLine)
    .orderBy(asc(financialStatementLine.ordinal), asc(financialStatementLine.code));
  return new LineCatalogue(rows as StatementLineRow[]);
}

/** The mapping as the account pickers show it: all four reports, in print order. */
export async function pickerLines(tx: Tx) {
  const lines = await catalogue(tx);
  return STATEMENT_FACES.flatMap((statement) =>
    lines.flattened(statement).map(({ line, depth }) => ({
      code: line.code,
      name: line.name,
      statement: line.statement,
      isHeader: line.isHeader,
      depth,
    })),
  );
}

export type MappingLine = Awaited<ReturnType<typeof pickerLines>>[number];

/** How many accounts report on each line, across all four reports. */
export async function accountCounts(tx: Tx): Promise<ReadonlyMap<string, number>> {
  const results = await Promise.all(
    Object.values(MAPPING_COLUMNS).map((column) =>
      tx
        .select({ line: column, count: sql<number>`count(*)::int` })
        .from(chartOfAccount)
        .where(sql`${column} is not null`)
        .groupBy(column),
    ),
  );
  const counts = new Map<string, number>();
  for (const row of results.flat()) {
    if (row.line) counts.set(row.line, (counts.get(row.line) ?? 0) + row.count);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateLineInput {
  readonly statement: StatementFace;
  readonly name: string;
  readonly isHeader: boolean;
  /** A header of the same statement to sit under; top level when null. */
  readonly parentId?: string | null;
  /** Income-statement lines: the role the line plays. Headers carry none. */
  readonly role?: string | null;
  /** Balance-sheet headers and lines: which side of the statement. */
  readonly side?: string | null;
  /** Cash-flow lines: which of the three activities, or the cash itself. */
  readonly cashFlowCategory?: string | null;
  readonly isCash?: boolean;
}

/**
 * The vocabulary one report needs from a new line, checked here so the
 * refusal is a sentence rather than a constraint name.
 */
function vocabularyFor(input: CreateLineInput): {
  role: IncomeRole | null;
  side: BalanceSide | null;
  cashFlowCategory: CashFlowCategory | null;
  isCash: boolean;
} {
  const blank = { role: null, side: null, cashFlowCategory: null, isCash: false } as const;

  switch (input.statement) {
    case 'income_statement': {
      // A header holds the sum of its lines, and each of those names its own
      // role — so the header needs none.
      if (input.isHeader) return { ...blank };
      if (!input.role || !(INCOME_ROLES as readonly string[]).includes(input.role)) {
        throw new StatementLineError(
          'An Income Statement line names the role it plays — revenue, cost of sales, other income, operating expenses, finance costs or tax — so the subtotals keep computing.',
        );
      }
      return { ...blank, role: input.role as IncomeRole };
    }
    case 'balance_sheet': {
      // Headers too: a branch of the Balance Sheet lives on one side of it.
      if (!input.side || !(BALANCE_SIDES as readonly string[]).includes(input.side)) {
        throw new StatementLineError(
          'A Balance Sheet line names its side — assets, equity or liabilities — so the statement knows where to print it.',
        );
      }
      return { ...blank, side: input.side as BalanceSide };
    }
    case 'cash_flow': {
      if (input.isHeader) return { ...blank };
      if (input.isCash) return { ...blank, isCash: true };
      if (
        !input.cashFlowCategory ||
        !(CASH_FLOW_CATEGORIES as readonly string[]).includes(input.cashFlowCategory)
      ) {
        throw new StatementLineError(
          'A Cash Flow line is either the cash the statement explains, or one of its three activities — operating, investing or financing.',
        );
      }
      return { ...blank, cashFlowCategory: input.cashFlowCategory as CashFlowCategory };
    }
    case 'changes_in_equity':
      return { ...blank };
    default:
      throw new StatementLineError(`'${String(input.statement)}' is not one of the four statements.`);
  }
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateLineInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  if (!(STATEMENT_FACES as readonly string[]).includes(input.statement)) {
    throw new StatementLineError(`'${String(input.statement)}' is not one of the four statements.`);
  }
  const { role, side, cashFlowCategory, isCash } = vocabularyFor(input);

  // The parent must be a header of the same statement — and, on the Balance
  // Sheet, of the same side, because a branch lives on one side of it.
  let parentId: string | null = null;
  if (input.parentId) {
    const [parent] = await tx
      .select()
      .from(financialStatementLine)
      .where(eq(financialStatementLine.id, input.parentId))
      .limit(1);
    if (!parent || !parent.isHeader) {
      throw new StatementLineError('The parent of a line is a header of the same statement.');
    }
    if (parent.statement !== input.statement) {
      throw new StatementLineError(
        `'${parent.name}' is on the ${TITLES[parent.statement as StatementFace]} — a line sits under a header of its own report.`,
      );
    }
    if (input.statement === 'balance_sheet' && parent.side !== side) {
      throw new StatementLineError(
        `'${parent.name}' is on the ${parent.side} side — a ${side} line cannot sit under it.`,
      );
    }
    let depth = 1;
    let cursor = parent;
    while (cursor.parentId) {
      depth += 1;
      const [next] = await tx
        .select()
        .from(financialStatementLine)
        .where(eq(financialStatementLine.id, cursor.parentId))
        .limit(1);
      if (!next) break;
      cursor = next;
    }
    if (depth >= MAX_DEPTH) {
      throw new StatementLineError(`The layout nests at most ${MAX_DEPTH} levels deep.`);
    }
    parentId = parent.id;
  }

  const code = await uniqueCode(codeFromName(name, 'lower'), async (candidate) => {
    const [row] = await tx
      .select({ code: financialStatementLine.code })
      .from(financialStatementLine)
      .where(eq(financialStatementLine.code, candidate));
    return Boolean(row);
  });

  // Last among its siblings; the person reorders from there.
  const [last] = await tx
    .select({ max: sql<number>`coalesce(max(${financialStatementLine.ordinal}), 0)::int` })
    .from(financialStatementLine)
    .where(
      and(
        eq(financialStatementLine.statement, input.statement),
        parentId
          ? eq(financialStatementLine.parentId, parentId)
          : sql`${financialStatementLine.parentId} is null`,
      ),
    );

  const [created] = await tx
    .insert(financialStatementLine)
    .values({
      code,
      name,
      statement: input.statement,
      parentId,
      isHeader: input.isHeader,
      ordinal: (last?.max ?? 0) + 10,
      role,
      side,
      cashFlowCategory,
      isCash,
    })
    .returning();

  await recordChange(tx, ctx, {
    action: 'statement_line.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    after: {
      code,
      name,
      statement: input.statement,
      isHeader: input.isHeader,
      role,
      side,
      cashFlowCategory,
      isCash,
      parentId,
    },
  });

  return created!;
}

async function load(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(financialStatementLine)
    .where(eq(financialStatementLine.id, id))
    .limit(1);
  if (!row) throw new StatementLineError('That statement line no longer exists.');
  return row;
}

export async function rename(tx: Tx, ctx: ActorContext, id: string, name: string) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  const next = requireText(name, 'name');
  if (next === line.name) return;

  await tx.update(financialStatementLine).set({ name: next }).where(eq(financialStatementLine.id, id));
  await recordChange(tx, ctx, {
    action: 'statement_line.renamed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { name: line.name },
    after: { name: next },
  });
}

/**
 * Swaps the line with its neighbour above or below, among the siblings it is
 * printed with — same statement, same parent and, at the top of the Balance
 * Sheet, the same side.
 */
export async function move(tx: Tx, ctx: ActorContext, id: string, direction: 'up' | 'down') {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);

  const siblings = (
    await tx
      .select()
      .from(financialStatementLine)
      .where(
        and(
          eq(financialStatementLine.statement, line.statement),
          line.parentId
            ? eq(financialStatementLine.parentId, line.parentId)
            : sql`${financialStatementLine.parentId} is null`,
        ),
      )
      .orderBy(asc(financialStatementLine.ordinal), asc(financialStatementLine.code))
  ).filter((row) => line.parentId !== null || line.statement !== 'balance_sheet' || row.side === line.side);

  const index = siblings.findIndex((row) => row.id === id);
  const other = direction === 'up' ? siblings[index - 1] : siblings[index + 1];
  if (!other) return; // Already at the edge; nothing to swap with.

  await tx
    .update(financialStatementLine)
    .set({ ordinal: other.ordinal })
    .where(eq(financialStatementLine.id, line.id));
  await tx
    .update(financialStatementLine)
    .set({ ordinal: line.ordinal })
    .where(eq(financialStatementLine.id, other.id));

  await recordChange(tx, ctx, {
    action: 'statement_line.moved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { ordinal: line.ordinal },
    after: { ordinal: other.ordinal, swappedWith: other.code },
  });
}

/**
 * Turns a header into a line, or a line into a header.
 *
 * The two are not interchangeable — a header is a grouping title that prints
 * the sum of what sits under it, a line is what accounts are mapped to — and
 * choosing the wrong one when the line was created used to mean deleting it
 * and typing it again. It is one change now, because getting it wrong is easy
 * and should not be expensive.
 */
export async function setKind(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { readonly isHeader: boolean; readonly role?: string | null; readonly cashFlowCategory?: string | null },
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  const statement = line.statement as StatementFace;

  if (line.isSystem) {
    throw new StatementLineError(
      `'${line.name}' is a system line — the type defaults name it, so it stays a line. Add your own beside it.`,
    );
  }
  if (line.isHeader === input.isHeader) return;

  if (input.isHeader) {
    // A line with accounts on it cannot become a title: they would have
    // nowhere to report.
    const [account] = await tx
      .select({ code: chartOfAccount.code })
      .from(chartOfAccount)
      .where(or(...Object.values(MAPPING_COLUMNS).map((column) => eq(column, line.code))))
      .limit(1);
    if (account) {
      throw new StatementLineError(
        `Account ${account.code} reports on '${line.name}', so it cannot become a header. Move the account to another line first.`,
      );
    }
  } else {
    // A header with lines under it cannot become one of them.
    const [child] = await tx
      .select({ id: financialStatementLine.id })
      .from(financialStatementLine)
      .where(eq(financialStatementLine.parentId, id))
      .limit(1);
    if (child) {
      throw new StatementLineError(
        `'${line.name}' still has lines beneath it, so it is a header. Move or remove those first.`,
      );
    }
  }

  // Becoming a line means taking on the vocabulary its report needs; becoming
  // a header means giving it up, because a title carries no figure of its own.
  const vocabulary = input.isHeader
    ? { role: null, cashFlowCategory: null, isCash: false }
    : vocabularyFor({
        statement,
        name: line.name,
        isHeader: false,
        role: input.role ?? line.role,
        side: line.side,
        cashFlowCategory: input.cashFlowCategory ?? line.cashFlowCategory,
        isCash: false,
      });

  await tx
    .update(financialStatementLine)
    .set({
      isHeader: input.isHeader,
      role: vocabulary.role,
      cashFlowCategory: vocabulary.cashFlowCategory,
      isCash: vocabulary.isCash,
    })
    .where(eq(financialStatementLine.id, id));

  await recordChange(tx, ctx, {
    action: 'statement_line.kind_set',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { isHeader: line.isHeader, role: line.role, cashFlowCategory: line.cashFlowCategory },
    after: { isHeader: input.isHeader, ...vocabulary },
  });
}

/** Which of the three activities a Cash Flow line belongs to. */
export async function setCashFlowCategory(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  category: CashFlowCategory,
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  if (line.statement !== 'cash_flow') {
    throw new StatementLineError(
      `'${line.name}' is a line of the ${TITLES[line.statement as StatementFace]}; the three activities belong to the Cash Flow Statement.`,
    );
  }
  if (line.isHeader) {
    throw new StatementLineError('A header holds no movements of its own — classify its lines.');
  }
  if (!(CASH_FLOW_CATEGORIES as readonly string[]).includes(category)) {
    throw new StatementLineError(`'${String(category)}' is not one of the three activities.`);
  }
  if (line.cashFlowCategory === category && !line.isCash) return;

  await tx
    .update(financialStatementLine)
    // A line that carries an activity is no longer the cash itself.
    .set({ cashFlowCategory: category, isCash: false })
    .where(eq(financialStatementLine.id, id));
  await recordChange(tx, ctx, {
    action: 'statement_line.cash_flow_set',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { cashFlowCategory: line.cashFlowCategory, isCash: line.isCash },
    after: { cashFlowCategory: category, isCash: false },
  });
}

/**
 * Marks a Cash Flow line as the cash itself — the accounts mapped to it are
 * the pool whose movement the statement explains, so it carries no activity
 * of its own: cash moving between two cash accounts is not a cash flow.
 */
export async function setCash(tx: Tx, ctx: ActorContext, id: string, isCash: boolean) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  if (line.statement !== 'cash_flow' || line.isHeader) {
    throw new StatementLineError('Only a line of the Cash Flow Statement can hold the cash it explains.');
  }
  if (line.isCash === isCash) return;

  await tx
    .update(financialStatementLine)
    // Cash carries no activity; a line that stops being cash starts as operating.
    .set({ isCash, cashFlowCategory: isCash ? null : 'operating' })
    .where(eq(financialStatementLine.id, id));
  await recordChange(tx, ctx, {
    action: 'statement_line.cash_set',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { isCash: line.isCash },
    after: { isCash },
  });
}

/**
 * Removes a line nobody uses. The seeded lines never go (they anchor the type
 * defaults and the subtotals); a header goes only once it is empty; a line
 * goes only once no account maps to it on any report — the foreign keys from
 * the chart enforce the same from below.
 */
export async function remove(tx: Tx, ctx: ActorContext, id: string) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);

  if (line.isSystem) {
    throw new StatementLineError(
      `'${line.name}' is a system line — it anchors the type defaults and the subtotals. Rename or move it instead.`,
    );
  }

  const [child] = await tx
    .select({ id: financialStatementLine.id })
    .from(financialStatementLine)
    .where(eq(financialStatementLine.parentId, id))
    .limit(1);
  if (child) {
    throw new StatementLineError(`'${line.name}' still has lines beneath it — remove or move those first.`);
  }

  const [account] = await tx
    .select({ code: chartOfAccount.code })
    .from(chartOfAccount)
    .where(or(...Object.values(MAPPING_COLUMNS).map((column) => eq(column, line.code))))
    .limit(1);
  if (account) {
    throw new StatementLineError(
      `Account ${account.code} still reports on '${line.name}' — move it to another line first.`,
    );
  }

  await tx.delete(financialStatementLine).where(eq(financialStatementLine.id, id));
  await recordChange(tx, ctx, {
    action: 'statement_line.removed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { code: line.code, name: line.name, statement: line.statement },
  });
}
