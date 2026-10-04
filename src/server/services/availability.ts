/**
 * Availability — the §9.5 buckets per item and warehouse, for the screen
 * (REQ-FIX-001 FIX-2).
 *
 * Reads the `stock_position` view, so every figure is the movements summed,
 * never a stored total. The view is not behind row-level security of its
 * own, so the branch rule the list engine applied is applied here: a person
 * sees the branches they may, and the warehouse filter narrows to one.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { Principal } from '../domain/permissions';
import { PermissionDeniedError, can } from '../domain/permissions';
import { registerPage, searchOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'inventory_movement';

export interface AvailabilityRow {
  readonly itemCode: string;
  readonly itemName: string;
  readonly category: string | null;
  readonly baseUomCode: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly branchCode: string;
  readonly onHand: string;
  readonly available: string;
  readonly reserved: string;
  readonly inTransit: string;
  readonly inQuarantine: string;
  readonly damaged: string;
  readonly returnsStock: string;
  /**
   * IMPROVEMENT-002 — on order: what approved purchase orders still owe the
   * warehouse (ordered − received − closed), in the base unit; a line that
   * names no warehouse counts on every row of its item.
   */
  readonly onOrder: string;
  /** The layers' value here: Σ remaining × unit cost, the Warehouses Report's figure. */
  readonly valueIqd: string;
  /** valueIqd ÷ held, half up; '0' with nothing held. */
  readonly unitCostIqd: string;
}

export interface AvailabilityFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly warehouseCode?: string | null;
  readonly category?: string | null;
  readonly branchCode?: string | null;
  /** Only the rows that hold something available. */
  readonly inStock?: boolean;
}

export async function forScreen(tx: Tx, principal: Principal, filter: AvailabilityFilter = {}) {
  if (!can(principal, 'view', PERMISSION_OBJECT)) throw new PermissionDeniedError(principal.userId, 'view', PERMISSION_OBJECT);
  const parts = [
    principal.isSuperUser ? null : sql`app_branch_allowed(p.branch_code)`,
    filter.warehouseCode ? sql`p.warehouse_code = ${filter.warehouseCode}` : null,
    filter.category ? sql`i.category = ${filter.category}` : null,
    filter.branchCode ? sql`p.branch_code = ${filter.branchCode}` : null,
    filter.inStock ? sql`p.available > 0` : null,
    searchOf([sql`p.item_code`, sql`i.name`, sql`p.warehouse_code`, sql`w.name`], filter.search),
  ].filter((part): part is NonNullable<typeof part> => part !== null);
  const from = sql`from stock_position p
                   join item i on i.code = p.item_code
                   join warehouse w on w.code = p.warehouse_code
                   ${parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``}`;
  return registerPage<AvailabilityRow>({
    paging: filter,
    count: async () => {
      const result = await tx.execute(sql`select count(*)::int as n ${from}`);
      return Number((result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
    },
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select p.item_code as "itemCode", i.name as "itemName", i.category, i.base_uom_code as "baseUomCode",
               p.warehouse_code as "warehouseCode", w.name as "warehouseName", p.branch_code as "branchCode",
               p.on_hand::text as "onHand", p.available::text as "available", p.reserved::text as "reserved",
               p.in_transit::text as "inTransit", p.in_quarantine::text as "inQuarantine",
               p.damaged::text as "damaged", p.returns_stock::text as "returnsStock",
               coalesce((
                 select sum(greatest(l.quantity - coalesce(l.received_quantity, 0) - coalesce(l.closed_quantity, 0), 0)
                            * coalesce(u.conversion_numerator::numeric / nullif(u.conversion_denominator, 0), 1))
                   from purchase_order_line l
                   join purchase_order o on o.id = l.purchase_order_id
                   left join item_uom u on u.item_id = i.id and u.uom_code = l.uom_code
                  where l.item_code = p.item_code
                    and o.status in ('approved', 'partially_executed')
                    and (l.warehouse_code is null or l.warehouse_code = p.warehouse_code)), 0)::text as "onOrder",
               coalesce((select round(sum(cl.remaining_quantity * cl.unit_cost_iqd), 4) from cost_layer cl
                          where cl.item_code = p.item_code and cl.warehouse_code = p.warehouse_code and cl.remaining_quantity > 0), 0)::text as "valueIqd",
               case when p.held <> 0 then round(coalesce((select sum(cl.remaining_quantity * cl.unit_cost_iqd) from cost_layer cl
                          where cl.item_code = p.item_code and cl.warehouse_code = p.warehouse_code and cl.remaining_quantity > 0), 0) / p.held, 4)
                    else 0 end::text as "unitCostIqd"
          ${from}
         order by p.item_code, p.warehouse_code
         limit ${limit} offset ${offset}`);
      return (result as unknown as { rows: AvailabilityRow[] }).rows;
    },
  });
}

/** The categories the filter offers: those of the items that hold a position. */
export async function categories(tx: Tx, principal: Principal) {
  const result = await tx.execute(sql`
    select distinct i.category from stock_position p join item i on i.code = p.item_code
     where i.category is not null ${principal.isSuperUser ? sql`` : sql`and app_branch_allowed(p.branch_code)`}
     order by i.category`);
  return (result as unknown as { rows: { category: string }[] }).rows.map((row) => row.category);
}

/** The branches the reader may see positions in. */
export async function branches(tx: Tx, principal: Principal) {
  const result = await tx.execute(sql`
    select b.code, b.name from branch b
     where b.active ${principal.isSuperUser ? sql`` : sql`and app_branch_allowed(b.code)`}
     order by b.code`);
  return (result as unknown as { rows: { code: string; name: string }[] }).rows;
}

/** The warehouses the filter offers: those the person's rows can stand in. */
export async function warehouses(tx: Tx, principal: Principal) {
  const result = await tx.execute(sql`
    select w.code, w.name from warehouse w
     where w.active ${principal.isSuperUser ? sql`` : sql`and app_branch_allowed(w.branch_code)`}
     order by w.code`);
  return (result as unknown as { rows: { code: string; name: string }[] }).rows;
}

/** The items something can be issued from: those with stock available where the person may see it. */
export async function issuableItems(tx: Tx, principal: Principal) {
  const result = await tx.execute(sql`
    select distinct p.item_code as code, i.name
      from stock_position p join item i on i.code = p.item_code
     where p.available > 0 ${principal.isSuperUser ? sql`` : sql`and app_branch_allowed(p.branch_code)`}
     order by p.item_code`);
  return (result as unknown as { rows: { code: string; name: string }[] }).rows;
}
