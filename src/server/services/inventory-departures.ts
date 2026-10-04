/**
 * Where stock that left a FIFO layer went — IMPROVEMENT-002 (sponsor,
 * 2026-10-04).
 *
 * A landed-cost lock spreads an import's charges over the layers its
 * container receipts created. What is still on hand is restated into its unit
 * cost; the share of the units that had already left follows the business
 * event that took them, and that event's own accounting: a sale to its cost of
 * sales with the sale's dimensions, a project issue through the issue's
 * project-cost path, a write-off to inventory loss, a supplier return to
 * purchase variance or return clearing, a reconciliation or count to
 * inventory adjustment. Never "everything that left is cost of sales".
 *
 * The inventory layer knows movements and layers, not sales, projects or
 * purchasing. So this file is a **registry**: each owning module registers,
 * per movement kind, a handler that answers the questions only it can answer
 * (`src/server/departures/*`, composed by `departures-runtime.ts`). The lock
 * asks; a kind nobody answers for refuses the lock, naming the kind and the
 * document — a guess would post the money somewhere nobody chose.
 *
 * What stays here is what the inventory layer does know: which movements took
 * how much from a layer, net of their reversals; and, for a relocation (a
 * transfer, a move at cost, a container receipt), the layer the same units
 * arrived in — by `cost_layer.origin_layer_id` (0280), which the relocation
 * writes itself, and for older stock by the pairing that came before it.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as posting from './posting';

export class DepartureError extends Error {
  readonly code = 'DEPARTURE_UNRESOLVED';
  constructor(message: string) {
    super(message);
    this.name = 'DepartureError';
  }
}

/** A movement that took units from a layer, as the registry's handlers see it. */
export interface DepartedMovement {
  readonly id: string;
  readonly kind: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly movementDate: string;
  readonly sourceDocumentType: string | null;
  readonly sourceDocumentId: string | null;
  readonly sourceLineId: string | null;
  readonly journalEntryId: string | null;
}

/** §4.2's dimension keys, as a posting line carries them. */
export type DepartureDimensions = Readonly<Record<string, string | null>>;

/** What a destination's hook is told once the lock's journal is posted. */
export interface PostedDeparture {
  /** The `landed_cost_departure` row. */
  readonly departureId: string;
  readonly lockId: string;
  /** What a reader calls the lock: `IMP-BGW-2026-000001/1`. */
  readonly reference: string;
  readonly payableId: string;
  readonly journalEntryId: string;
  /** The lock's date — the day the cost reaches the destination. */
  readonly postedOn: string;
  readonly movement: DepartedMovement;
  readonly quantity: bigint;
  readonly amountIqd: bigint;
}

/**
 * Where the landed cost of departed units is posted: the role, the account
 * and the dimensions the original posting used (so the same validation
 * passes), and, for a module that keeps an analysis beside the ledger, a hook
 * run in the same transaction once the lock's journal is posted.
 */
export interface DepartureDestination {
  readonly role: string;
  readonly accountId: string;
  readonly dimensions: DepartureDimensions;
  readonly afterPosting?: (tx: Tx, ctx: ActorContext, posted: PostedDeparture) => Promise<void>;
}

/** Units of a departure that have since come back into stock, in the layer they came back to. */
export interface FollowedUnits {
  readonly layerId: string;
  readonly quantity: bigint;
}

export interface DepartureHandler {
  /** Where the landed cost of the units this movement took goes. */
  readonly destination?: (tx: Tx, movement: DepartedMovement) => Promise<DepartureDestination>;
  /**
   * Of `quantity` units this movement took from one layer, those that have
   * since come back into stock (a sales return) and the layer each came back
   * to — the cost follows them there rather than leaving with the rest.
   */
  readonly cameBack?: (tx: Tx, movement: DepartedMovement, quantity: bigint) => Promise<readonly FollowedUnits[]>;
  /** The document's own name for a message: "warehouse transfer WT-BGW-2026-000001". */
  readonly label?: (tx: Tx, movement: DepartedMovement) => Promise<string | null>;
  /** For a relocation that arrives later: true while some of its units are still on the way. */
  readonly inTransit?: (tx: Tx, movement: DepartedMovement) => Promise<boolean>;
}

const handlers = new Map<string, DepartureHandler>();

/** Registers (or replaces) the handler for a movement kind. Idempotent. */
export function registerDepartureHandler(kind: string, handler: DepartureHandler): void {
  handlers.set(kind, handler);
}

/** The kinds that have a handler — for a test, or a screen that explains a refusal. */
export function registeredDepartureKinds(): readonly string[] {
  return [...handlers.keys()].sort();
}

/**
 * The movements that move units from one warehouse to another and leave them
 * in a new layer there. Their cost is not a departure: it follows the units.
 */
export const RELOCATION_KINDS: ReadonlySet<string> = new Set(['transfer_issue', 'quarantine_release', 'quarantine_reject']);

export function isRelocation(kind: string): boolean {
  return RELOCATION_KINDS.has(kind);
}

/** How a movement is named in a sentence: its document's number where the owner knows it. */
export async function labelFor(tx: Tx, movement: DepartedMovement): Promise<string> {
  const named = await handlers.get(movement.kind)?.label?.(tx, movement);
  if (named) return named;
  const source = movement.sourceDocumentType
    ? `${movement.sourceDocumentType.replace(/_/g, ' ')} ${movement.sourceDocumentId ?? ''}`.trim()
    : 'no source document';
  return `the ${movement.kind.replace(/_/g, ' ')} of ${movement.movementDate} (${source})`;
}

/**
 * The destination of a departed movement's landed cost. Refuses a kind no
 * module answers for, naming the kind and the document: the lock is refused
 * rather than the money posted where nobody decided it goes.
 */
export async function destinationFor(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  const handler = handlers.get(movement.kind);
  if (!handler?.destination) {
    throw new DepartureError(
      `${movement.itemCode} left ${movement.warehouseCode} by a '${movement.kind}' movement — ${await labelFor(tx, movement)} — ` +
        'and there is no rule for where the landed cost of stock that left that way goes. The lock is refused rather than ' +
        'posting it to cost of sales by default; the movement kind needs its rule first.',
    );
  }
  return handler.destination(tx, movement);
}

/** The units of a departure that came back into stock, by the owning module. */
export async function cameBackFor(tx: Tx, movement: DepartedMovement, quantity: bigint): Promise<readonly FollowedUnits[]> {
  const handler = handlers.get(movement.kind);
  if (!handler?.cameBack) return [];
  const back = await handler.cameBack(tx, movement, quantity);
  const total = back.reduce((sum, row) => sum + row.quantity, 0n);
  if (back.some((row) => row.quantity <= 0n) || total > quantity) {
    throw new DepartureError(
      `More of ${movement.itemCode} came back from ${await labelFor(tx, movement)} than it took from the layer ` +
        `(${formatQuantity(total)} of ${formatQuantity(quantity)}).`,
    );
  }
  return back;
}

// ---------------------------------------------------------------------------
// What left a layer
// ---------------------------------------------------------------------------

interface MovementRow {
  id: string;
  kind: string;
  itemCode: string;
  warehouseCode: string;
  branchCode: string;
  movementDate: string;
  sourceDocumentType: string | null;
  sourceDocumentId: string | null;
  sourceLineId: string | null;
  journalEntryId: string | null;
  quantity: string;
}

const toMovement = (row: MovementRow): DepartedMovement => ({
  id: row.id,
  kind: row.kind,
  itemCode: row.itemCode,
  warehouseCode: row.warehouseCode,
  branchCode: row.branchCode,
  movementDate: row.movementDate,
  sourceDocumentType: row.sourceDocumentType,
  sourceDocumentId: row.sourceDocumentId,
  sourceLineId: row.sourceLineId,
  journalEntryId: row.journalEntryId,
});

/**
 * Every movement that took units from a layer and still holds them, with
 * how many: its consumption less what its reversal put back. A reversal's
 * restoring rows sit on the reversal movement as negative consumptions; they
 * are counted against the movement they reverse, so a sale reversed before a
 * lock takes no share of it.
 */
export async function netDepartures(
  tx: Tx,
  layerId: string,
): Promise<readonly { movement: DepartedMovement; quantity: bigint }[]> {
  const result = await tx.execute(sql`
    with consumed as (
      select case when m.kind = 'reversal' and c.quantity < 0 and m.reverses_movement_id is not null
                  then m.reverses_movement_id else m.id end as movement_id,
             c.quantity
        from cost_layer_consumption c
        join inventory_movement m on m.id = c.movement_id
       where c.layer_id = ${layerId}
    ), net as (
      select movement_id, sum(quantity) as quantity from consumed group by movement_id having sum(quantity) > 0
    )
    select m.id, m.kind::text as kind, m.item_code as "itemCode", m.warehouse_code as "warehouseCode",
           m.branch_code as "branchCode", m.movement_date::text as "movementDate",
           m.source_document_type as "sourceDocumentType", m.source_document_id as "sourceDocumentId",
           m.source_line_id as "sourceLineId", m.journal_entry_id as "journalEntryId",
           net.quantity::text as quantity
      from net join inventory_movement m on m.id = net.movement_id
     order by m.created_at, m.id`);
  return (result.rows as unknown as MovementRow[]).map((row) => ({
    movement: toMovement(row),
    quantity: parseQuantity(row.quantity),
  }));
}

/** One movement, as a departure. */
export async function departedMovement(tx: Tx, movementId: string): Promise<DepartedMovement | null> {
  const result = await tx.execute(sql`
    select m.id, m.kind::text as kind, m.item_code as "itemCode", m.warehouse_code as "warehouseCode",
           m.branch_code as "branchCode", m.movement_date::text as "movementDate",
           m.source_document_type as "sourceDocumentType", m.source_document_id as "sourceDocumentId",
           m.source_line_id as "sourceLineId", m.journal_entry_id as "journalEntryId", m.quantity::text as quantity
      from inventory_movement m where m.id = ${movementId}`);
  const row = (result.rows as unknown as MovementRow[])[0];
  return row ? toMovement(row) : null;
}

/** The layer facts the relocation pairing reads. */
export interface FollowedFrom {
  readonly id: string;
  readonly layerDate: string;
  readonly supplierId: string | null;
}

interface CandidateRow {
  id: string;
  quantity: string;
  layerDate: string;
  supplierId: string | null;
  unitCost: string;
  originLayerId: string | null;
  sameTransaction: boolean;
}

/**
 * The layers a relocation's units from `layer` arrived in, and how many in
 * each.
 *
 * By fact first: the receipt of the same document line whose layer names this
 * one as its origin (0280) — in the same transaction for a move that arrives
 * at once (`inventory.relocate`, a move at cost), later for a warehouse
 * transfer, whose receipts together hold what left. Stock moved before 0280
 * carries no origin, so it is paired as it was before — the receipt of the
 * same document line, item and quantity — and refused when that is ambiguous
 * or finds nothing. Units still on the way refuse the lock: the cost of stock
 * in transit cannot be put anywhere yet.
 */
export async function relocatedTo(
  tx: Tx,
  movement: DepartedMovement,
  layer: FollowedFrom,
  quantity: bigint,
  used: Set<string>,
): Promise<readonly FollowedUnits[]> {
  const result = await tx.execute(sql`
    select cl.id, cl.original_quantity::text as quantity, cl.layer_date::text as "layerDate",
           cl.supplier_id as "supplierId", cl.unit_cost_iqd::text as "unitCost",
           cl.origin_layer_id as "originLayerId", (r.created_at = m.created_at) as "sameTransaction"
      from inventory_movement m
      join inventory_movement r
        on r.item_code = m.item_code
       and r.id <> m.id
       and r.quantity > 0
       and r.kind <> 'reversal'
       and r.source_document_type is not distinct from m.source_document_type
       and r.source_document_id is not distinct from m.source_document_id
       and r.source_line_id is not distinct from m.source_line_id
       and r.created_at >= m.created_at
      join cost_layer cl on cl.created_by_movement_id = r.id
     where m.id = ${movement.id}
       and (cl.origin_layer_id = ${layer.id} or cl.origin_layer_id is null)
     order by r.created_at, cl.layer_date, cl.sequence, cl.id`);
  const rows = (result.rows as unknown as CandidateRow[]).filter((row) => !used.has(row.id));
  const qtyOf = (row: CandidateRow) => parseQuantity(row.quantity);
  const take = (picked: readonly CandidateRow[]): FollowedUnits[] => {
    for (const row of picked) used.add(row.id);
    return picked.map((row) => ({ layerId: row.id, quantity: qtyOf(row) }));
  };

  const linked = rows.filter((row) => row.originLayerId === layer.id);
  if (linked.length > 0) {
    // At once: the one receipt of exactly what left (relocate, move at cost).
    const immediate = linked.filter((row) => row.sameTransaction);
    const exact = immediate.find((row) => qtyOf(row) === quantity);
    if (exact) return take([exact]);
    // Later, or in parts: every receipt of this line from this layer.
    const total = linked.reduce((sum, row) => sum + qtyOf(row), 0n);
    if (total === quantity) return take(linked);
    if (total < quantity) return refuseUnarrived(tx, movement, quantity - total);
    throw new DepartureError(
      `${await labelFor(tx, movement)} took ${formatQuantity(quantity)} of ${movement.itemCode} from one layer, and ` +
        `${formatQuantity(total)} arrived from it — more than left. The lock cannot tell which units carry the cost; ` +
        'the transfer needs correcting first.',
    );
  }

  // Before 0280: the receipt of the same line, item and quantity.
  let pick = rows.filter((row) => row.originLayerId === null && qtyOf(row) === quantity);
  if (pick.some((row) => row.sameTransaction)) pick = pick.filter((row) => row.sameTransaction);
  if (pick.length > 1) {
    const narrowed = pick.filter((row) => row.layerDate === layer.layerDate && row.supplierId === layer.supplierId);
    if (narrowed.length > 0) pick = narrowed;
  }
  if (pick.length > 1) {
    const [first] = pick;
    const twins = pick.every(
      (row) =>
        row.layerDate === first!.layerDate &&
        row.supplierId === first!.supplierId &&
        row.unitCost === first!.unitCost &&
        row.quantity === first!.quantity &&
        row.sameTransaction === first!.sameTransaction,
    );
    if (!twins) {
      throw new DepartureError(
        `${await labelFor(tx, movement)} moved ${formatQuantity(quantity)} of ${movement.itemCode} before the system ` +
          `recorded where moved stock came from, and ${pick.length} layers could be where it arrived. The lock is refused ` +
          'rather than guessing which one carries the landed cost.',
      );
    }
  }
  if (pick.length > 0) return take([pick[0]!]);
  return refuseUnarrived(tx, movement, quantity);
}

async function refuseUnarrived(tx: Tx, movement: DepartedMovement, outstanding: bigint): Promise<never> {
  const label = await labelFor(tx, movement);
  if (await handlers.get(movement.kind)?.inTransit?.(tx, movement)) {
    throw new DepartureError(
      `${formatQuantity(outstanding)} of ${movement.itemCode} left ${movement.warehouseCode} on ${movement.movementDate} ` +
        `with ${label} and is still in transit. Its landed cost belongs to the layer it arrives in: receive ${label} first, ` +
        'then lock the landed cost.',
    );
  }
  throw new DepartureError(
    `${formatQuantity(outstanding)} of ${movement.itemCode} left ${movement.warehouseCode} on ${movement.movementDate} ` +
      `with ${label}, and no layer it arrived in can be found. The lock is refused rather than sending its landed cost ` +
      'to cost of sales.',
  );
}

// ---------------------------------------------------------------------------
// What the handlers share: the original posting, read back
// ---------------------------------------------------------------------------

interface JournalLineRow {
  accountId: string;
  branch: string | null;
  department: string | null;
  businessLine: string | null;
  project: string | null;
  warehouse: string | null;
  businessPartner: string | null;
  employee: string | null;
}

/** A posted journal line's dimensions, as a posting line supplies them. */
export function dimensionsOfLine(row: Omit<JournalLineRow, 'accountId'>): DepartureDimensions {
  const out: Record<string, string | null> = {};
  const set = (key: string, value: string | null) => {
    if (value !== null && value !== '') out[key] = value;
  };
  set('branch', row.branch);
  set('department', row.department);
  set('business_line', row.businessLine);
  set('project', row.project);
  set('warehouse', row.warehouse);
  set('business_partner', row.businessPartner);
  set('employee', row.employee);
  return out;
}

/**
 * The account and dimensions an original journal used for a role — the line
 * of a source line when one is named, else the first of that role (in
 * `warehouse` when one is named and such a line exists). Null when the
 * journal has no such line.
 */
export async function journalLineOf(
  tx: Tx,
  journalEntryId: string,
  role: string,
  options: { readonly sourceLineId?: string | null; readonly warehouseCode?: string | null } = {},
): Promise<{ accountId: string; dimensions: DepartureDimensions } | null> {
  const result = await tx.execute(sql`
    select l.account_id as "accountId", l.branch_code as branch, l.department_code as department,
           l.business_line_code as "businessLine", l.project_code as project, l.warehouse_code as warehouse,
           l.business_partner_code as "businessPartner", l.employee_code as employee
      from journal_line l
     where l.journal_entry_id = ${journalEntryId}
       and l.line_role = ${role}
       ${options.sourceLineId ? sql`and l.source_line_id = ${options.sourceLineId}` : sql``}
     order by (l.warehouse_code is not distinct from ${options.warehouseCode ?? null}) desc, l.line_no
     limit 1`);
  const row = (result.rows as unknown as JournalLineRow[])[0];
  return row ? { accountId: row.accountId, dimensions: dimensionsOfLine(row) } : null;
}

/** The item's own inventory and cost-of-sales accounts (block 1). */
export async function itemAccounts(tx: Tx, itemCode: string): Promise<{ inventory: string | null; cogs: string | null }> {
  const result = await tx.execute(sql`
    select inventory_account_id as inventory, cogs_account_id as cogs from item where code = ${itemCode}`);
  const row = (result.rows as unknown as { inventory: string | null; cogs: string | null }[])[0];
  return { inventory: row?.inventory ?? null, cogs: row?.cogs ?? null };
}

/** The account a posting mapping gives an (event, role) for these criteria, or null when none is mapped. */
export async function mappedAccount(
  tx: Tx,
  eventType: string,
  role: string,
  criteria: { readonly branchCode: string; readonly warehouseCode?: string | null; readonly projectCode?: string | null },
): Promise<string | null> {
  return posting.mappedAccountFor(tx, eventType, role, criteria.branchCode, {
    warehouseCode: criteria.warehouseCode ?? null,
    projectCode: criteria.projectCode ?? null,
  });
}
