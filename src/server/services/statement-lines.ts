/**
 * The Statement Mapping — Finance's own report layout, by direction 2026-09-03.
 *
 * Finance creates the headers and lines of the Income Statement and Balance
 * Sheet, orders them, classifies each line for the Cash Flow Statement, and
 * connects accounts to lines when the accounts are opened. This service is
 * every change the mapping screens can make, each one authorised on the
 * statements' own permission object and written to the audit trail.
 *
 * What Finance cannot do here is make the reports lie: a line always names
 * the role or side it plays, so the subtotals and the two sides of the
 * Balance Sheet keep meaning what they say whatever the layout looks like.
 * The twelve seeded lines carry the type defaults and the subtotal anchors,
 * so they move and rename but never leave.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { chartOfAccount, financialStatementLine } from '../db/schema';
import {
  BALANCE_SIDES,
  INCOME_ROLES,
  LineCatalogue,
  StatementLineError,
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

/** The mapping as the account pickers show it: both statements, in print order. */
export async function pickerLines(tx: Tx) {
  const lines = await catalogue(tx);
  return (['balance_sheet', 'income_statement'] as const).flatMap((statement) =>
    lines.flattened(statement).map(({ line, depth }) => ({
      code: line.code,
      name: line.name,
      statement: line.statement,
      isHeader: line.isHeader,
      depth,
      accountTypes: line.accountTypes,
    })),
  );
}

/** How many accounts report on each line, for the mapping screens. */
export async function accountCounts(tx: Tx): Promise<ReadonlyMap<string, number>> {
  const rows = await tx
    .select({
      line: chartOfAccount.statementLine,
      count: sql<number>`count(*)::int`,
    })
    .from(chartOfAccount)
    .where(sql`${chartOfAccount.statementLine} is not null`)
    .groupBy(chartOfAccount.statementLine);
  return new Map(rows.filter((r) => r.line).map((r) => [r.line!, r.count]));
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
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateLineInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  if (input.statement !== 'income_statement' && input.statement !== 'balance_sheet') {
    throw new StatementLineError(`'${String(input.statement)}' is not a statement.`);
  }

  // The vocabulary the statement requires — see the table's CHECK constraint.
  let role: IncomeRole | null = null;
  let side: BalanceSide | null = null;
  if (input.statement === 'income_statement') {
    if (!input.isHeader) {
      if (!input.role || !(INCOME_ROLES as readonly string[]).includes(input.role)) {
        throw new StatementLineError(
          'An income-statement line names the role it plays — revenue, cost of sales, other income, operating expenses, finance costs or tax — so the subtotals keep computing.',
        );
      }
      role = input.role as IncomeRole;
    }
  } else {
    if (!input.side || !(BALANCE_SIDES as readonly string[]).includes(input.side)) {
      throw new StatementLineError(
        'A balance-sheet line names its side — assets, equity or liabilities — so the statement knows where to print it.',
      );
    }
    side = input.side as BalanceSide;
  }

  // The parent must be a header of the same statement — and on the same side,
  // because a branch of the Balance Sheet lives on one side of it.
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
      throw new StatementLineError('A line sits under a header of its own statement, not the other one.');
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

  // Where the line's movements land on the Cash Flow Statement, until Finance
  // says otherwise on the Cash Flow Mapping screen. Operating is the ordinary
  // assumption for trading; what owners and lenders put in or take out is
  // financing.
  const cashFlowCategory: CashFlowCategory | null = input.isHeader
    ? null
    : role !== null || side === 'asset'
      ? 'operating'
      : 'financing';

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
    })
    .returning();

  await recordChange(tx, ctx, {
    action: 'statement_line.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    after: { code, name, statement: input.statement, isHeader: input.isHeader, role, side, parentId },
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

/** Which Cash Flow section the line's movements land in. */
export async function setCashFlowCategory(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  category: CashFlowCategory,
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  if (line.isHeader) {
    throw new StatementLineError('A header holds no movements of its own — classify its lines.');
  }
  if (line.isCash) {
    throw new StatementLineError(
      'This line IS the cash the statement tracks — cash moving between cash accounts is not a cash flow, so it takes no category.',
    );
  }
  if (line.cashFlowCategory === category) return;

  await tx
    .update(financialStatementLine)
    .set({ cashFlowCategory: category })
    .where(eq(financialStatementLine.id, id));
  await recordChange(tx, ctx, {
    action: 'statement_line.cash_flow_set',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { cashFlowCategory: line.cashFlowCategory },
    after: { cashFlowCategory: category },
  });
}

/**
 * Marks a balance-sheet asset line as cash and equivalents — its accounts
 * become the pool the Cash Flow Statement explains the movement of.
 */
export async function setCash(tx: Tx, ctx: ActorContext, id: string, isCash: boolean) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  if (line.isHeader || line.side !== 'asset') {
    throw new StatementLineError('Only an asset line of the Balance Sheet can hold cash.');
  }
  if (line.isCash === isCash) return;

  await tx
    .update(financialStatementLine)
    // Cash takes no category; a line that stops being cash starts as operating.
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
 * goes only once no account reports on it — the foreign key from the chart
 * enforces the same from below.
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
    .where(eq(chartOfAccount.statementLine, line.code))
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
