'use client';

import { useState } from 'react';

/**
 * The Sales Invoice line grid — Operations build, block 5.
 *
 *   Supplier   "When an item is selected, the supplier field shows the
 *              supplier(s) linked to that item. The same item can be entered on
 *              separate invoice lines under different suppliers when required."
 *
 * That second sentence is why the supplier belongs on the line rather than the
 * header, and why each row keeps its own choice: the same panel bought from two
 * suppliers is two pools of stock with two costs, and a sale has to say which
 * it is drawing from.
 *
 * A client island, because the supplier list has to change when the item does
 * and a server round trip per keystroke would be worse. Everything it enforces
 * is enforced again in the service — choosing a supplier the item is not linked
 * to is refused there, not only here.
 */
export interface ItemOption {
  readonly code: string;
  readonly name: string;
  /** Empty when the item has no supplier links; the line then sells any stock. */
  readonly suppliers: readonly { readonly id: string; readonly label: string }[];
}

export function SalesLines({
  rows,
  items,
  warehouses,
  labels,
}: {
  readonly rows: number;
  readonly items: readonly ItemOption[];
  readonly warehouses: readonly { readonly code: string; readonly name: string }[];
  readonly labels: {
    readonly itemCode: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly discount: string;
    readonly supplier: string;
    readonly warehouse: string;
    readonly anySupplier: string;
  };
}) {
  const [chosen, setChosen] = useState<readonly string[]>(() => Array.from({ length: rows }, () => ''));

  const suppliersFor = (itemCode: string) =>
    items.find((item) => item.code === itemCode)?.suppliers ?? [];

  return (
    <tbody>
      {Array.from({ length: rows }, (_, row) => {
        const suppliers = suppliersFor(chosen[row] ?? '');
        return (
          <tr key={row}>
            <td>
              <select
                aria-label={labels.itemCode}
                className="field__input"
                name={`item_code_${row}`}
                onChange={(event) =>
                  setChosen((previous) =>
                    previous.map((value, index) => (index === row ? event.target.value : value)),
                  )
                }
                value={chosen[row] ?? ''}
              >
                <option value="" />
                {items.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <input
                aria-label={labels.quantity}
                className="field__input"
                inputMode="decimal"
                name={`quantity_${row}`}
              />
            </td>
            <td>
              <input
                aria-label={labels.unitPrice}
                className="field__input"
                inputMode="decimal"
                name={`unit_price_${row}`}
              />
            </td>
            <td>
              <input
                aria-label={labels.discount}
                className="field__input"
                inputMode="decimal"
                name={`discount_${row}`}
              />
            </td>
            <td>
              <select
                aria-label={labels.supplier}
                className="field__input"
                // Disabled rather than hidden when the item has no links: the
                // column stays where the eye expects it, and the reason it is
                // empty is the item, not a fault.
                disabled={suppliers.length === 0}
                name={`supplier_id_${row}`}
              >
                {/* Blank is a real choice — the oldest stock of any supplier. */}
                <option value="">{labels.anySupplier}</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.label}
                  </option>
                ))}
              </select>
            </td>
            <td>
              <select
                aria-label={labels.warehouse}
                className="field__input"
                defaultValue={warehouses[0]?.code ?? ''}
                name={`warehouse_code_${row}`}
              >
                {warehouses.map((house) => (
                  <option key={house.code} value={house.code}>
                    {house.code} · {house.name}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}
