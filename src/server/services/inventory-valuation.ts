/**
 * Inventory valued at a date — IMPROVEMENT-002 (sponsor, 2026-10-04).
 *
 * The movement ledger and its FIFO layers are enough to compute an exact past
 * position; nothing is stored for it. For a date D:
 *
 *   quantity   a layer's original quantity, when the movement that made it is
 *              dated on or before D, less every consumption whose consuming
 *              movement is dated on or before D (a reversal's restoring rows are
 *              negative consumptions on the reversal, so they count on the
 *              reversal's own day — the original keeps its date);
 *   unit cost  the layer's unit cost now, less the deltas of every landed-cost
 *              lock dated after D (`landed_cost_layer_adjustment`, by the lock's
 *              date — a lock can be backdated, so it is the sum of the deltas,
 *              never "the earliest unit_cost_before");
 *   value      Σ quantity × unit cost, each layer rounded once to the fils —
 *              the Warehouses Report's own arithmetic.
 *
 * Status: D after today is **refused**; D on or before the end of the last
 * closed period that follows an unbroken run of closed periods is **final**;
 * anything else is **provisional** (an open or soft-closed month may still
 * move). A consumption whose consumer is dated before the layer's maker
 * movement makes the range [consumer date, maker date) impossible for that
 * layer — the figure is **flagged**, never corrected: the ledger says what it
 * says and the flag says why it cannot be right.
 *
 * Beside it, the General Ledger at D: the posted and reversed journal lines on
 * the items' inventory accounts with a posting date on or before D, per
 * account — a journal line names an account, never an item. The known
 * reconciling items are listed in the brief: movements that never posted a
 * journal, a lock date against the lock's real time, reversals made before the
 * date fix, transfers in transit, per-layer rounding, manual journals.
 *
 * Money and quantities are compared and summed as scaled bigints (HARDEN-2);
 * the SQL rounds to four places and hands back text.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '../domain/money';
import type { Principal } from '../domain/permissions';
import { PermissionDeniedError, can } from '../domain/permissions';
import { QUANTITY_FACTOR, formatQuantity, parseQuantity } from '../domain/uom';
import * as periods from './periods';

export const PERMISSION_OBJECT = 'inventory_movement';

export type ValuationStatus = 'final' | 'provisional' | 'refused';

export class ValuationDateError extends Error {
  readonly code = 'VALUATION_DATE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'ValuationDateError';
  }
}

export interface ValuationFilter {
  readonly asOf: string;
  readonly warehouseCode?: string | null;
  readonly itemCode?: string | null;
  readonly category?: string | null;
  readonly branchCode?: string | null;
  /** Every branch the person may see, rather than the active one. */
  readonly allPermittedBranches?: boolean;
}

export interface ValuationLine {
  readonly itemCode: string;
  readonly itemName: string;
  readonly category: string | null;
  readonly uomCode: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly branchCode: string;
  readonly isTransit: boolean;
  readonly quantity: string;
  /** valueIqd ÷ quantity, half up; '0' with nothing on hand. */
  readonly unitCostIqd: string;
  readonly valueIqd: string;
  readonly layers: number;
  /** True when a layer of the line is inside an impossible range at the date. */
  readonly flagged: boolean;
}

export interface ValuationFlag {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly layerId: string;
  /** The consuming movement's date — the range starts here. */
  readonly from: string;
  /** The layer's maker movement's date — the range ends the day before. */
  readonly to: string;
  readonly quantity: string;
  readonly detail: string;
}

export interface ValuationAccount {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  /** Σ the layers' value at the date for the items on this account. */
  readonly layersIqd: string;
  /** The account's posted balance at the date. */
  readonly glIqd: string;
  readonly differenceIqd: string;
}

export interface HistoricalValuation {
  readonly asOf: string;
  readonly status: Exclude<ValuationStatus, 'refused'>;
  /** The last day the figures are final — the end of the unbroken run of closed periods; null when no period is closed. */
  readonly finalThrough: string | null;
  readonly costingMethod: 'FIFO';
  readonly lines: ValuationLine[];
  readonly totalQuantity: string;
  readonly totalIqd: string;
  readonly flags: ValuationFlag[];
  readonly accounts: ValuationAccount[];
  readonly glTotalIqd: string;
  readonly differenceIqd: string;
}

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);

/** The last day of the unbroken run of closed periods from the first, or null. */
export async function finalThrough(tx: Tx): Promise<string | null> {
  const all = await periods.calendar(tx);
  let last: string | null = null;
  for (const period of all) {
    if (period.status !== 'closed') break;
    last = period.endsOn;
  }
  return last;
}

/** What a date's valuation would be called, without computing it. */
export function statusOf(asOf: string, today: string, through: string | null): ValuationStatus {
  if (asOf > today) return 'refused';
  if (through && asOf <= through) return 'final';
  return 'provisional';
}

interface LayerAtRow {
  layerId: string;
  itemCode: string;
  itemName: string;
  category: string | null;
  uomCode: string;
  warehouseCode: string;
  warehouseName: string;
  branchCode: string;
  isTransit: boolean;
  accountId: string | null;
  quantity: string;
  unitCost: string;
  value: string;
}

interface FlagRow {
  layerId: string;
  itemCode: string;
  warehouseCode: string;
  from: string;
  to: string;
  quantity: string;
}

export async function valuationAt(tx: Tx, principal: Principal, filter: ValuationFilter): Promise<HistoricalValuation> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) throw new PermissionDeniedError(principal.userId, 'view', PERMISSION_OBJECT);
  const asOf = filter.asOf.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new ValuationDateError(`'${asOf}' is not a date.`);
  const today = businessToday();
  const through = await finalThrough(tx);
  const status = statusOf(asOf, today, through);
  if (status === 'refused') {
    throw new ValuationDateError(`${asOf} has not come: stock is valued on a day that has, ${today} at the latest.`);
  }

  const where = [
    principal.isSuperUser ? null : sql`app_branch_allowed(cl.branch_code)`,
    filter.branchCode ? sql`cl.branch_code = ${filter.branchCode}` : filter.allPermittedBranches ? null : sql`cl.branch_code = current_setting('app.branch_code', true)`,
    filter.warehouseCode ? sql`cl.warehouse_code = ${filter.warehouseCode}` : null,
    filter.itemCode ? sql`cl.item_code = ${filter.itemCode}` : null,
    filter.category ? sql`i.category = ${filter.category}` : null,
  ].filter((part): part is NonNullable<typeof part> => part !== null);
  const scope = where.length ? sql`and ${sql.join(where, sql` and `)}` : sql``;

  // Every layer that existed at the date, with its quantity and unit cost then.
  const rows = (
    await tx.execute(sql`
      with at_date as (
        select cl.id as layer_id, cl.item_code, cl.warehouse_code, cl.branch_code,
               cl.original_quantity
                 - coalesce((select sum(c.quantity) from cost_layer_consumption c
                              join inventory_movement cm on cm.id = c.movement_id
                             where c.layer_id = cl.id and cm.movement_date <= ${asOf}::date), 0) as quantity,
               cl.unit_cost_iqd
                 - coalesce((select sum(a.unit_cost_after - a.unit_cost_before) from landed_cost_layer_adjustment a
                              join landed_cost_lock k on k.id = a.lock_id
                             where a.cost_layer_id = cl.id and k.lock_date > ${asOf}::date), 0) as unit_cost
          from cost_layer cl
          join inventory_movement maker on maker.id = cl.created_by_movement_id
          join item i on i.code = cl.item_code
         where maker.movement_date <= ${asOf}::date ${scope}
      )
      select d.layer_id as "layerId", d.item_code as "itemCode", i.name as "itemName", i.category, i.base_uom_code as "uomCode",
             d.warehouse_code as "warehouseCode", w.name as "warehouseName", d.branch_code as "branchCode", w.is_transit as "isTransit",
             i.inventory_account_id as "accountId",
             d.quantity::text as quantity, d.unit_cost::text as "unitCost",
             round(d.quantity * d.unit_cost, 4)::text as value
        from at_date d
        join item i on i.code = d.item_code
        join warehouse w on w.code = d.warehouse_code
       where d.quantity <> 0
       order by i.name, w.name, d.layer_id`)
  ).rows as unknown as LayerAtRow[];

  // Impossible ranges at the date: a consumer dated before its layer's maker.
  const flagRows = (
    await tx.execute(sql`
      select c.layer_id as "layerId", cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode",
             cm.movement_date::text as "from", maker.movement_date::text as "to", c.quantity::text as quantity
        from cost_layer_consumption c
        join inventory_movement cm on cm.id = c.movement_id
        join cost_layer cl on cl.id = c.layer_id
        join inventory_movement maker on maker.id = cl.created_by_movement_id
        join item i on i.code = cl.item_code
       where c.quantity > 0
         and cm.movement_date < maker.movement_date
         and cm.movement_date <= ${asOf}::date
         and maker.movement_date > ${asOf}::date ${scope}
       order by cl.item_code, cl.warehouse_code, cm.movement_date`)
  ).rows as unknown as FlagRow[];
  const flags: ValuationFlag[] = flagRows.map((row) => ({
    itemCode: row.itemCode,
    warehouseCode: row.warehouseCode,
    layerId: row.layerId,
    from: row.from,
    to: row.to,
    quantity: formatQuantity(parseQuantity(row.quantity)),
    detail:
      `${formatQuantity(parseQuantity(row.quantity))} of ${row.itemCode} left ${row.warehouseCode} on ${row.from} from a layer ` +
      `received on ${row.to}: the position between the two dates cannot be right and is not corrected.`,
  }));
  const flaggedLayers = new Set(flags.map((flag) => flag.layerId));
  // A layer consumed before it was made is below zero at the date and absent
  // from `rows` (its maker is after D): it is still a line, so the flag has a
  // row to stand beside and the total says what the ledger says.
  const belowZero = flagRows.length
    ? ((
        await tx.execute(sql`
          select cl.id as "layerId", cl.item_code as "itemCode", i.name as "itemName", i.category, i.base_uom_code as "uomCode",
                 cl.warehouse_code as "warehouseCode", w.name as "warehouseName", cl.branch_code as "branchCode", w.is_transit as "isTransit",
                 i.inventory_account_id as "accountId",
                 (-(select coalesce(sum(c.quantity), 0) from cost_layer_consumption c join inventory_movement cm on cm.id = c.movement_id
                      where c.layer_id = cl.id and cm.movement_date <= ${asOf}::date))::text as quantity,
                 (cl.unit_cost_iqd - coalesce((select sum(a.unit_cost_after - a.unit_cost_before) from landed_cost_layer_adjustment a
                      join landed_cost_lock k on k.id = a.lock_id where a.cost_layer_id = cl.id and k.lock_date > ${asOf}::date), 0))::text as "unitCost",
                 round((-(select coalesce(sum(c.quantity), 0) from cost_layer_consumption c join inventory_movement cm on cm.id = c.movement_id
                      where c.layer_id = cl.id and cm.movement_date <= ${asOf}::date))
                   * (cl.unit_cost_iqd - coalesce((select sum(a.unit_cost_after - a.unit_cost_before) from landed_cost_layer_adjustment a
                      join landed_cost_lock k on k.id = a.lock_id where a.cost_layer_id = cl.id and k.lock_date > ${asOf}::date), 0)), 4)::text as value
            from cost_layer cl
            join item i on i.code = cl.item_code
            join warehouse w on w.code = cl.warehouse_code
           where cl.id in (${sql.join([...flaggedLayers].map((id) => sql`${id}::uuid`), sql`, `)})`)
      ).rows as unknown as LayerAtRow[])
    : [];

  // Lines: item × warehouse, the layers summed exactly.
  const byLine = new Map<string, { line: Omit<ValuationLine, 'quantity' | 'unitCostIqd' | 'valueIqd' | 'layers' | 'flagged'>; quantity: bigint; value: bigint; layers: number; flagged: boolean; accountId: string | null }>();
  for (const row of [...rows, ...belowZero]) {
    const key = `${row.itemCode}\u0000${row.warehouseCode}\u0000${row.branchCode}`;
    const entry = byLine.get(key) ?? {
      line: {
        itemCode: row.itemCode,
        itemName: row.itemName,
        category: row.category,
        uomCode: row.uomCode,
        warehouseCode: row.warehouseCode,
        warehouseName: row.warehouseName,
        branchCode: row.branchCode,
        isTransit: row.isTransit,
      },
      quantity: 0n,
      value: 0n,
      layers: 0,
      flagged: false,
      accountId: row.accountId,
    };
    entry.quantity += parseQuantity(row.quantity);
    entry.value += amountOf(row.value);
    entry.layers += 1;
    if (flaggedLayers.has(row.layerId)) entry.flagged = true;
    byLine.set(key, entry);
  }
  const lines: ValuationLine[] = [...byLine.values()].map((entry) => ({
    ...entry.line,
    quantity: formatQuantity(entry.quantity),
    unitCostIqd: entry.quantity !== 0n ? money(divideHalfUp(entry.value * QUANTITY_FACTOR, entry.quantity)) : '0',
    valueIqd: money(entry.value),
    layers: entry.layers,
    flagged: entry.flagged,
  }));
  const totalQuantity = [...byLine.values()].reduce((sum, entry) => sum + entry.quantity, 0n);
  const totalIqd = [...byLine.values()].reduce((sum, entry) => sum + entry.value, 0n);

  // The General Ledger at the date, per inventory account of the items in view.
  const layersByAccount = new Map<string, bigint>();
  for (const entry of byLine.values()) {
    if (!entry.accountId) continue;
    layersByAccount.set(entry.accountId, (layersByAccount.get(entry.accountId) ?? 0n) + entry.value);
  }
  const accountIds = [...layersByAccount.keys()];
  const glRows = accountIds.length
    ? ((
        await tx.execute(sql`
          select a.id as "accountId", a.code as "accountCode", a.name as "accountName",
                 coalesce((select sum(l.debit_iqd - l.credit_iqd) from journal_line l
                            join journal_entry e on e.id = l.journal_entry_id
                           where l.account_id = a.id and e.status in ('posted', 'reversed') and e.posting_date <= ${asOf}::date
                             ${filter.branchCode ? sql`and e.branch_code = ${filter.branchCode}` : filter.allPermittedBranches ? sql`` : sql`and e.branch_code = current_setting('app.branch_code', true)`}), 0)::text as gl
            from chart_of_account a
           where a.id in (${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)})
           order by a.code`)
      ).rows as unknown as { accountId: string; accountCode: string; accountName: string; gl: string }[])
    : [];
  const accounts: ValuationAccount[] = glRows.map((row) => {
    const layersIqd = layersByAccount.get(row.accountId) ?? 0n;
    const glIqd = amountOf(row.gl);
    return {
      accountId: row.accountId,
      accountCode: row.accountCode,
      accountName: row.accountName,
      layersIqd: money(layersIqd),
      glIqd: money(glIqd),
      differenceIqd: money(layersIqd - glIqd),
    };
  });
  const glTotal = accounts.reduce((sum, account) => sum + amountOf(account.glIqd), 0n);
  const layersOnAccounts = accounts.reduce((sum, account) => sum + amountOf(account.layersIqd), 0n);

  return {
    asOf,
    status,
    finalThrough: through,
    costingMethod: 'FIFO',
    lines,
    totalQuantity: formatQuantity(totalQuantity),
    totalIqd: money(totalIqd),
    flags,
    accounts,
    glTotalIqd: money(glTotal),
    differenceIqd: money(layersOnAccounts - glTotal),
  };
}

/**
 * The company-wide figure the period-close check asks for: every layer's
 * value at the date against every inventory account's balance at the date,
 * exact, with the part whose maker movement posted no journal of its own
 * named beside it. No branch narrowing: a close is the company's.
 */
export async function stockAgainstGl(tx: Tx, asOf: string) {
  const [layers] = (
    await tx.execute(sql`
      with at_date as (
        select cl.id, m.journal_entry_id,
               round((cl.original_quantity
                 - coalesce((select sum(c.quantity) from cost_layer_consumption c
                              join inventory_movement cm on cm.id = c.movement_id
                             where c.layer_id = cl.id and cm.movement_date <= ${asOf}::date), 0))
                 * (cl.unit_cost_iqd
                 - coalesce((select sum(a.unit_cost_after - a.unit_cost_before) from landed_cost_layer_adjustment a
                              join landed_cost_lock k on k.id = a.lock_id
                             where a.cost_layer_id = cl.id and k.lock_date > ${asOf}::date), 0)), 4) as value
          from cost_layer cl
          join inventory_movement m on m.id = cl.created_by_movement_id
         where m.movement_date <= ${asOf}::date
      )
      select coalesce(sum(value), 0)::text as value,
             coalesce(sum(value) filter (where journal_entry_id is null), 0)::text as provisional
        from at_date`)
  ).rows as { value: string; provisional: string }[];
  const [gl] = (
    await tx.execute(sql`
      select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as value
        from journal_line l
        join journal_entry e on e.id = l.journal_entry_id
       where e.status in ('posted', 'reversed') and e.posting_date <= ${asOf}::date
         and l.account_id in (select distinct inventory_account_id from item where inventory_account_id is not null)`)
  ).rows as { value: string }[];
  const layersIqd = amountOf(layers?.value);
  const glIqd = amountOf(gl?.value);
  return {
    layersIqd: money(layersIqd),
    provisionalIqd: money(amountOf(layers?.provisional)),
    glIqd: money(glIqd),
    differenceIqd: money(layersIqd - glIqd),
  };
}
