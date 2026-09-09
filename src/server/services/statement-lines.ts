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
 * The seeded lines are the layout an install starts from, not one it is stuck
 * with: they rename, regroup, reorder and remove like any other. `isSystem`
 * records where a line came from and grants it no privileges.
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

/**
 * The header a line is to sit under, checked before it is moved there.
 *
 * `moving` is the line being placed, when there is one: a line cannot be put
 * under itself or under anything already beneath it, because a branch that
 * contains itself is a walk that never ends.
 */
async function resolveParent(
  tx: Tx,
  parentId: string | null | undefined,
  statement: StatementFace,
  side: BalanceSide | null,
  moving?: { readonly id: string; readonly name: string },
): Promise<string | null> {
  if (!parentId) return null;

  const [parent] = await tx
    .select()
    .from(financialStatementLine)
    .where(eq(financialStatementLine.id, parentId))
    .limit(1);
  if (!parent || !parent.isHeader) {
    throw new StatementLineError('A line sits under a header. Choose one, or leave it at the top level.');
  }
  if (parent.statement !== statement) {
    throw new StatementLineError(
      `'${parent.name}' is on the ${TITLES[parent.statement as StatementFace]} — a line sits under a header of its own report.`,
    );
  }
  if (statement === 'balance_sheet' && parent.side !== side) {
    throw new StatementLineError(
      `'${parent.name}' is on the ${parent.side} side — a ${side} line cannot sit under it.`,
    );
  }

  // Walk up from the parent: how deep it already is, and whether the line
  // being moved is somewhere above it.
  let depth = 1;
  let cursor = parent;
  while (cursor.parentId) {
    if (moving && cursor.parentId === moving.id) {
      throw new StatementLineError(
        `'${parent.name}' already sits beneath '${moving.name}', so '${moving.name}' cannot be put under it.`,
      );
    }
    depth += 1;
    const [next] = await tx
      .select()
      .from(financialStatementLine)
      .where(eq(financialStatementLine.id, cursor.parentId))
      .limit(1);
    if (!next) break;
    cursor = next;
  }
  if (moving && parent.id === moving.id) {
    throw new StatementLineError(`'${moving.name}' cannot sit under itself.`);
  }

  // What is being moved brings its own lines with it.
  let height = 0;
  if (moving) {
    const below = await tx
      .select({ id: financialStatementLine.id, parentId: financialStatementLine.parentId })
      .from(financialStatementLine)
      .where(eq(financialStatementLine.statement, statement));
    const heightOf = (id: string): number => {
      const children = below.filter((row) => row.parentId === id);
      return children.length === 0 ? 0 : 1 + Math.max(...children.map((child) => heightOf(child.id)));
    };
    height = heightOf(moving.id);
  }
  if (depth + height >= MAX_DEPTH) {
    throw new StatementLineError(`The layout nests at most ${MAX_DEPTH} levels deep.`);
  }

  return parent.id;
}

/** Last among the siblings it is joining. */
async function nextOrdinal(tx: Tx, statement: StatementFace, parentId: string | null): Promise<number> {
  const [last] = await tx
    .select({ max: sql<number>`coalesce(max(${financialStatementLine.ordinal}), 0)::int` })
    .from(financialStatementLine)
    .where(
      and(
        eq(financialStatementLine.statement, statement),
        parentId
          ? eq(financialStatementLine.parentId, parentId)
          : sql`${financialStatementLine.parentId} is null`,
      ),
    );
  return (last?.max ?? 0) + 10;
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateLineInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  if (!(STATEMENT_FACES as readonly string[]).includes(input.statement)) {
    throw new StatementLineError(`'${String(input.statement)}' is not one of the four statements.`);
  }
  const { role, side, cashFlowCategory, isCash } = vocabularyFor(input);

  const parentId = await resolveParent(tx, input.parentId, input.statement, side);

  const code = await uniqueCode(codeFromName(name, 'lower'), async (candidate) => {
    const [row] = await tx
      .select({ code: financialStatementLine.code })
      .from(financialStatementLine)
      .where(eq(financialStatementLine.code, candidate));
    return Boolean(row);
  });

  // Last among its siblings; the person reorders from there.
  const ordinal = await nextOrdinal(tx, input.statement, parentId);

  const [created] = await tx
    .insert(financialStatementLine)
    .values({
      code,
      name,
      statement: input.statement,
      parentId,
      isHeader: input.isHeader,
      ordinal,
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

export interface UpdateLineInput {
  readonly name: string;
  readonly isHeader: boolean;
  /** The header it is to sit under, or null for the top level. */
  readonly parentId?: string | null;
  readonly role?: string | null;
  readonly side?: string | null;
  readonly cashFlowCategory?: string | null;
  readonly isCash?: boolean;
}

/**
 * Everything one line's own dialog can change, in one audited act: its name,
 * whether it is a grouping title or a line accounts map to, the header it
 * sits under, and the one thing its report needs to know about it.
 *
 * The seeded lines are not special here. They are the layout every install
 * starts from, not a layout it is stuck with: rename them, group them under a
 * header of your own, reorder them, remove the ones this company does not
 * use. An account that relied on one as its default falls to the next line of
 * the same kind — see `lineFor` — so nothing is stranded by the change.
 *
 * What is still refused is a change that would break the thing being edited:
 * a line accounts report on cannot become a title, a title with lines beneath
 * it cannot become one of them, and nothing can be moved inside itself.
 */
export async function update(tx: Tx, ctx: ActorContext, id: string, input: UpdateLineInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);
  const statement = line.statement as StatementFace;
  const name = requireText(input.name, 'name');
  const isHeader = input.isHeader;

  if (isHeader !== line.isHeader) {
    if (isHeader) {
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
  }

  const vocabulary = vocabularyFor({
    statement,
    name,
    isHeader,
    role: input.role ?? line.role,
    side: input.side ?? line.side,
    cashFlowCategory: input.cashFlowCategory ?? line.cashFlowCategory,
    isCash: input.isCash ?? false,
  });

  // `parentId` is only acted on when the form sent one, so a caller that does
  // not ask about it leaves the line where it is.
  const asked = input.parentId !== undefined;
  const parentId = asked
    ? await resolveParent(tx, input.parentId, statement, vocabulary.side, { id, name: line.name })
    : line.parentId;
  const moved = asked && parentId !== line.parentId;

  await tx
    .update(financialStatementLine)
    .set({
      name,
      isHeader,
      ...vocabulary,
      parentId,
      // Joining a new set of siblings means joining the end of them.
      ...(moved ? { ordinal: await nextOrdinal(tx, statement, parentId) } : {}),
    })
    .where(eq(financialStatementLine.id, id));

  await recordChange(tx, ctx, {
    action: 'statement_line.updated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: {
      name: line.name,
      isHeader: line.isHeader,
      parentId: line.parentId,
      role: line.role,
      side: line.side,
      cashFlowCategory: line.cashFlowCategory,
      isCash: line.isCash,
    },
    after: { name, isHeader, parentId, ...vocabulary },
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
 * Removes a line nobody is using: a header once it is empty, a line once no
 * account maps to it on any report — the foreign keys from the chart enforce
 * the same from below.
 *
 * Including the seeded ones. They are where an install starts, not what it is
 * stuck with, and an account that had been relying on one as its default
 * falls to the next line of the same kind rather than disappearing.
 */
export async function remove(tx: Tx, ctx: ActorContext, id: string) {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const line = await load(tx, id);

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
