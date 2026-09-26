/**
 * Inventory reports — Phase 04.10, §9.9 and §22.
 *
 * Four things the blueprint asks a report to be, and the reason each is a
 * property of how the query is written rather than of a note in the manual:
 *
 *   **It reconciles.** FIFO valuation is the sum of the layers, and the layers
 *   are what the postings were made from — so the report and the control account
 *   agree by construction rather than by coincidence.
 *
 *   **It is scoped.** §22 requires row-level security in the query layer.
 *   Reports read through the same scoped tables everything else does, so a
 *   branch user's report shows their branch because the database will not show
 *   them another.
 *
 *   **It distinguishes posted from provisional.** §22 again. A movement that has
 *   not posted is real stock and an unrecorded cost; a report that mixes the two
 *   silently is a report that says the ledger and the warehouse disagree without
 *   saying which figure to trust.
 *
 *   **It traces.** §9.9 requires serial and batch traceability end to end, which
 *   means a report that takes an identifier and returns every movement of it.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assertCan, type Principal } from '../domain/permissions';

export const PERMISSION_OBJECT = 'inventory_movement';

export interface ValuationRow {
  readonly itemCode: string;
  /**
   * What the item and the warehouse are called — Operations block 7, which
   * asks the Warehouses Report for "Item Name; Item Code; Warehouse Name;
   * Warehouse Code; Quantity; Total Price".
   *
   * Joined here rather than looked up by the page, because a report of two
   * hundred rows would otherwise be two hundred lookups, and because a name
   * fetched separately can be a different name from the one the figure was
   * grouped under.
   */
  readonly itemName: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly branchCode: string;
  readonly quantity: string;
  readonly valueIqd: string;
  /** §22 — the part of the value whose movements have reached the ledger. */
  readonly postedValueIqd: string;
  readonly provisionalValueIqd: string;
}

/**
 * FIFO valuation, by item and warehouse.
 *
 * The value is the layers' remaining quantity at their own unit costs — the
 * same arithmetic `domain/fifo.ts` does, expressed in SQL so a warehouse-wide
 * report does not have to load every layer into memory. The two are checked
 * against each other in the integration tests, because two implementations of
 * one rule is exactly the thing that drifts.
 *
 * **Branch (D10).** Row-level security bounds this to the branches the user is
 * *permitted*; within that, the report opens on the **Active Branch**, because
 * a stock valuation is a daily working figure and a warehouse manager asking
 * "what do I hold?" means their own branch. `branchCode` names another one —
 * refused by the database if it is not theirs — and `allPermittedBranches`
 * consolidates, which is what a group financial controller holding several
 * branches actually wants at month end. The last of those widens the default
 * and never the permission.
 */
export async function valuation(
  tx: Tx,
  principal: Principal,
  filter: {
    warehouseCode?: string;
    itemCode?: string;
    /**
     * What a person typed into the item box: matched against the item's name
     * and, for somebody who has one, its code.
     *
     * Case-insensitive and anywhere in the text, which needs a leading wildcard
     * — so it is `lower(...)` on both sides to meet the trigram indexes added in
     * migration 0212. Write it any other way (`ilike`, or the column without
     * `lower`) and the planner cannot use them and the report goes back to
     * reading every item.
     */
    itemSearch?: string;
    branchCode?: string;
    allPermittedBranches?: boolean;
  } = {},
): Promise<ValuationRow[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const conditions = [sql`l.remaining_quantity > 0`];
  if (filter.warehouseCode) conditions.push(sql`l.warehouse_code = ${filter.warehouseCode}`);
  if (filter.itemCode) conditions.push(sql`l.item_code = ${filter.itemCode}`);

  const term = filter.itemSearch?.trim();
  if (term) {
    // The term is a value, never spliced into the statement: `%` and `_` are
    // wildcards a person may legitimately type, and escaping them here keeps a
    // search for "A_1" a search for "A_1".
    const like = `%${term.toLowerCase().replace(/([%_\\])/g, '\\$1')}%`;
    conditions.push(
      sql`(lower(i.name) like ${like} escape '\\' or lower(l.item_code) like ${like} escape '\\')`,
    );
  }

  if (filter.branchCode) {
    conditions.push(sql`l.branch_code = ${filter.branchCode}`);
  } else if (!filter.allPermittedBranches) {
    conditions.push(sql`l.branch_code = current_setting('app.branch_code', true)`);
  }

  const result = await tx.execute(sql`
    select l.item_code                                          as "itemCode",
           i.name                                               as "itemName",
           l.warehouse_code                                     as "warehouseCode",
           w.name                                               as "warehouseName",
           l.branch_code                                        as "branchCode",
           sum(l.remaining_quantity)::text                      as "quantity",
           sum(l.remaining_quantity * l.unit_cost_iqd)::text    as "valueIqd",
           -- §22 — split by whether the movement that created the layer has
           -- reached the General Ledger.
           coalesce(sum(l.remaining_quantity * l.unit_cost_iqd)
             filter (where m.journal_entry_id is not null), 0)::text as "postedValueIqd",
           coalesce(sum(l.remaining_quantity * l.unit_cost_iqd)
             filter (where m.journal_entry_id is null), 0)::text     as "provisionalValueIqd"
      from cost_layer l
      join inventory_movement m on m.id = l.created_by_movement_id
      join item i             on i.code = l.item_code
      join warehouse w        on w.code = l.warehouse_code
     where ${sql.join(conditions, sql` and `)}
     group by l.item_code, i.name, l.warehouse_code, w.name, l.branch_code
     order by i.name, w.name
  `);

  return (result as unknown as { rows: ValuationRow[] }).rows;
}

export interface TraceRow {
  readonly movementId: string;
  readonly kind: string;
  readonly warehouseCode: string;
  readonly quantity: string;
  readonly movementDate: string;
  readonly serialNumber: string | null;
  readonly batchNumber: string | null;
  readonly sourceDocumentType: string | null;
  readonly sourceDocumentId: string | null;
  readonly journalEntryId: string | null;
  readonly expiryDate: string | null;
}

/**
 * §9.9 — *"Serial/batch traceability works from receipt to transfer, delivery,
 * return and write-off."*
 *
 * Takes the identifier a person actually has — a serial off a label, a batch off
 * a carton — and returns every movement of it, oldest first. Deliberately not
 * filtered by warehouse: the point of a trace is to find where something went,
 * and constraining it to where you think it is defeats that.
 *
 * **Branch (D10).** For the same reason it is not filtered by the Active Branch
 * either, and this is the one report where that matters most. A trace answers
 * "where did this unit go", and a unit that went to another branch is exactly
 * the case someone runs a trace for. Defaulting to the Active Branch the way a
 * valuation does would have the report say *not found* about a movement the user
 * is entitled to see, which is worse than saying nothing — a recall or a warranty
 * claim would stop at a boundary that was only a screen default.
 *
 * The hard boundary remains, and it is the user's *permitted* branches, enforced
 * by row-level security rather than by this query. A group-wide trace across
 * branches the user does not hold is a reporting question with its own
 * permission, not something this function should quietly widen into.
 */
export async function trace(
  tx: Tx,
  principal: Principal,
  identifier: { itemCode?: string; serialNumber?: string; batchNumber?: string },
): Promise<TraceRow[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  if (!identifier.serialNumber && !identifier.batchNumber) {
    throw new Error(
      'A trace needs a serial or a batch number. Searching by item alone returns every movement of every unit, which is a stock ledger, not a trace (§9.9).',
    );
  }

  const conditions = [];
  if (identifier.itemCode) conditions.push(sql`m.item_code = ${identifier.itemCode}`);
  if (identifier.serialNumber) conditions.push(sql`m.serial_number = ${identifier.serialNumber}`);
  if (identifier.batchNumber) conditions.push(sql`m.batch_number = ${identifier.batchNumber}`);

  const result = await tx.execute(sql`
    select m.id                    as "movementId",
           m.kind::text            as "kind",
           m.warehouse_code        as "warehouseCode",
           m.quantity::text        as "quantity",
           m.movement_date::text   as "movementDate",
           m.serial_number         as "serialNumber",
           m.batch_number          as "batchNumber",
           m.source_document_type  as "sourceDocumentType",
           m.source_document_id    as "sourceDocumentId",
           m.journal_entry_id      as "journalEntryId",
           m.expiry_date::text     as "expiryDate"
      from inventory_movement m
     where ${sql.join(conditions, sql` and `)}
     order by m.movement_date, m.created_at
  `);

  return (result as unknown as { rows: TraceRow[] }).rows;
}

export interface ExpiryRow {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly batchNumber: string | null;
  readonly expiryDate: string;
  readonly quantity: string;
}

/**
 * §9.3 — expiry dates *"captured and reportable where configured"*.
 *
 * On-hand quantity by batch and expiry, for stock that has not left. A batch
 * fully issued does not appear: what is expiring is a question about what is on
 * the shelf.
 */
export async function expiring(
  tx: Tx,
  principal: Principal,
  before: string,
): Promise<ExpiryRow[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  // The quantity is the batch's whole position, not the sum of the movements
  // that happen to carry an expiry date. Only receipts carry one; an issue does
  // not, so summing the dated rows alone would report stock as expiring after
  // it had been issued.
  const result = await tx.execute(sql`
    with dated as (
      select item_code, warehouse_code, batch_number, min(expiry_date) as expiry_date
        from inventory_movement
       where expiry_date is not null
       group by item_code, warehouse_code, batch_number
    ),
    held as (
      select item_code, warehouse_code, batch_number, sum(quantity) as quantity
        from inventory_movement
       group by item_code, warehouse_code, batch_number
    )
    select d.item_code          as "itemCode",
           d.warehouse_code     as "warehouseCode",
           d.batch_number       as "batchNumber",
           d.expiry_date::text  as "expiryDate",
           h.quantity::text     as "quantity"
      from dated d
      join held h
        on h.item_code = d.item_code
       and h.warehouse_code = d.warehouse_code
       and h.batch_number is not distinct from d.batch_number
     where d.expiry_date <= ${before}
       and h.quantity > 0
     order by d.expiry_date, d.item_code
  `);

  return (result as unknown as { rows: ExpiryRow[] }).rows;
}

/**
 * §9.9 — the integrity report.
 *
 * Three questions that must all answer zero, asked as one query so that
 * "inventory reconciles" is something a person can check in a second rather
 * than a claim in a document:
 *
 *   1. Does any warehouse hold a negative position?
 *   2. Does any item's ledger quantity disagree with its layers?
 *   3. Does any layer's remaining quantity disagree with its consumption?
 */
export async function integrity(tx: Tx, principal: Principal) {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const result = await tx.execute(sql`
    with positions as (
      select item_code, warehouse_code, sum(quantity) as on_hand
        from inventory_movement group by item_code, warehouse_code
    ),
    layers as (
      select item_code, warehouse_code, sum(remaining_quantity) as remaining
        from cost_layer group by item_code, warehouse_code
    )
    select 'negative_position' as issue,
           p.item_code, p.warehouse_code,
           p.on_hand::text as detail
      from positions p where p.on_hand < 0
    union all
    select 'ledger_layer_mismatch',
           p.item_code, p.warehouse_code,
           (p.on_hand - coalesce(l.remaining, 0))::text
      from positions p
      left join layers l
        on l.item_code = p.item_code and l.warehouse_code = p.warehouse_code
     where p.on_hand <> coalesce(l.remaining, 0)
    union all
    select 'layer_consumption_mismatch',
           c.item_code, c.warehouse_code,
           (c.remaining_quantity - (c.original_quantity - coalesce(sum(k.quantity), 0)))::text
      from cost_layer c
      left join cost_layer_consumption k on k.layer_id = c.id
     group by c.id, c.item_code, c.warehouse_code, c.remaining_quantity, c.original_quantity
    having c.remaining_quantity <> c.original_quantity - coalesce(sum(k.quantity), 0)
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}
