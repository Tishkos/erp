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
}

export interface AvailabilityFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly warehouseCode?: string | null;
  /** Only the rows that hold something available. */
  readonly inStock?: boolean;
}

export async function forScreen(tx: Tx, principal: Principal, filter: AvailabilityFilter = {}) {
  if (!can(principal, 'view', PERMISSION_OBJECT)) throw new PermissionDeniedError(principal.userId, 'view', PERMISSION_OBJECT);
  const parts = [
    principal.isSuperUser ? null : sql`app_branch_allowed(p.branch_code)`,
    filter.warehouseCode ? sql`p.warehouse_code = ${filter.warehouseCode}` : null,
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
        select p.item_code as "itemCode", i.name as "itemName", i.base_uom_code as "baseUomCode",
               p.warehouse_code as "warehouseCode", w.name as "warehouseName", p.branch_code as "branchCode",
               p.on_hand::text as "onHand", p.available::text as "available", p.reserved::text as "reserved",
               p.in_transit::text as "inTransit", p.in_quarantine::text as "inQuarantine",
               p.damaged::text as "damaged", p.returns_stock::text as "returnsStock"
          ${from}
         order by p.item_code, p.warehouse_code
         limit ${limit} offset ${offset}`);
      return (result as unknown as { rows: AvailabilityRow[] }).rows;
    },
  });
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
