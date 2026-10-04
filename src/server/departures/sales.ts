/**
 * Sales' answer to "where did the stock go?" — IMPROVEMENT-002.
 *
 * A unit sold left for cost of sales, so the landed cost of it is cost of
 * sales — on the account and with the dimensions the sale itself posted its
 * cost with, so the margin of that sale, by its department and business line,
 * carries the whole cost of the goods:
 *
 *   * sold on a Sales Invoice (Operations block 5): the invoice's `cogs` line
 *     for the invoice line the movement names;
 *   * delivered on a Delivery Note, which posts its own journal per movement:
 *     that journal's `cogs` line;
 *   * anything else (a data import, a bare issue): the item's own cost of
 *     sales account, by branch and warehouse.
 *
 * A unit that came back on an accepted Sales Return before the lock is in
 * stock again, in the layer the return made: its share follows it there.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { parseQuantity } from '../domain/uom';
import {
  DepartureError,
  itemAccounts,
  journalLineOf,
  type DepartedMovement,
  type DepartureDestination,
  type DepartureHandler,
  type FollowedUnits,
} from '../services/inventory-departures';

const rows = <T>(result: { rows: unknown[] }) => result.rows as T[];

async function destination(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  if (movement.sourceDocumentType === 'ar_invoice' && movement.sourceDocumentId) {
    const [invoice] = rows<{ journalEntryId: string | null }>(
      await tx.execute(sql`select journal_entry_id as "journalEntryId" from ar_invoice where id::text = ${movement.sourceDocumentId}`),
    );
    if (invoice?.journalEntryId) {
      const line = await journalLineOf(tx, invoice.journalEntryId, 'cogs', { sourceLineId: movement.sourceLineId });
      if (line) return { role: 'cogs', ...line };
    }
  }
  if (movement.journalEntryId) {
    const line = await journalLineOf(tx, movement.journalEntryId, 'cogs', { warehouseCode: movement.warehouseCode });
    if (line) return { role: 'cogs', ...line };
  }
  const accounts = await itemAccounts(tx, movement.itemCode);
  if (!accounts.cogs) {
    throw new DepartureError(`Item ${movement.itemCode} names no cost of sales account; set it on the item first.`);
  }
  return {
    role: 'cogs',
    accountId: accounts.cogs,
    dimensions: { branch: movement.branchCode, warehouse: movement.warehouseCode },
  };
}

/**
 * The units of this sale line that an accepted Sales Return has brought back,
 * shared over the sale's movements in proportion to what each took: a line
 * that sold 10 from two layers and took 4 back gives each layer's movement
 * 40% of its units back.
 */
async function cameBack(tx: Tx, movement: DepartedMovement, quantity: bigint): Promise<readonly FollowedUnits[]> {
  if (!movement.sourceLineId || !movement.sourceDocumentId) return [];
  const byInvoiceLine =
    movement.sourceDocumentType === 'ar_invoice'
      ? sql`srl.ar_invoice_line_id::text = ${movement.sourceLineId}`
      : movement.sourceDocumentType === 'delivery_note'
        ? sql`srl.ar_invoice_line_id in (select ail.id from ar_invoice_line ail where ail.delivery_note_line_id::text = ${movement.sourceLineId})`
        : null;
  if (!byInvoiceLine) return [];

  const returned = rows<{ layerId: string; quantity: string }>(
    await tx.execute(sql`
      select cl.id as "layerId", cl.original_quantity::text as quantity
        from sales_return_line srl
        join cost_layer cl on cl.created_by_movement_id = srl.inventory_movement_id
       where ${byInvoiceLine}
         and srl.inventory_movement_id is not null
         and not exists (select 1 from inventory_movement x where x.reverses_movement_id = srl.inventory_movement_id)
       order by cl.created_at, cl.id`),
  );
  if (returned.length === 0) return [];

  // What the sale line still holds out: its own deliveries, less any reversed.
  const [sold] = rows<{ quantity: string }>(
    await tx.execute(sql`
      select coalesce(sum(-m.quantity), 0)::text as quantity
        from inventory_movement m
       where m.kind = 'delivery'
         and m.source_document_type = ${movement.sourceDocumentType}
         and m.source_document_id = ${movement.sourceDocumentId}
         and m.source_line_id = ${movement.sourceLineId}
         and not exists (select 1 from inventory_movement x where x.reverses_movement_id = m.id)`),
  );
  const delivered = parseQuantity(sold?.quantity ?? '0');
  if (delivered <= 0n) return [];

  const out: FollowedUnits[] = [];
  let given = 0n;
  for (const row of returned) {
    const share = (quantity * parseQuantity(row.quantity)) / delivered;
    const capped = share > quantity - given ? quantity - given : share;
    if (capped <= 0n) continue;
    out.push({ layerId: row.layerId, quantity: capped });
    given += capped;
  }
  return out;
}

async function label(tx: Tx, movement: DepartedMovement): Promise<string | null> {
  if (!movement.sourceDocumentId) return null;
  if (movement.sourceDocumentType === 'ar_invoice') {
    const [row] = rows<{ no: string }>(
      await tx.execute(sql`select invoice_no as no from ar_invoice where id::text = ${movement.sourceDocumentId}`),
    );
    return row ? `Sales Invoice ${row.no}` : null;
  }
  if (movement.sourceDocumentType === 'delivery_note') {
    const [row] = rows<{ no: string }>(
      await tx.execute(sql`select delivery_note_no as no from delivery_note where id::text = ${movement.sourceDocumentId}`),
    );
    return row ? `Delivery Note ${row.no}` : null;
  }
  return null;
}

export const SALES_DEPARTURES: Readonly<Record<string, DepartureHandler>> = Object.freeze({
  delivery: { destination, cameBack, label },
});
