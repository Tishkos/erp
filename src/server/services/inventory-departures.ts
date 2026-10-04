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
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { valueOf } from '../domain/landed-cost';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
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
  /** True when the receiver was settled before the cost reached it: the row says so, and the module supplements the settlement in `afterPosting`. */
  readonly postSettlement?: boolean;
  readonly afterPosting?: (tx: Tx, ctx: ActorContext, posted: PostedDeparture) => Promise<void>;
}

/** Units of a departure that have since come back into stock, in the layer they came back to. */
export interface FollowedUnits {
  readonly layerId: string;
  readonly quantity: bigint;
}

/** What a handler is told when landed cost comes back from its destination with returned units. */
export interface ReturnedDeparture {
  /** The `return` row written. */
  readonly returnId: string;
  /** The departure it undoes, and its lock. */
  readonly departureId: string;
  readonly lockId: string;
  readonly payableId: string;
  readonly journalEntryId: string;
  readonly postedOn: string;
  /** The movement that took the units out. */
  readonly movement: DepartedMovement;
  /** The movement that brought them back. */
  readonly returnMovement: DepartedMovement;
  readonly quantity: bigint;
  /** Positive: what came back to inventory from the destination. */
  readonly amountIqd: bigint;
}

export interface DepartureHandler {
  /** Where the landed cost of the units this movement took goes. */
  readonly destination?: (tx: Tx, movement: DepartedMovement) => Promise<DepartureDestination>;
  /**
   * Units this movement took have come back after a lock, and their landed
   * cost with them (`returnLandedShare`): for a module that keeps an analysis
   * beside the ledger (a project's cost rows), the negative row.
   */
  readonly returned?: (tx: Tx, ctx: ActorContext, returned: ReturnedDeparture) => Promise<void>;
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

// ---------------------------------------------------------------------------
// Stock that comes back after a lock brings its landed share back
// ---------------------------------------------------------------------------

/** Units of a departed movement that are in stock again. */
export interface ReturnedUnits {
  /** The movement that took them out — the one the departure rows name. */
  readonly departedMovementId: string;
  /**
   * The layer they left, when the caller knows it (a reversal restores the
   * exact layers). Left out, the units are spread over the layers the movement
   * drew from, in proportion to what it took from each.
   */
  readonly fromLayerId?: string | null;
  readonly quantity: bigint;
  /** The layer they are in now. */
  readonly toLayerId: string;
  /**
   * For units put back onto a layer that already carries the restated cost (a
   * reversal): exactly what the layer's value rose beyond what the caller's own
   * journal put back, which caps the return so the layers and the ledger stay
   * one figure. Left out, the units are in a layer made at the pre-lock cost (a
   * sales return, a project return), and that layer's unit cost is raised by
   * the share instead.
   */
  readonly inventoryIqd?: bigint;
}

export interface ReturnLandedShareInput {
  /** The movement that brought the units back. */
  readonly returnMovementId: string;
  readonly units: readonly ReturnedUnits[];
  /** The day it happens — the day the caller's own journal posts. */
  readonly postingDate: string;
  readonly description: string;
}

interface DepartureRow {
  id: string;
  lockId: string;
  payableId: string;
  sequence: number;
  costLayerId: string;
  movementId: string;
  quantity: string;
  amountIqd: string;
  destinationRole: string;
  accountId: string;
  dimensions: Record<string, string | null>;
  returnedQuantity: string;
  returnedAmount: string;
}

interface Share {
  readonly row: DepartureRow;
  readonly quantity: bigint;
  amountIqd: bigint;
  readonly unit: ReturnedUnits;
}

const money = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);
const showMoney = (value: bigint) => toDecimalString(value, MONEY_SCALE);

/**
 * Stock that left before a lock and has come back — a sale reversed, a sales
 * return accepted, project material returned — brings its landed share back
 * with it (sponsor, 2026-10-04): Dr the item's inventory account in the
 * warehouse the units stand in / Cr the account and dimensions each departure
 * was posted to, dated the day the units came back, and one negative `return`
 * row per departure it undoes, so a lock's story stays whole and a second
 * return can never take back more than left (0285's trigger holds that too).
 *
 * The share is pro rata to the departure's units still out, the last unit
 * taking the remainder; never more than the departure has left. A layer made
 * at the pre-lock cost is raised by the share per unit, so its value is what
 * the ledger holds for it; a layer that already carries the restated cost takes
 * exactly what its value rose beyond the caller's own journal. Nothing to give
 * back (no lock reached the units) does nothing.
 */
export async function returnLandedShare(
  tx: Tx,
  ctx: ActorContext,
  input: ReturnLandedShareInput,
): Promise<{ journalEntryId: string | null; amountIqd: bigint; rows: number }> {
  const nothing = { journalEntryId: null, amountIqd: 0n, rows: 0 };
  const units = input.units.filter((unit) => unit.quantity > 0n);
  if (units.length === 0) return nothing;

  const movementIds = [...new Set(units.map((unit) => unit.departedMovementId))];
  const readDepartures = async () => {
    const result = await tx.execute(sql`
      select d.id, d.lock_id as "lockId", d.payable_id as "payableId", k.sequence, d.cost_layer_id as "costLayerId",
             d.movement_id as "movementId", d.quantity::text as quantity, d.amount_iqd::text as "amountIqd",
             d.destination_role as "destinationRole", d.account_id as "accountId", d.dimensions,
             coalesce((select sum(-r.quantity) from landed_cost_departure r where r.returns_departure_id = d.id), 0)::text as "returnedQuantity",
             coalesce((select sum(-r.amount_iqd) from landed_cost_departure r where r.returns_departure_id = d.id), 0)::text as "returnedAmount"
        from landed_cost_departure d
        join landed_cost_lock k on k.id = d.lock_id
       where d.kind = 'departure'
         and d.movement_id in (${sql.join(movementIds.map((id) => sql`${id}::uuid`), sql`, `)})
       order by d.cost_layer_id, k.sequence, d.id`);
    return result.rows as unknown as DepartureRow[];
  };
  if ((await readDepartures()).length === 0) return nothing;
  // Serialised on the layers (the departure rows are append-only, so they
  // cannot be locked): two returns against the same departure take turns on
  // the layer it left, and each reads what the other left — the same rows
  // `inventory.issue` locks, in one order.
  const toLayerIds = [...new Set(units.map((unit) => unit.toLayerId))];
  const layerIds = [...new Set([...(await readDepartures()).map((row) => row.costLayerId), ...toLayerIds])].sort();
  await tx.execute(sql`
    select id from cost_layer where id in (${sql.join(layerIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`);
  const departures = await readDepartures();

  const returnMovement = await departedMovement(tx, input.returnMovementId);
  if (!returnMovement) throw new DepartureError(`No inventory movement '${input.returnMovementId}'.`);

  // What the movement took from each layer: the weights for units whose layer
  // the caller does not know.
  const consumed = new Map<string, Map<string, bigint>>();
  for (const movementId of movementIds) {
    const taken = await tx.execute(sql`
      select c.layer_id as "layerId", sum(c.quantity)::text as quantity
        from cost_layer_consumption c
       where c.movement_id = ${movementId}::uuid and c.quantity > 0
       group by c.layer_id`);
    consumed.set(
      movementId,
      new Map((taken.rows as { layerId: string; quantity: string }[]).map((row) => [row.layerId, parseQuantity(row.quantity)])),
    );
  }

  const shares: Share[] = [];
  for (const unit of units) {
    const mine = departures.filter((row) => row.movementId === unit.departedMovementId);
    if (mine.length === 0) continue;
    // Per layer: the rows (one per lock) and what each has left.
    const byLayer = new Map<string, DepartureRow[]>();
    for (const row of mine) byLayer.set(row.costLayerId, [...(byLayer.get(row.costLayerId) ?? []), row]);
    const leftOf = (rows: readonly DepartureRow[]) =>
      rows.reduce((min, row) => {
        const left = parseQuantity(row.quantity) - parseQuantity(row.returnedQuantity);
        return min === null || left < min ? left : min;
      }, null as bigint | null) ?? 0n;

    let perLayer: [string, bigint][];
    if (unit.fromLayerId) {
      const rows = byLayer.get(unit.fromLayerId);
      if (!rows) continue;
      const left = leftOf(rows);
      perLayer = [[unit.fromLayerId, unit.quantity < left ? unit.quantity : left]];
    } else {
      const weights = consumed.get(unit.departedMovementId) ?? new Map<string, bigint>();
      const layers = [...weights.entries()].filter(([, quantity]) => quantity > 0n);
      const total = layers.reduce((sum, [, quantity]) => sum + quantity, 0n);
      if (total <= 0n) continue;
      let given = 0n;
      perLayer = layers.map(([layerId, weight], index) => {
        const part = index === layers.length - 1 ? unit.quantity - given : (unit.quantity * weight) / total;
        given += part;
        const rows = byLayer.get(layerId);
        if (!rows) return [layerId, 0n];
        const left = leftOf(rows);
        return [layerId, part < left ? part : left];
      });
    }
    for (const [layerId, quantity] of perLayer) {
      if (quantity <= 0n) continue;
      for (const row of byLayer.get(layerId) ?? []) {
        const leftQuantity = parseQuantity(row.quantity) - parseQuantity(row.returnedQuantity);
        const leftAmount = money(row.amountIqd) - money(row.returnedAmount);
        if (leftQuantity <= 0n || leftAmount < 0n) continue;
        const amountIqd = quantity >= leftQuantity ? leftAmount : (leftAmount * quantity) / leftQuantity;
        shares.push({ row, quantity, amountIqd, unit });
      }
    }
  }
  if (shares.length === 0) return nothing;

  // The layers the units are in now, and how much each takes back: a new layer
  // is raised by the share per unit (the ledger then holds exactly its value);
  // a restored layer takes what its value rose, never more than the shares.
  const layerRows = await tx.execute(sql`
    select cl.id, cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode", cl.branch_code as "branchCode",
           cl.original_quantity::text as "originalQuantity", cl.remaining_quantity::text as "remainingQuantity",
           cl.unit_cost_iqd::text as "unitCost"
      from cost_layer cl
     where cl.id in (${sql.join(toLayerIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const toLayers = new Map(
    (layerRows.rows as unknown as {
      id: string; itemCode: string; warehouseCode: string; branchCode: string;
      originalQuantity: string; remainingQuantity: string; unitCost: string;
    }[]).map((row) => [row.id, row]),
  );

  const trim = (mine: Share[], cap: bigint) => {
    let excess = mine.reduce((sum, share) => sum + share.amountIqd, 0n) - cap;
    for (let index = mine.length - 1; index >= 0 && excess > 0n; index -= 1) {
      const cut = mine[index]!.amountIqd < excess ? mine[index]!.amountIqd : excess;
      mine[index]!.amountIqd -= cut;
      excess -= cut;
    }
  };
  const restated: { id: string; unitCost: bigint }[] = [];
  for (const toLayerId of toLayerIds) {
    const layer = toLayers.get(toLayerId);
    if (!layer) throw new DepartureError(`No cost layer '${toLayerId}'.`);
    const mine = shares.filter((share) => share.unit.toLayerId === toLayerId);
    const asked = mine.reduce((sum, share) => sum + share.amountIqd, 0n);
    if (mine.some((share) => share.unit.inventoryIqd !== undefined)) {
      // Each unit entry's cap is counted once, not once per lock row.
      const caps = new Map<ReturnedUnits, bigint>();
      for (const share of mine) caps.set(share.unit, share.unit.inventoryIqd ?? 0n);
      const cap = [...caps.values()].reduce((sum, value) => sum + (value > 0n ? value : 0n), 0n);
      if (cap < asked) trim(mine, cap);
    } else if (asked > 0n) {
      const quantity = parseQuantity(layer.originalQuantity);
      const unitCost = money(layer.unitCost);
      const raw = asked * 1_000_000n;
      let delta = raw / quantity;
      if ((raw % quantity) * 2n >= quantity) delta += 1n;
      const before = valueOf(quantity, unitCost);
      let rise = valueOf(quantity, unitCost + delta) - before;
      while (rise > asked && delta > 0n) {
        delta -= 1n;
        rise = valueOf(quantity, unitCost + delta) - before;
      }
      if (rise < asked) trim(mine, rise);
      if (delta > 0n) restated.push({ id: layer.id, unitCost: unitCost + delta });
    }
  }
  const total = shares.reduce((sum, share) => sum + share.amountIqd, 0n);
  if (total <= 0n) return nothing;

  // One branch per journal: the units came back where they left.
  const branchCode = returnMovement.branchCode;
  for (const share of shares) {
    const branch = share.row.dimensions.branch;
    if (branch && branch !== branchCode) {
      throw new DepartureError(
        `${returnMovement.itemCode} came back in branch ${branchCode}, and its landed cost was posted in branch ${branch} ` +
          `(lock ${share.row.sequence}); a journal posts in one branch, so the units have to come back to a warehouse of ${branch}.`,
      );
    }
  }

  const stockLines = new Map<string, { accountId: string; warehouseCode: string; amount: bigint }>();
  const creditLines = new Map<string, { role: string; accountId: string; dimensions: Record<string, string>; amount: bigint }>();
  const clean = (dimensions: Record<string, string | null>) => {
    const out: Record<string, string> = {};
    for (const key of Object.keys(dimensions).sort()) {
      const value = dimensions[key];
      if (value !== null && value !== undefined && value !== '') out[key] = value;
    }
    return out;
  };
  for (const share of shares) {
    if (share.amountIqd <= 0n) continue;
    const layer = toLayers.get(share.unit.toLayerId)!;
    const accounts = await itemAccounts(tx, layer.itemCode);
    if (!accounts.inventory) {
      throw new DepartureError(`Item ${layer.itemCode} names no inventory account; set it on the item first.`);
    }
    const stockKey = `${accounts.inventory}|${layer.warehouseCode}`;
    const stock = stockLines.get(stockKey) ?? { accountId: accounts.inventory, warehouseCode: layer.warehouseCode, amount: 0n };
    stock.amount += share.amountIqd;
    stockLines.set(stockKey, stock);
    const dimensions = clean(share.row.dimensions);
    const creditKey = `${share.row.destinationRole}|${share.row.accountId}|${Object.entries(dimensions).map(([k, v]) => `${k}=${v}`).join('|')}`;
    const credit = creditLines.get(creditKey) ?? { role: share.row.destinationRole, accountId: share.row.accountId, dimensions, amount: 0n };
    credit.amount += share.amountIqd;
    creditLines.set(creditKey, credit);
  }

  const criteria = { branchCode };
  const posted = await posting.post(tx, ctx, {
    eventType: 'payables.landed_cost',
    documentTypeCode: 'landed_cost_lock',
    source: { module: 'inventory', documentId: input.returnMovementId, event: 'landed_cost_returned' },
    branchCode,
    documentDate: input.postingDate,
    postingDate: input.postingDate,
    description: input.description,
    lines: [
      ...[...stockLines.values()].map((entry) => ({
        role: 'inventory',
        accountId: entry.accountId,
        debit: showMoney(entry.amount),
        criteria: { ...criteria, warehouseCode: entry.warehouseCode },
        dimensions: { branch: branchCode, warehouse: entry.warehouseCode },
      })),
      ...[...creditLines.values()].map((entry) => ({
        role: entry.role,
        accountId: entry.accountId,
        credit: showMoney(entry.amount),
        criteria: {
          ...criteria,
          ...(entry.dimensions.warehouse ? { warehouseCode: entry.dimensions.warehouse } : {}),
          ...(entry.dimensions.project ? { projectCode: entry.dimensions.project } : {}),
        },
        dimensions: entry.dimensions,
      })),
    ],
  });

  for (const layer of restated) {
    await tx.execute(sql`update cost_layer set unit_cost_iqd = ${showMoney(layer.unitCost)}::numeric where id = ${layer.id}::uuid`);
  }

  let rows = 0;
  const written: { id: string; share: Share }[] = [];
  for (const share of shares) {
    const id = randomUUID();
    await tx.execute(sql`
      insert into landed_cost_departure
        (id, lock_id, payable_id, kind, cost_layer_id, movement_id, movement_kind, source_document_type,
         source_document_id, source_line_id, quantity, amount_iqd, destination_role, account_id, dimensions,
         journal_entry_id, returns_departure_id, to_layer_id, departed_on, created_by)
      values
        (${id}::uuid, ${share.row.lockId}::uuid, ${share.row.payableId}::uuid, 'return', ${share.row.costLayerId}::uuid,
         ${returnMovement.id}::uuid, ${returnMovement.kind}, ${returnMovement.sourceDocumentType},
         ${returnMovement.sourceDocumentId}, ${returnMovement.sourceLineId},
         ${formatQuantity(-share.quantity)}::numeric, ${showMoney(-share.amountIqd)}::numeric,
         ${share.row.destinationRole}, ${share.row.accountId}::uuid, ${JSON.stringify(share.row.dimensions)}::jsonb,
         ${posted.journalEntryId}::uuid, ${share.row.id}::uuid, ${share.unit.toLayerId}::uuid,
         ${input.postingDate}::date, ${ctx.principal.userId}::uuid)`);
    rows += 1;
    written.push({ id, share });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'landed_cost.returned',
    objectType: 'landed_cost',
    objectId: input.returnMovementId,
    branchCode,
    after: {
      journalEntryId: posted.journalEntryId,
      postingDate: input.postingDate,
      amountIqd: showMoney(total),
      rows,
      returns: written.map(({ id, share }) => ({
        id,
        departureId: share.row.id,
        lock: share.row.sequence,
        quantity: formatQuantity(share.quantity),
        amountIqd: showMoney(share.amountIqd),
        role: share.row.destinationRole,
      })),
      restated: restated.map((layer) => ({ layerId: layer.id, unitCostIqd: showMoney(layer.unitCost) })),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  // The modules that keep an analysis beside the ledger write their side now.
  for (const { id, share } of written) {
    const movement = await departedMovement(tx, share.row.movementId);
    if (!movement) continue;
    await handlers.get(movement.kind)?.returned?.(tx, ctx, {
      returnId: id,
      departureId: share.row.id,
      lockId: share.row.lockId,
      payableId: share.row.payableId,
      journalEntryId: posted.journalEntryId,
      postedOn: input.postingDate,
      movement,
      returnMovement,
      quantity: share.quantity,
      amountIqd: share.amountIqd,
    });
  }

  return { journalEntryId: posted.journalEntryId, amountIqd: total, rows };
}
