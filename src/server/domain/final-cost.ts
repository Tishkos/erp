/**
 * What an import's goods finally cost, and where every dinar of its landed
 * cost went — IMPROVEMENT-002, decidable without a database.
 *
 * Money is a bigint at MONEY_SCALE (1e4), a quantity at QUANTITY_SCALE (1e6),
 * a unit cost is money per one base unit. Every division here is half up
 * (`divideHalfUp`), never a floor: the audit of 2026-10-04 (A11) found the
 * import page's per-unit figures rounding down.
 *
 * Nothing in this file reads a table. `services/final-cost.ts` gathers the
 * facts and asks these functions the arithmetic, so the arithmetic has unit
 * tests of its own (`tests/unit/lc-final-cost.test.ts`).
 */
import { divideHalfUp } from './money';
import { QUANTITY_FACTOR } from './uom';

// ---------------------------------------------------------------------------
// Per unit
// ---------------------------------------------------------------------------

/**
 * `value` (money) over `quantity` (base units): the cost of one unit, half up
 * at the money scale. Zero when there is no quantity to divide by — a model
 * nobody received has no unit cost, not an infinite one.
 */
export function unitOf(value: bigint, quantity: bigint): bigint {
  if (quantity === 0n) return 0n;
  return divideHalfUp(value * QUANTITY_FACTOR, quantity);
}

/**
 * quantity × unit cost, exact: scale 1e10 (QUANTITY × MONEY). Summed exactly
 * and rounded once by `roundExactValue` — the way the Warehouses Report sums
 * `remaining_quantity * unit_cost_iqd` in SQL before it shows the total.
 */
export function exactValue(quantity: bigint, unitCost: bigint): bigint {
  return quantity * unitCost;
}

/** An exact value (scale 1e10) to money, half up. */
export function roundExactValue(exact: bigint): bigint {
  return divideHalfUp(exact, QUANTITY_FACTOR);
}

// ---------------------------------------------------------------------------
// Splitting a whole into parts — the largest remainder
// ---------------------------------------------------------------------------

/**
 * `total` in proportion to `weights`, by the largest remainder (Hamilton).
 *
 * Each part is first the floor of its exact share; the units the floors leave
 * over (fewer than there are parts) go one each to the parts with the largest
 * fractional remainder. That is the same as rounding every share half up and
 * then taking back from — or giving to — the parts nearest the rounding line,
 * so no part is ever more than one unit from its exact share and the parts
 * always add up to the whole. The residue is never piled on the last part
 * (which is what `domain/landed-cost.spreadByWeights` does, and which is right
 * for an allocation the lock posts but wrong for an explanation a person
 * reads: "why does duty get the odd dinar every time?").
 *
 * Ties — equal remainders — go to the earlier part, so the same input always
 * gives the same answer. A part whose weight is zero gets nothing. A negative
 * total is split as its absolute value and negated part by part.
 */
export function splitLargestRemainder(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.some((weight) => weight < 0n)) {
    throw new RangeError('A weight is never negative.');
  }
  const sum = weights.reduce((acc, weight) => acc + weight, 0n);
  if (sum === 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new RangeError('Nothing to split over: every weight is zero.');
  }
  const negative = total < 0n;
  const whole = negative ? -total : total;

  const parts = weights.map((weight) => (whole * weight) / sum);
  const remainders = weights.map((weight, index) => ({ index, remainder: (whole * weight) % sum }));
  let residual = whole - parts.reduce((acc, part) => acc + part, 0n);

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (residual === 0n) break;
    parts[index] = parts[index]! + 1n;
    residual -= 1n;
  }
  return negative ? parts.map((part) => -part) : parts;
}

// ---------------------------------------------------------------------------
// The unit-cost chain
// ---------------------------------------------------------------------------

/**
 * What one *received* unit has cost after each lock: the purchase, then the
 * purchase plus every lock's share up to and including that one, each over
 * the received quantity, half up.
 *
 * Cumulative on the values, not on the rounded steps, so the last link is
 * exactly the final unit cost the import page shows (rounding never
 * accumulates along the chain). It is per *received* unit on purpose: a layer
 * that had already sold out when a lock came keeps its own unit cost (there is
 * nothing left to restate), but the units it received did cost more — the
 * audit's A1.
 */
export function landedUnitChain(
  purchaseValue: bigint,
  receivedQuantity: bigint,
  allocations: readonly bigint[],
): bigint[] {
  const chain = [unitOf(purchaseValue, receivedQuantity)];
  let value = purchaseValue;
  for (const allocated of allocations) {
    value += allocated;
    chain.push(unitOf(value, receivedQuantity));
  }
  return chain;
}

/**
 * 10,050.5 — a money figure for a sentence or a chain: thousands separated,
 * the four places shown only as far as they say something. For reading, never
 * for parsing back.
 */
export function formatAmount(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / 10_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** 10,000 → 10,200 → 10,300 */
export function formatUnitChain(units: readonly bigint[]): string {
  return units.map(formatAmount).join(' → ');
}

// ---------------------------------------------------------------------------
// Where the departed share went
// ---------------------------------------------------------------------------

/** One `landed_cost_departure` row, as far as grouping needs it. */
export interface DepartureLine {
  readonly id: string;
  readonly kind: 'departure' | 'return' | 'rounding';
  /** The movement's kind (`delivery`, `project_issue` …); null on a rounding row. */
  readonly movementKind: string | null;
  readonly destinationRole: string;
  /** Signed: positive on a departure, negative on a return, zero on rounding. */
  readonly quantity: bigint;
  /** Signed like the quantity; a rounding row carries money and no quantity. */
  readonly amountIqd: bigint;
  readonly returnsDepartureId: string | null;
}

export interface DepartureEntry<T extends DepartureLine> {
  /** The departure (or rounding row); null for a return whose departure is not in the set. */
  readonly departure: T | null;
  /** What came back of it, beside it rather than in a group of its own. */
  readonly returns: T[];
}

export interface DepartureGroup<T extends DepartureLine> {
  /** Null for the rounding residue, which no movement took. */
  readonly movementKind: string | null;
  readonly destinationRole: string;
  /** What left, less what came back. */
  readonly quantity: bigint;
  /** Departures and rounding: what the locks sent after the stock. */
  readonly departedIqd: bigint;
  /** What came back with returned units — zero or negative. */
  readonly returnedIqd: bigint;
  /** departedIqd + returnedIqd. */
  readonly netIqd: bigint;
  readonly entries: DepartureEntry<T>[];
}

/**
 * Departures grouped by the transaction that took the stock (movement kind)
 * and where the money was sent (destination role), each return shown beside
 * the departure it undoes and counted in that departure's group. Groups and
 * entries keep the order of `lines` (the caller orders them by date), so the
 * same rows always group the same way.
 */
export function groupDepartures<T extends DepartureLine>(lines: readonly T[]): DepartureGroup<T>[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const groups = new Map<
    string,
    { movementKind: string | null; destinationRole: string; quantity: bigint; departed: bigint; returned: bigint; entries: DepartureEntry<T>[] }
  >();
  const entryOf = new Map<string, DepartureEntry<T>>();

  const groupFor = (line: T) => {
    const key = `${line.movementKind ?? ''}\u0000${line.destinationRole}`;
    let group = groups.get(key);
    if (!group) {
      group = { movementKind: line.movementKind, destinationRole: line.destinationRole, quantity: 0n, departed: 0n, returned: 0n, entries: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const line of lines) {
    if (line.kind === 'return') continue;
    const group = groupFor(line);
    const entry: DepartureEntry<T> = { departure: line, returns: [] };
    group.entries.push(entry);
    group.quantity += line.quantity;
    group.departed += line.amountIqd;
    entryOf.set(line.id, entry);
  }
  for (const line of lines) {
    if (line.kind !== 'return') continue;
    const undone = line.returnsDepartureId ? byId.get(line.returnsDepartureId) : undefined;
    const entry = line.returnsDepartureId ? entryOf.get(line.returnsDepartureId) : undefined;
    const group = groupFor(undone && undone.kind !== 'return' ? undone : line);
    if (entry) {
      entry.returns.push(line);
    } else {
      group.entries.push({ departure: null, returns: [line] });
    }
    group.quantity += line.quantity;
    group.returned += line.amountIqd;
  }

  return [...groups.values()].map((group) => ({
    movementKind: group.movementKind,
    destinationRole: group.destinationRole,
    quantity: group.quantity,
    departedIqd: group.departed,
    returnedIqd: group.returned,
    netIqd: group.departed + group.returned,
    entries: group.entries,
  }));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface LockFigures {
  /** The lock's total — what it credited the clearing account. */
  readonly totalIqd: bigint;
  /** Σ `landed_cost_layer_adjustment.inventory_iqd`: what it restated into stock. */
  readonly inventoryIqd: bigint;
  /** Σ departure rows (kind `departure`). */
  readonly departureIqd: bigint;
  /** Σ rounding rows. */
  readonly roundingIqd: bigint;
}

/**
 * A lock is accounted for when what it put into stock and what it sent after
 * departed stock (rounding included) are its total, to the last 0.0001 — the
 * same rule 0280's deferred `landed_cost_lock_accounted` holds at commit.
 * Returns are later events and are not part of the lock's own sum.
 */
export function reconcileLock(figures: LockFigures) {
  const accountedIqd = figures.inventoryIqd + figures.departureIqd + figures.roundingIqd;
  return {
    accountedIqd,
    differenceIqd: figures.totalIqd - accountedIqd,
    balanced: accountedIqd === figures.totalIqd,
  };
}

export interface ModelFigures {
  readonly purchaseValueIqd: bigint;
  readonly chargesIqd: bigint;
  readonly stockValueIqd: bigint;
  readonly departedIqd: bigint;
  readonly consumedIqd: bigint;
}

/**
 * The per-model identity, and what it leaves unexplained:
 *
 *     purchase + charges = stock + departed + consumed + unexplained
 *
 * (definitions in `services/final-cost.ts`). `unexplained` is zero up to the
 * half-up rounding of valuing each movement on its own (a few 0.0001 per
 * movement); a larger figure means stock left the import's lineage by a path
 * the lineage does not follow.
 */
export function unexplainedOf(figures: ModelFigures): bigint {
  return (
    figures.purchaseValueIqd +
    figures.chargesIqd -
    figures.stockValueIqd -
    figures.departedIqd -
    figures.consumedIqd
  );
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export type LineageLink = 'received' | 'origin_layer' | 'lock_followed' | 'returned' | 'moved';

export interface LineageEdge {
  readonly childId: string;
  readonly parentId: string;
  readonly link: LineageLink;
}

export interface LineageEntry {
  /** The received layer (container receipt) this stock came from. */
  readonly rootId: string;
  /** The layer it came to this one from; null on a received layer. */
  readonly parentId: string | null;
  readonly link: LineageLink;
  readonly depth: number;
}

/**
 * Adds to `lineage` every child of a layer already in it, and answers the
 * layers it added (the next frontier). A layer already placed keeps its place
 * — the first parent found wins and a loop ends — and edges come in a stable
 * order, so the walk is deterministic.
 */
export function extendLineage(lineage: Map<string, LineageEntry>, edges: readonly LineageEdge[]): string[] {
  const added: string[] = [];
  for (const edge of edges) {
    const parent = lineage.get(edge.parentId);
    if (!parent || lineage.has(edge.childId)) continue;
    lineage.set(edge.childId, { rootId: parent.rootId, parentId: edge.parentId, link: edge.link, depth: parent.depth + 1 });
    added.push(edge.childId);
  }
  return added;
}
