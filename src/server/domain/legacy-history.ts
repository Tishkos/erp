/**
 * The old system's history on a partner's statement (2026-10-14, by direction:
 * "the customer not created with their own statements … suppliers we bought
 * things from them").
 *
 * The legacy import kept every old sale line, purchase line, receipt and
 * payment as `legacy_document` (REQ-LEGACY-001). The opening journal carries
 * the old balance; these lines are history beside it and are never posted
 * (the balances already carry the position). This module turns the lines into
 * a statement's rows — one per old document — with no database.
 *
 * Which column a line takes is the same on both sides, as on a ledger: a sale
 * and a payment we made are Debit, a receipt and a purchase are Credit. The
 * side only decides which way the net is read — a customer's Debit less
 * Credit, a supplier's Credit less Debit — exactly as the statement above it.
 *
 * The old system's sales export carries no date, so a sale has none; dated
 * documents come first, in date order, and the undated ones after them in
 * the old list's own order. The lines need not add up to the opening balance:
 * the old system's balance holds entries this export does not have.
 */
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';

export type LegacyHistoryKind = 'sale' | 'purchase' | 'receipt' | 'payment';

export interface LegacyHistoryLine {
  readonly kind: LegacyHistoryKind;
  readonly legacyNo: string;
  readonly lineNo: number;
  readonly documentDate: string | null;
  readonly itemName: string | null;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
}

export interface LegacyHistoryItem {
  readonly name: string;
  readonly quantity: string | null;
  readonly unit: string | null;
}

export interface LegacyHistoryRow {
  readonly kind: LegacyHistoryKind;
  readonly legacyNo: string;
  readonly date: string | null;
  /** The goods on a sale or a purchase, in the old list's order. */
  readonly items: readonly LegacyHistoryItem[];
  readonly debit: string;
  readonly credit: string;
}

export interface LegacyHistory {
  readonly currency: string;
  readonly rows: readonly LegacyHistoryRow[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** Debit less Credit for a customer, Credit less Debit for a supplier. */
  readonly net: string;
  /** Documents in each other currency, so the screen can offer that statement. */
  readonly elsewhere: Readonly<Record<string, number>>;
}

const DEBIT_KINDS: ReadonlySet<LegacyHistoryKind> = new Set(['sale', 'payment']);

/** The old system writes 1,017 for voucher 1017; order by the number it means. */
function numberOf(legacyNo: string): number {
  const digits = legacyNo.replace(/[^0-9]/g, '');
  return digits ? Number(digits) : Number.MAX_SAFE_INTEGER;
}

function amountOf(line: LegacyHistoryLine): bigint {
  if (!line.amount) return 0n;
  try {
    return parseDecimal(line.amount, MONEY_SCALE);
  } catch {
    return 0n;
  }
}

/** A line with no currency was written in dinars: the old books' own. */
export function currencyOfLine(line: Pick<LegacyHistoryLine, 'currency'>): string {
  return (line.currency ?? '').trim().toUpperCase() || 'IQD';
}

export function historyFor(
  lines: readonly LegacyHistoryLine[],
  side: 'customer' | 'supplier',
  currency: string,
): LegacyHistory {
  const elsewhere: Record<string, Set<string>> = {};
  const groups = new Map<
    string,
    { kind: LegacyHistoryKind; legacyNo: string; date: string | null; items: (LegacyHistoryItem & { lineNo: number })[]; amount: bigint }
  >();

  for (const line of lines) {
    const lineCurrency = currencyOfLine(line);
    const key = `${line.kind}|${line.legacyNo}`;
    if (lineCurrency !== currency) {
      (elsewhere[lineCurrency] ??= new Set()).add(key);
      continue;
    }
    const group = groups.get(key) ?? { kind: line.kind, legacyNo: line.legacyNo, date: null, items: [], amount: 0n };
    group.amount += amountOf(line);
    group.date ??= line.documentDate;
    if (line.itemName) group.items.push({ name: line.itemName, quantity: line.quantity, unit: line.unit, lineNo: line.lineNo });
    groups.set(key, group);
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : numberOf(a.legacyNo) - numberOf(b.legacyNo);
    if (a.date) return -1;
    if (b.date) return 1;
    return numberOf(a.legacyNo) - numberOf(b.legacyNo) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
  });

  let totalDebit = 0n;
  let totalCredit = 0n;
  const rows = ordered.map((group): LegacyHistoryRow => {
    const debit = DEBIT_KINDS.has(group.kind) ? group.amount : 0n;
    const credit = DEBIT_KINDS.has(group.kind) ? 0n : group.amount;
    totalDebit += debit;
    totalCredit += credit;
    const items = [...group.items]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(({ name, quantity, unit }) => ({ name, quantity, unit }));
    return {
      kind: group.kind,
      legacyNo: group.legacyNo,
      date: group.date,
      items,
      debit: toDecimalString(debit),
      credit: toDecimalString(credit),
    };
  });

  return {
    currency,
    rows,
    totalDebit: toDecimalString(totalDebit),
    totalCredit: toDecimalString(totalCredit),
    net: toDecimalString(side === 'customer' ? totalDebit - totalCredit : totalCredit - totalDebit),
    elsewhere: Object.fromEntries(Object.entries(elsewhere).map(([code, keys]) => [code, keys.size])),
  };
}
