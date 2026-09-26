'use client';

import { useId, useMemo, useState } from 'react';
import styles from './admin.module.css';
import { ColumnGrip, useColumnWidths } from './column-widths';

/**
 * The lines of an Opening Stock document — Operations build, block 7:
 * Item Name, Item Code, Quantity, Total Price and Average Unit Price.
 *
 * The same grid as an invoice's, because it is the same act: the house design
 * for document lines. There is no "Add line" — the table always carries one
 * empty row at the foot, so filling the current line opens the next one, and a
 * person keeps going until they stop. A row is dropped with the ✕ beside it.
 * The boundaries drag, and where they are put is remembered.
 *
 * Either box finds the item: a person holding a code types the code, a person
 * holding a name types the name, and each fills the other.
 *
 * The Average Unit Price is not typed. It is the Total Price over the Quantity,
 * shown as the row is filled, and the server works it out again from the same
 * two figures — so what is shown is what is saved.
 */

export interface OpeningStockItem {
  readonly code: string;
  readonly name: string;
  readonly uomCode?: string | null;
}

const COLUMN_KEYS = ['index', 'code', 'name', 'qty', 'total', 'average', 'remove'] as const;
type ColumnKey = (typeof COLUMN_KEYS)[number];

interface Row {
  readonly key: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly quantity: string;
  readonly total: string;
}

let seq = 0;
const blank = (): Row => {
  seq += 1;
  return { key: `l${seq}`, itemCode: '', itemName: '', quantity: '', total: '' };
};

/** A row worth carrying to the server: it names something. */
const written = (row: Row) =>
  row.itemCode.trim() !== '' || row.itemName.trim() !== '' || row.quantity.trim() !== '' || row.total.trim() !== '';

export function OpeningStockLines({
  items,
  labels,
  widthsKey,
}: {
  readonly items: readonly OpeningStockItem[];
  readonly labels: {
    readonly itemCode: string;
    readonly itemName: string;
    readonly quantity: string;
    readonly total: string;
    readonly average: string;
    readonly remove: string;
    readonly resizeColumn: string;
    readonly documentTotal: string;
  };
  readonly widthsKey?: string;
}) {
  // From React, not a random: the server renders this table too, and two
  // different ids would be a hydration mismatch.
  const codeList = useId();
  const nameList = useId();
  const byCode = useMemo(() => new Map(items.map((item) => [item.code, item])), [items]);
  const byName = useMemo(() => new Map(items.map((item) => [item.name, item])), [items]);

  const [rows, setRows] = useState<Row[]>([blank()]);
  const { widthOf, gripProps, resizing } = useColumnWidths<ColumnKey>(COLUMN_KEYS, widthsKey);

  /** Filling the last row opens the next; nothing else grows the grid. */
  const settle = (next: Row[]): Row[] => {
    const last = next[next.length - 1];
    if (!last) return [blank()];
    return written(last) ? [...next, blank()] : next;
  };

  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) =>
      settle(current.map((row) => (row.key === key ? { ...row, ...change } : row))),
    );

  const chooseByCode = (key: string, itemCode: string) => {
    const match = byCode.get(itemCode);
    patch(key, { itemCode, ...(match ? { itemName: match.name } : {}) });
  };

  const chooseByName = (key: string, itemName: string) => {
    const match = byName.get(itemName);
    patch(key, { itemName, ...(match ? { itemCode: match.code } : {}) });
  };

  const drop = (key: string) =>
    setRows((current) => settle(current.filter((row) => row.key !== key)));

  const averageOf = (row: Row) => {
    const quantity = Number(row.quantity);
    const total = Number(row.total);
    if (!row.quantity || !row.total || !Number.isFinite(quantity) || quantity <= 0) return '';
    return (total / quantity).toLocaleString('en-US', { maximumFractionDigits: 4 });
  };

  const documentTotal = rows.reduce((sum, row) => {
    const value = Number(row.total);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);

  return (
    <>
      <div className={`${styles.sapTableWrap} ${styles.sapLineTableWrap}`}>
        <table
          className={`${styles.sapTable} ${styles.sapLineGrid} ${styles.sapLineGridCompact}`}
          data-resizing={resizing ? 'true' : undefined}
        >
          {/* Declared, not discovered — see the invoice grid. */}
          <colgroup>
            <col className={styles.colIndex} style={widthOf('index')} />
            <col className={styles.colCode} style={widthOf('code')} />
            <col className={styles.colName} style={widthOf('name')} />
            <col className={styles.colQty} style={widthOf('qty')} />
            <col className={styles.colTotal} style={widthOf('total')} />
            <col className={styles.colAverage} style={widthOf('average')} />
            <col className={styles.colRemove} style={widthOf('remove')} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">
                {labels.itemCode}
                <ColumnGrip label={labels.resizeColumn} resizing={resizing} {...gripProps('code')} />
              </th>
              <th scope="col">
                {labels.itemName}
                <ColumnGrip label={labels.resizeColumn} resizing={resizing} {...gripProps('name')} />
              </th>
              <th className={styles.sapNum} scope="col">
                {labels.quantity}
                <ColumnGrip label={labels.resizeColumn} resizing={resizing} {...gripProps('qty')} />
              </th>
              <th className={styles.sapNum} scope="col">
                {labels.total}
                <ColumnGrip label={labels.resizeColumn} resizing={resizing} {...gripProps('total')} />
              </th>
              <th className={styles.sapNum} scope="col">
                {labels.average}
                <ColumnGrip
                  label={labels.resizeColumn}
                  resizing={resizing}
                  {...gripProps('average')}
                />
              </th>
              <th aria-label={labels.remove} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const last = index === rows.length - 1;
              return (
                <tr className={last ? styles.sapEntryRow : undefined} key={row.key}>
                  <td>
                    <bdi dir="ltr">{index + 1}</bdi>
                  </td>
                  <td className={styles.sapAccountCell}>
                    <input
                      aria-label={labels.itemCode}
                      autoComplete="off"
                      dir="ltr"
                      list={codeList}
                      name={`item_code_${index}`}
                      onChange={(event) => chooseByCode(row.key, event.target.value)}
                      // An opening stock document counts something: the first
                      // row names an item or there is nothing to bring in.
                      required={index === 0}
                      value={row.itemCode}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={labels.itemName}
                      autoComplete="off"
                      dir="auto"
                      list={nameList}
                      onChange={(event) => chooseByName(row.key, event.target.value)}
                      value={row.itemName}
                    />
                  </td>
                  <td className={styles.sapNum}>
                    <input
                      aria-label={labels.quantity}
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
                      aria-label={labels.total}
                      dir="ltr"
                      inputMode="decimal"
                      min={0}
                      name={`total_${index}`}
                      onChange={(event) => patch(row.key, { total: event.target.value })}
                      required={row.itemCode !== ''}
                      step="any"
                      type="number"
                      value={row.total}
                    />
                  </td>
                  {/* Not a field: the average is its own two numbers, and a
                      third box holding the answer is a box that can disagree. */}
                  <td className={styles.sapNum}>
                    <output aria-label={labels.average}>
                      <bdi dir="ltr">{averageOf(row)}</bdi>
                    </output>
                  </td>
                  <td className={styles.sapRowRemove}>
                    {rows.length > 1 && !last ? (
                      <button
                        aria-label={labels.remove}
                        onClick={() => drop(row.key)}
                        title={labels.remove}
                        type="button"
                      >
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
              <td colSpan={4}>{labels.documentTotal}</td>
              <td className={styles.sapNum}>
                <bdi dir="ltr">
                  {documentTotal.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                </bdi>
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <datalist id={codeList}>
        {items.map((item) => (
          <option key={item.code} value={item.code} />
        ))}
      </datalist>
      <datalist id={nameList}>
        {items.map((item) => (
          <option key={item.code} value={item.name} />
        ))}
      </datalist>

      {/* How many rows the action should read. The grid grows as it is typed,
          so the number cannot be a constant the two sides agree on in advance. */}
      <input name="line_count" type="hidden" value={rows.length} />
    </>
  );
}
