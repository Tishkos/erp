/**
 * The stock documents' answer to "where did the stock go?" — IMPROVEMENT-002.
 *
 *   * written off (a damaged-goods write-off, a transfer's loss in transit):
 *     `inventory_loss` — the write-off's own journal line where it posted one,
 *     else the `inventory.write_off` mapping. Nothing mapped refuses the lock
 *     and names the role: a loss is never posted somewhere else.
 *   * counted short (Item Reconciliation, a Stock Count): `inventory_adjustment`
 *     — the reconciliation's or count's own journal line, else the mapping
 *     Item Reconciliation posts through (`inventory.stock_adjustment`).
 *   * moved (a transfer, quarantine release or rejection, a damage move): not
 *     a departure — the cost follows the units to the layer they arrived in.
 *     Here only the transfer's name for a message, and whether it is still
 *     on the way.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  DepartureError,
  journalLineOf,
  labelFor,
  mappedAccount,
  type DepartedMovement,
  type DepartureDestination,
  type DepartureHandler,
} from '../services/inventory-departures';

const rows = <T>(result: { rows: unknown[] }) => result.rows as T[];

const place = (movement: DepartedMovement) => ({ branch: movement.branchCode, warehouse: movement.warehouseCode });

async function writtenOff(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  if (movement.journalEntryId) {
    const own = await journalLineOf(tx, movement.journalEntryId, 'inventory_loss', { warehouseCode: movement.warehouseCode });
    if (own) return { role: 'inventory_loss', ...own };
  }
  const criteria = { branchCode: movement.branchCode, warehouseCode: movement.warehouseCode };
  const accountId =
    (await mappedAccount(tx, 'inventory.write_off', 'inventory_loss', criteria)) ??
    (await mappedAccount(tx, 'inventory.damage', 'inventory_loss', criteria));
  if (!accountId) {
    throw new DepartureError(
      `${movement.itemCode} was written off in ${movement.warehouseCode} (${await labelFor(tx, movement)}), so its landed ` +
        "cost is an inventory loss — and no account is mapped for 'inventory_loss' (Stock written off, inventory.write_off). " +
        'Map it in Posting Mappings, then lock. The loss is not posted anywhere else.',
    );
  }
  return { role: 'inventory_loss', accountId, dimensions: place(movement) };
}

async function countedShort(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  if (movement.sourceDocumentType === 'stock_adjustment' && movement.sourceDocumentId) {
    const [adjustment] = rows<{ journalEntryId: string | null }>(
      await tx.execute(sql`select journal_entry_id as "journalEntryId" from stock_adjustment where id::text = ${movement.sourceDocumentId}`),
    );
    if (adjustment?.journalEntryId) {
      const own = await journalLineOf(tx, adjustment.journalEntryId, 'inventory_adjustment');
      if (own) return { role: 'inventory_adjustment', ...own };
    }
  }
  if (movement.journalEntryId) {
    const own = await journalLineOf(tx, movement.journalEntryId, 'inventory_adjustment', { warehouseCode: movement.warehouseCode });
    if (own) return { role: 'inventory_adjustment', ...own };
  }
  const accountId = await mappedAccount(tx, 'inventory.stock_adjustment', 'inventory_adjustment', {
    branchCode: movement.branchCode,
    warehouseCode: movement.warehouseCode,
  });
  if (!accountId) {
    throw new DepartureError(
      `${movement.itemCode} was counted short in ${movement.warehouseCode} (${await labelFor(tx, movement)}), so its landed ` +
        "cost is an inventory adjustment — and no account is mapped for 'inventory_adjustment' (Item Reconciliation). " +
        'Map it in Posting Mappings, then lock.',
    );
  }
  return { role: 'inventory_adjustment', accountId, dimensions: place(movement) };
}

async function label(tx: Tx, movement: DepartedMovement): Promise<string | null> {
  const id = movement.sourceDocumentId;
  if (!id) return null;
  const one = async (query: ReturnType<typeof sql>) => rows<{ no: string }>(await tx.execute(query))[0]?.no ?? null;
  switch (movement.sourceDocumentType) {
    case 'warehouse_transfer': {
      const no = await one(sql`select transfer_no as no from warehouse_transfer where id::text = ${id}`);
      return no ? `warehouse transfer ${no}` : null;
    }
    case 'stock_transfer': {
      const no = await one(sql`select transfer_no as no from stock_transfer where id::text = ${id}`);
      return no ? `stock transfer ${no}` : null;
    }
    case 'stock_adjustment': {
      const no = await one(sql`select adjustment_no as no from stock_adjustment where id::text = ${id}`);
      return no ? `Item Reconciliation ${no}` : null;
    }
    case 'stock_count': {
      const no = await one(sql`select count_no as no from stock_count where id::text = ${id}`);
      return no ? `Stock Count ${no}` : null;
    }
    case 'container_receipt': {
      const no = await one(sql`select receipt_no as no from container_receipt where id::text = ${id}`);
      return no ? `container receipt ${no}` : null;
    }
    default:
      return null;
  }
}

/** A warehouse transfer issued and not yet wholly received (§9.4's in-transit). */
async function inTransit(tx: Tx, movement: DepartedMovement): Promise<boolean> {
  if (movement.sourceDocumentType !== 'warehouse_transfer' || !movement.sourceDocumentId) return false;
  const [line] = rows<{ open: boolean }>(
    await tx.execute(sql`
      select (t.status::text in ('in_transit', 'partially_received', 'investigating')
              and l.issued_quantity > l.received_quantity) as open
        from warehouse_transfer t
        join warehouse_transfer_line l on l.transfer_id = t.id
       where t.id::text = ${movement.sourceDocumentId}
         and l.line_no::text = ${movement.sourceLineId ?? ''}`),
  );
  return line?.open ?? false;
}

export const STOCK_DEPARTURES: Readonly<Record<string, DepartureHandler>> = Object.freeze({
  write_off: { destination: writtenOff, label },
  damage: { destination: writtenOff, label },
  count_adjustment: { destination: countedShort, label },
  transfer_issue: { label, inTransit },
  quarantine_release: { label },
  quarantine_reject: { label },
});
