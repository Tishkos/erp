/**
 * An item is bought only from a supplier linked to it (0408, 2026-10-06, by
 * direction: "an item needed to be linked to a supplier before buying"). A
 * fixture that buys an item links it first — through the owner, as the
 * fixtures write their master data, so no test depends on the Items screen.
 *
 *   await linkItemToSupplier('ITM-PANEL', supplierId);
 *   await linkItemsToSuppliers();   // every item to every supplier there is now
 *
 * The second is for suites whose subject is something else (a posting, a
 * landed cost, a print copy): the rule is proved in `pi01-purchase-invoice-
 * fixes.test.ts`, and a world of one item and one supplier buys as it did.
 */
import { ownerPool } from './setup';

/** Links one item (by code) to one supplier (by id, or by code), in use; the item's first link is its default. */
export async function linkItemToSupplier(
  itemCode: string,
  supplier: string,
  options: { readonly supplierItemCode?: string | null } = {},
): Promise<void> {
  const { rowCount } = await ownerPool.query(
    `insert into item_supplier (item_id, supplier_id, supplier_item_code, is_default, active)
     select i.id, bp.id, $3,
            not exists (select 1 from item_supplier d where d.item_id = i.id and d.is_default),
            true
       from item i
       join business_partner bp on bp.id::text = $2 or bp.code = $2
      where i.code = $1
     on conflict (item_id, supplier_id) do update
       set active = true, deactivated_reason = null, deactivated_at = null, deactivated_by = null,
           supplier_item_code = coalesce(excluded.supplier_item_code, item_supplier.supplier_item_code)`,
    [itemCode, supplier, options.supplierItemCode ?? null],
  );
  if (!rowCount) throw new Error(`linkItemToSupplier: no item '${itemCode}' or no supplier '${supplier}'.`);
}

/**
 * Links every item to every partner holding the supplier role, as they stand
 * now — call it once the fixture's items and suppliers exist, before the first
 * purchase. Links already there are left as they are.
 */
export async function linkItemsToSuppliers(): Promise<void> {
  await ownerPool.query(
    `insert into item_supplier (item_id, supplier_id, is_default, active)
     select i.id, bp.id, false, true
       from item i
       cross join business_partner bp
      where bp.is_supplier
     on conflict (item_id, supplier_id) do nothing`,
  );
  // An item with suppliers has a default (the Items screen keeps one): the first by code.
  await ownerPool.query(
    `update item_supplier s set is_default = true
       from (select distinct on (s2.item_id) s2.item_id, s2.supplier_id
               from item_supplier s2
               join business_partner bp on bp.id = s2.supplier_id
              where s2.active
                and not exists (select 1 from item_supplier d where d.item_id = s2.item_id and d.is_default)
              order by s2.item_id, bp.code) pick
      where s.item_id = pick.item_id and s.supplier_id = pick.supplier_id`,
  );
}
