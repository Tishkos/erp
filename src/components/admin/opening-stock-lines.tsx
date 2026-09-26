'use client';

import { useState } from 'react';
import { PairedPicker, type PairedOption } from './paired-picker';

/**
 * The lines of an Opening Stock document — Operations build, block 7:
 * Item Name, Item Code, Quantity, Total Price and Average Unit Price.
 *
 * The Average Unit Price is not typed. It is the Total Price over the
 * Quantity, shown as the row is filled, and the server works it out again
 * from the same two figures — so what is shown is what is saved.
 */
export function OpeningStockLines({
  rows,
  items,
  labels,
}: {
  readonly rows: number;
  readonly items: readonly PairedOption[];
  readonly labels: {
    readonly itemCode: string;
    readonly itemName: string;
    readonly quantity: string;
    readonly total: string;
    readonly average: string;
  };
}) {
  const [figures, setFigures] = useState<{ quantity: string; total: string }[]>(
    Array.from({ length: rows }, () => ({ quantity: '', total: '' })),
  );

  const set = (row: number, key: 'quantity' | 'total', value: string) =>
    setFigures((current) =>
      current.map((entry, index) => (index === row ? { ...entry, [key]: value } : entry)),
    );

  const averageOf = (entry: { quantity: string; total: string }) => {
    const quantity = Number(entry.quantity);
    const total = Number(entry.total);
    if (!entry.quantity || !entry.total || !Number.isFinite(quantity) || quantity <= 0) return '';
    return (total / quantity).toLocaleString('en-US', { maximumFractionDigits: 4 });
  };

  return (
    <div className="table-wrap">
      <table className="list">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{`${labels.itemCode} / ${labels.itemName}`}</th>
            <th scope="col">{labels.quantity}</th>
            <th scope="col">{labels.total}</th>
            <th scope="col">{labels.average}</th>
          </tr>
        </thead>
        <tbody>
          {figures.map((entry, row) => (
            <tr key={row}>
              <td>{row + 1}</td>
              <td>
                <PairedPicker
                  codeLabel={labels.itemCode}
                  name={`item_code_${row}`}
                  nameLabel={labels.itemName}
                  options={items}
                  plain
                />
              </td>
              <td>
                <input
                  aria-label={`${labels.quantity} ${row + 1}`}
                  min={0}
                  name={`quantity_${row}`}
                  onChange={(event) => set(row, 'quantity', event.target.value)}
                  step="any"
                  type="number"
                  value={entry.quantity}
                />
              </td>
              <td>
                <input
                  aria-label={`${labels.total} ${row + 1}`}
                  min={0}
                  name={`total_${row}`}
                  onChange={(event) => set(row, 'total', event.target.value)}
                  step="any"
                  type="number"
                  value={entry.total}
                />
              </td>
              <td>
                <output aria-label={`${labels.average} ${row + 1}`}>
                  <bdi dir="ltr">{averageOf(entry)}</bdi>
                </output>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
