/**
 * Reporting levels — how far a financial report unfolds.
 *
 * By direction (2026-08-29): *"the more I choose a higher reporting level, the
 * more the report will expand — level 1 only the headers, level 2 headers and
 * sub-headers, level 3 headers, sub-headers and accounts."*
 *
 * The Trial Balance unfolds along the chart of accounts itself: level 1 is the
 * five type roots, level 2 the headers under them, and so on down to the
 * posting accounts. The two statements unfold along their own shape — the
 * section, the statement line, the account — which is three levels exactly.
 *
 * Pure, so a page and a test compute the same rows from the same figures.
 */
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';

/** What the roll-up needs to know about every account in the chart. */
export interface ChartRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isGroup: boolean;
  readonly accountType: string;
}

/** A posting account's figures for the period, as the Trial Balance reads them. */
export interface AccountFigures {
  readonly accountCode: string;
  readonly debit: string;
  readonly credit: string;
}

/** One row of a rolled-up report. */
export interface LevelRow {
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  /** 1 for a type root; each step down the chart adds one. */
  readonly depth: number;
  readonly isGroup: boolean;
  readonly debit: string;
  readonly credit: string;
}

const scaled = (value: string): bigint => parseDecimal(value, MONEY_SCALE);
const decimal = (value: bigint): string => toDecimalString(value, MONEY_SCALE);

/**
 * The deepest level the chart offers — the level at which every posting
 * account is on its own row.
 */
export function maxLevel(chart: readonly ChartRow[]): number {
  const byId = new Map(chart.map((row) => [row.id, row]));
  let deepest = 1;
  for (const row of chart) {
    let depth = 1;
    let cursor = row;
    while (cursor.parentId && byId.has(cursor.parentId)) {
      cursor = byId.get(cursor.parentId)!;
      depth += 1;
    }
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

/**
 * Clamps a requested level to what the chart can show. Anything unreadable
 * (a missing parameter, a word, zero) falls to the deepest level, which is
 * the full report — the answer a person who did not ask for a level expects.
 */
export function levelFrom(value: unknown, deepest: number): number {
  const requested = Number(value);
  if (!Number.isInteger(requested) || requested < 1) return deepest;
  return Math.min(requested, deepest);
}

/**
 * Rolls posting-account figures up the chart and returns the rows a report
 * shows at one level.
 *
 * A header's figure is the sum of everything beneath it. Accounts deeper than
 * the chosen level are folded into the nearest ancestor at that level; a
 * posting account sitting shallower than the level is shown as itself. Rows
 * with no movement are left out, as the Trial Balance leaves them out.
 */
export function rollUp(
  chart: readonly ChartRow[],
  figures: readonly AccountFigures[],
  level: number,
): LevelRow[] {
  const byId = new Map(chart.map((row) => [row.id, row]));
  const byCode = new Map(chart.map((row) => [row.code, row]));
  const children = new Map<string | null, ChartRow[]>();
  for (const row of chart) {
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }

  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  const add = (id: string, debit: bigint, credit: bigint) => {
    const bucket = totals.get(id) ?? { debit: 0n, credit: 0n };
    bucket.debit += debit;
    bucket.credit += credit;
    totals.set(id, bucket);
  };

  // Every posting account's movement lands on itself and on each ancestor.
  for (const figure of figures) {
    const account = byCode.get(figure.accountCode);
    if (!account) continue;
    const debit = scaled(figure.debit);
    const credit = scaled(figure.credit);
    let cursor: ChartRow | undefined = account;
    while (cursor) {
      add(cursor.id, debit, credit);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  const rows: LevelRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const siblings = [...(children.get(parentId) ?? [])].sort((a, b) =>
      a.code.localeCompare(b.code, 'en'),
    );
    for (const row of siblings) {
      const total = totals.get(row.id);
      if (!total || (total.debit === 0n && total.credit === 0n)) continue;
      rows.push({
        code: row.code,
        name: row.name,
        accountType: row.accountType,
        depth,
        isGroup: row.isGroup,
        debit: decimal(total.debit),
        credit: decimal(total.credit),
      });
      if (depth < level) walk(row.id, depth + 1);
    }
  };
  walk(null, 1);
  return rows;
}
