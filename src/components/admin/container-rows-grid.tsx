'use client';

import { useState, type ClipboardEvent } from 'react';
import styles from './admin.module.css';
import { QUANTITY_PLACES, scaled, toNumber } from '@/lib/decimal';
import { checkDigitFor, compactContainerNo, isContainerShape } from '@/lib/container-number';

/**
 * The containers of a B/L, typed as the B/L lists them — IMPROVEMENT-002
 * (sponsor, 2026-10-03: "container should be a table, not separated by
 * commas … write the quantity of each container, or divide it automatically,
 * and never more than the quantity entered").
 *
 * The house grid for lines: no "Add", one empty row at the foot, filling a row
 * opens the next, ✕ drops one. Each row is a container: its number (checked
 * against ISO 6346 as it is typed — the service refuses a wrong one all the
 * same), its own size/type and seal, and what it carries of each model of the
 * import. A model's column left empty everywhere is divided equally by the
 * server; the foot says, model by model, what is typed against what is left to
 * ship. Pasting several numbers into one box fills a row each.
 */

export interface GridModel {
  /** The order line's id — what the server plans against. */
  readonly key: string;
  readonly label: string;
  readonly unit: string | null;
  /** What is left to put in a container, as a plain decimal. */
  readonly left: string;
}

interface Row {
  readonly key: string;
  readonly containerNo: string;
  readonly sizeType: string;
  readonly sealNo: string;
  readonly quantities: Readonly<Record<string, string>>;
}

let seq = 0;
const blank = (): Row => {
  seq += 1;
  return { key: `c${seq}`, containerNo: '', sizeType: '', sealNo: '', quantities: {} };
};

const written = (row: Row) =>
  row.containerNo.trim() !== '' || row.sealNo.trim() !== '' || Object.values(row.quantities).some((value) => value.trim() !== '');

/** What is wrong with a typed number, in the screen's words — or nothing. */
function numberProblem(value: string, labels: { notANumber: string; checkDigit: string }): string | null {
  const number = compactContainerNo(value);
  if (!number) return null;
  if (!isContainerShape(number)) return labels.notANumber;
  const digit = checkDigitFor(number.slice(0, 10));
  return digit !== null && digit !== Number(number[10]) ? labels.checkDigit.replace('{digit}', String(digit)) : null;
}

export function ContainerRowsGrid({
  models,
  sizeTypes,
  labels,
}: {
  readonly models: readonly GridModel[];
  readonly sizeTypes: readonly { readonly code: string; readonly label: string }[];
  readonly labels: {
    readonly containerNo: string;
    readonly sizeType: string;
    readonly sealNo: string;
    readonly remove: string;
    readonly left: string;
    readonly typed: string;
    readonly divided: string;
    readonly tooMany: string;
    readonly notANumber: string;
    readonly checkDigit: string;
  };
}) {
  const [rows, setRows] = useState<Row[]>([blank()]);

  const settle = (next: Row[]): Row[] => {
    const last = next[next.length - 1];
    if (!last) return [blank()];
    return written(last) ? [...next, blank()] : next;
  };
  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) => settle(current.map((row) => (row.key === key ? { ...row, ...change } : row))));
  const setQuantity = (key: string, model: string, value: string) =>
    setRows((current) =>
      settle(current.map((row) => (row.key === key ? { ...row, quantities: { ...row.quantities, [model]: value } } : row))),
    );
  const drop = (key: string) => setRows((current) => settle(current.filter((row) => row.key !== key)));

  /** Several numbers pasted into one box: a row each, from this row on. */
  const paste = (key: string, event: ClipboardEvent<HTMLInputElement>) => {
    const pieces = event.clipboardData
      .getData('text')
      .split(/[\n,;\t]+|\s{2,}/)
      .map((piece) => compactContainerNo(piece))
      .filter(Boolean);
    if (pieces.length < 2) return;
    event.preventDefault();
    setRows((current) => {
      const at = current.findIndex((row) => row.key === key);
      const filled = pieces.map((number, offset) =>
        offset === 0 ? { ...current[at]!, containerNo: number } : { ...blank(), containerNo: number },
      );
      return settle([...current.slice(0, at), ...filled, ...current.slice(at + 1).filter(written)]);
    });
  };

  const live = rows.filter(written);
  const totals = models.map((model) => {
    const values = live.map((row) => row.quantities[model.key]?.trim() ?? '');
    const typed = values.some((value) => value !== '');
    const sum = values.reduce((total, value) => total + (scaled(value, QUANTITY_PLACES) ?? 0n), 0n);
    const left = scaled(model.left, QUANTITY_PLACES) ?? 0n;
    return { typed, sum, left, over: typed && sum > left };
  });
  const show = (value: bigint) => toNumber(value, QUANTITY_PLACES).toLocaleString('en-US', { maximumFractionDigits: QUANTITY_PLACES });

  return (
    <>
      <div className={`${styles.sapTableWrap} ${styles.sapLineTableWrap}`}>
        <table className={`${styles.sapTable} ${styles.sapLineGrid} ${styles.sapLineGridCompact}`}>
          <colgroup>
            <col className={styles.colIndex} />
            <col className={styles.colSupplier} />
            <col className={styles.colWarehouse} />
            <col className={styles.colCode} />
            {models.map((model) => (
              <col className={styles.colQty} key={model.key} />
            ))}
            <col className={styles.colRemove} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{labels.containerNo}</th>
              <th scope="col">{labels.sizeType}</th>
              <th scope="col">{labels.sealNo}</th>
              {models.map((model) => (
                <th className={styles.sapNum} key={model.key} scope="col" title={model.label}>
                  <bdi dir="auto">{model.label}</bdi>
                  {model.unit ? <> ({model.unit})</> : null}
                </th>
              ))}
              <th aria-label={labels.remove} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const last = index === rows.length - 1;
              const problem = numberProblem(row.containerNo, labels);
              return (
                <tr className={last ? styles.sapEntryRow : undefined} key={row.key}>
                  <td>
                    <bdi dir="ltr">{index + 1}</bdi>
                  </td>
                  <td>
                    <input
                      aria-invalid={problem ? 'true' : undefined}
                      aria-label={`${labels.containerNo} ${index + 1}`}
                      autoComplete="off"
                      dir="ltr"
                      name={`container_no_${index}`}
                      onChange={(event) => patch(row.key, { containerNo: event.target.value.toUpperCase() })}
                      onPaste={(event) => paste(row.key, event)}
                      required={index === 0}
                      value={row.containerNo}
                    />
                    {problem ? <span className={styles.sapRowError}>{problem}</span> : null}
                  </td>
                  <td>
                    <select
                      aria-label={`${labels.sizeType} ${index + 1}`}
                      name={`size_type_${index}`}
                      onChange={(event) => patch(row.key, { sizeType: event.target.value })}
                      value={row.sizeType}
                    >
                      <option value="">—</option>
                      {sizeTypes.map((type) => (
                        <option key={type.code} value={type.code}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      aria-label={`${labels.sealNo} ${index + 1}`}
                      autoComplete="off"
                      dir="ltr"
                      name={`seal_no_${index}`}
                      onChange={(event) => patch(row.key, { sealNo: event.target.value })}
                      value={row.sealNo}
                    />
                  </td>
                  {models.map((model, m) => (
                    <td className={styles.sapNum} key={model.key}>
                      <input
                        aria-label={`${model.label} ${index + 1}`}
                        dir="ltr"
                        inputMode="decimal"
                        min={0}
                        name={`qty_${index}_${m}`}
                        onChange={(event) => setQuantity(row.key, model.key, event.target.value)}
                        placeholder={totals[m]!.typed ? '0' : labels.divided}
                        step="any"
                        type="number"
                        value={row.quantities[model.key] ?? ''}
                      />
                    </td>
                  ))}
                  <td className={styles.sapRowRemove}>
                    {rows.length > 1 && !last ? (
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
              <td colSpan={4}>{labels.typed}</td>
              {totals.map((total, m) => (
                <td className={styles.sapNum} key={models[m]!.key}>
                  <bdi dir="ltr">{total.typed ? show(total.sum) : labels.divided}</bdi>
                  {total.over ? (
                    <span className={styles.sapRowError}>{labels.tooMany.replace('{left}', show(total.left))}</span>
                  ) : (
                    <div className="muted">
                      {labels.left} <bdi dir="ltr">{show(total.left)}</bdi>
                    </div>
                  )}
                </td>
              ))}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <input name="row_count" type="hidden" value={rows.length} />
      <input name="model_count" type="hidden" value={models.length} />
      {models.map((model, m) => (
        <input key={model.key} name={`model_${m}`} type="hidden" value={model.key} />
      ))}
    </>
  );
}
