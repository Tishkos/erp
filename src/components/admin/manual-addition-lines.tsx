'use client';

import { useMemo, useState } from 'react';
import styles from './admin.module.css';
import { IntentSelect } from '@/components/admin/intent-select';
import { MONEY_PLACES, QUANTITY_PLACES, scaled, toNumber, toText } from '@/lib/decimal';

/**
 * The lines of a Manual Stock Addition — the invoice sheet's grid for a
 * document that brings stock in by hand: Item, Unit, Quantity, Unit price
 * (IQD), Line value.
 *
 * The house design for document lines: no "Add line" to hunt for — the table
 * always carries one empty row at the foot, so choosing an item opens the
 * next row, and a row is dropped with the ✕ beside it. The unit is one of the
 * item's own units, its base unit first; what a unit holds in base units is
 * shown beside it, because stock is received in the base unit.
 *
 * The line value is not typed: it is the quantity times the price, worked out
 * in scaled integers (half up, as the server and the 0415 check round it), so
 * what is shown is what is saved.
 */

export interface AdditionItem {
  readonly code: string;
  readonly name: string;
  readonly baseUomCode: string;
  readonly units: readonly { readonly code: string; readonly numerator: string; readonly denominator: string }[];
}

export interface AdditionLineValue {
  readonly itemCode: string;
  readonly uomCode: string;
  readonly quantity: string;
  readonly unitCost: string;
}

interface Row extends AdditionLineValue {
  readonly key: string;
}

let seq = 0;
const blank = (): Row => {
  seq += 1;
  return { key: `m${seq}`, itemCode: '', uomCode: '', quantity: '', unitCost: '' };
};

const written = (row: Row) => row.itemCode !== '' || row.quantity.trim() !== '' || row.unitCost.trim() !== '';

/** Quantity × price at money's four places, half up — the server's own rounding. */
function valueOf(row: Row): bigint | null {
  const quantity = scaled(row.quantity, QUANTITY_PLACES);
  const price = scaled(row.unitCost, MONEY_PLACES);
  if (quantity === null || price === null || quantity <= 0n || price <= 0n) return null;
  const factor = 10n ** BigInt(QUANTITY_PLACES);
  return (quantity * price + factor / 2n) / factor;
}

export function ManualAdditionLines({
  items,
  initial = [],
  labels,
  locale,
}: {
  readonly items: readonly AdditionItem[];
  readonly initial?: readonly AdditionLineValue[];
  readonly labels: {
    readonly item: string;
    readonly chooseItem: string;
    readonly unit: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly lineValue: string;
    readonly remove: string;
    readonly total: string;
  };
  readonly locale: string;
}) {
  const byCode = useMemo(() => new Map(items.map((item) => [item.code, item])), [items]);
  const options = useMemo(() => items.map((item) => ({ value: item.code, label: `${item.code} · ${item.name}` })), [items]);
  const [rows, setRows] = useState<Row[]>(() => [
    ...initial.map((line) => {
      seq += 1;
      return { key: `m${seq}`, ...line };
    }),
    blank(),
  ]);

  const money = useMemo(
    () => new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en-US', { maximumFractionDigits: 4, minimumFractionDigits: 0 }),
    [locale],
  );

  /** Filling the last row opens the next; nothing else grows the grid. */
  const settle = (next: Row[]): Row[] => {
    const last = next[next.length - 1];
    if (!last) return [blank()];
    return written(last) ? [...next, blank()] : next;
  };

  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) => settle(current.map((row) => (row.key === key ? { ...row, ...change } : row))));

  const chooseItem = (key: string, itemCode: string) => {
    const item = byCode.get(itemCode);
    setRows((current) =>
      settle(
        current.map((row) =>
          row.key === key
            ? {
                ...row,
                itemCode,
                // A new item starts in its base unit; one of 1 is the likeliest quantity.
                uomCode: item?.baseUomCode ?? '',
                quantity: item && row.quantity.trim() === '' ? '1' : row.quantity,
              }
            : row,
        ),
      ),
    );
  };

  const drop = (key: string) => setRows((current) => settle(current.filter((row) => row.key !== key)));

  const unitLabel = (item: AdditionItem, unit: AdditionItem['units'][number]) =>
    unit.numerator === unit.denominator
      ? unit.code
      : `${unit.code} (${toText((BigInt(unit.numerator) * 1_000_000n) / BigInt(unit.denominator), 6)} ${item.baseUomCode})`;

  const total = rows.reduce((sum, row) => sum + (valueOf(row) ?? 0n), 0n);

  return (
    <>
      <div className={`${styles.sapTableWrap} ${styles.sapLineTableWrap}`}>
        <table aria-labelledby="manual-addition-lines-heading" className={`${styles.sapTable} ${styles.sapLineGrid}`}>
          <colgroup>
            <col className={styles.colIndex} />
            <col className={styles.colName} />
            <col className={styles.colDiscount} />
            <col className={styles.colQty} />
            <col className={styles.colPrice} />
            <col className={styles.colTotal} />
            <col className={styles.colRemove} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{labels.item}</th>
              <th scope="col">{labels.unit}</th>
              <th className={styles.sapNum} scope="col">
                {labels.quantity}
              </th>
              <th className={styles.sapNum} scope="col">
                {labels.unitPrice}
              </th>
              <th className={styles.sapNum} scope="col">
                {labels.lineValue}
              </th>
              <th aria-label={labels.remove} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const item = byCode.get(row.itemCode);
              const last = index === rows.length - 1;
              const value = valueOf(row);
              return (
                <tr className={last ? styles.sapEntryRow : undefined} data-line={index + 1} key={row.key}>
                  <td>
                    <bdi dir="ltr">{index + 1}</bdi>
                  </td>
                  <td className={styles.sapAccountCell}>
                    <IntentSelect
                      aria-label={`${labels.item} ${index + 1}`}
                      compact
                      emptyLabel={labels.chooseItem}
                      name={`item_code_${index}`}
                      onChange={(event) => chooseItem(row.key, event.target.value)}
                      options={options}
                      // The first row names an item, or there is nothing to add.
                      required={index === 0}
                      searchable
                      value={row.itemCode}
                    />
                  </td>
                  <td>
                    <IntentSelect
                      aria-label={`${labels.unit} ${index + 1}`}
                      compact
                      disabled={!item}
                      name={`uom_code_${index}`}
                      onChange={(event) => patch(row.key, { uomCode: event.target.value })}
                      value={row.uomCode || item?.baseUomCode || ''}
                    >
                      {item ? (
                        item.units.map((unit) => (
                          <option key={unit.code} value={unit.code}>
                            {unitLabel(item, unit)}
                          </option>
                        ))
                      ) : (
                        <option value="" />
                      )}
                    </IntentSelect>
                  </td>
                  <td className={styles.sapNum}>
                    <input
                      aria-label={`${labels.quantity} ${index + 1}`}
                      dir="ltr"
                      inputMode="decimal"
                      min={0}
                      name={`quantity_${index}`}
                      onChange={(event) => patch(row.key, { quantity: event.target.value })}
                      required={row.itemCode !== ''}
                      step="any"
                      type="number"
                      value={row.quantity}
                    />
                  </td>
                  <td className={styles.sapNum}>
                    <input
                      aria-label={`${labels.unitPrice} ${index + 1}`}
                      dir="ltr"
                      inputMode="decimal"
                      min={0}
                      name={`unit_cost_${index}`}
                      onChange={(event) => patch(row.key, { unitCost: event.target.value })}
                      required={row.itemCode !== ''}
                      step="any"
                      type="number"
                      value={row.unitCost}
                    />
                  </td>
                  {/* Not a field: the value is the line's own two numbers. */}
                  <td className={styles.sapNum}>
                    <output aria-label={`${labels.lineValue} ${index + 1}`} data-line-value="">
                      <bdi dir="ltr">{value === null ? '' : money.format(toNumber(value, MONEY_PLACES))}</bdi>
                    </output>
                  </td>
                  <td className={styles.sapRowRemove}>
                    {!last ? (
                      <button aria-label={labels.remove} onClick={() => drop(row.key)} title={labels.remove} type="button">
                        ✕
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={styles.sapTotalRow}>
              <td colSpan={5}>{labels.total}</td>
              <td aria-live="polite" className={styles.sapNum} data-total="">
                <bdi dir="ltr">{`${money.format(toNumber(total, MONEY_PLACES))} IQD`}</bdi>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {/* How many rows the action should read: the grid grows as it is typed. */}
      <input name="line_count" type="hidden" value={rows.length} />
    </>
  );
}
