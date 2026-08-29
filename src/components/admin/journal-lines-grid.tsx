'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import styles from './admin.module.css';

/**
 * The lines of a draft journal, typed straight into the grid.
 *
 * By direction (2026-08-29): there is no "Add line". The table is live — a
 * person fills the last row, moves to the next, and keeps going. A row is
 * saved the moment it is complete and left (an account and one amount), a
 * saved row is changed in place when a cell is edited, and the totals are
 * summed from what is on screen as it is typed, so the entry says whether it
 * balances *now* rather than after a round trip.
 *
 * The server is still the authority: every save runs the same domain rules,
 * and a refusal is shown on the row it concerns. The IQD and USD reporting
 * figures are the server's too — they come back on the refresh that follows
 * a save, because the rate is not this component's to know (§14.3).
 */

export interface GridAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string | null;
}

export interface GridDepartment {
  readonly code: string;
  readonly name: string;
}

export interface GridLine {
  readonly id: string;
  readonly lineNo: number;
  readonly accountId: string;
  readonly description: string;
  readonly departmentCode: string;
  readonly debit: string;
  readonly credit: string;
  readonly currency: string;
}

export interface GridLabels {
  readonly account: string;
  readonly note: string;
  readonly department: string;
  readonly debit: string;
  readonly credit: string;
  readonly total: string;
  readonly remove: string;
  readonly chooseAccount: string;
  readonly saving: string;
  readonly balanced: string;
  readonly outOfBalance: string;
  readonly difference: string;
}

interface Row {
  /** A saved line's id, or null while the row is only on screen. */
  readonly lineId: string | null;
  readonly key: string;
  accountId: string;
  description: string;
  departmentCode: string;
  debit: string;
  credit: string;
  /** Why the server refused it, shown on the row. */
  error: string | null;
  /** Something changed since it was last saved. */
  dirty: boolean;
  /** A new row the server has accepted; its own copy arrives on the next refresh. */
  settled: boolean;
}

interface Outcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** Empty rows drawn under the lines, the way the grid draws room still to fill. */
const FILLER_ROWS = 2;

const fromLine = (line: GridLine): Row => ({
  lineId: line.id,
  key: line.id,
  accountId: line.accountId,
  description: line.description,
  departmentCode: line.departmentCode,
  debit: Number(line.debit) === 0 ? '' : trimZeros(line.debit),
  credit: Number(line.credit) === 0 ? '' : trimZeros(line.credit),
  error: null,
  dirty: false,
  settled: false,
});

let blankCounter = 0;
const blank = (departmentCode: string): Row => ({
  lineId: null,
  key: `new-${(blankCounter += 1)}`,
  accountId: '',
  description: '',
  departmentCode,
  debit: '',
  credit: '',
  error: null,
  dirty: false,
  settled: false,
});

/** "2400.0000" reads as 2400; a person did not type the zeros. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** Sums what is typed, in minor units, so 0.1 + 0.2 is what it should be. */
function sumOf(rows: readonly Row[], side: 'debit' | 'credit'): bigint {
  let total = 0n;
  for (const row of rows) {
    const value = row[side].trim();
    if (!value || Number.isNaN(Number(value))) continue;
    const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
    total += BigInt(`${whole}${fraction.padEnd(2, '0').slice(0, 2)}`);
  }
  return total;
}

export function JournalLinesGrid({
  journalId,
  entryNo,
  lines,
  accounts,
  departments,
  labels,
  currency,
  locale,
  save,
  remove,
}: {
  readonly journalId: string;
  readonly entryNo: string;
  readonly lines: readonly GridLine[];
  readonly accounts: readonly GridAccount[];
  readonly departments: readonly GridDepartment[];
  readonly labels: GridLabels;
  /** The ledger currency the totals are stated in. */
  readonly currency: string;
  readonly locale: string;
  readonly save: (formData: FormData) => Promise<Outcome>;
  readonly remove: (formData: FormData) => Promise<Outcome>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const defaultDepartment = departments[0]?.code ?? '';
  const [rows, setRows] = useState<Row[]>(() => [
    ...lines.map(fromLine),
    blank(defaultDepartment),
  ]);
  // Rows in flight: a second save of the same row waits for the first.
  const saving = useRef(new Set<string>());

  // When the server's lines change (a save landed, a line was removed), take
  // its version of every saved row that is not mid-edit, and keep whatever is
  // still being typed. A new row the server has just accepted is dropped
  // here: its own copy is in `lines` now.
  useEffect(() => {
    setRows((current) => {
      const local = new Map(current.filter((r) => r.lineId).map((r) => [r.lineId!, r]));
      const saved = lines.map((line) => {
        const mine = local.get(line.id);
        return mine && mine.dirty ? mine : fromLine(line);
      });
      const unsaved = current.filter((row) => row.lineId === null && !row.settled);
      return [...saved, ...(unsaved.length > 0 ? unsaved : [blank(defaultDepartment)])];
    });
  }, [lines, defaultDepartment]);

  const money = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'code',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [locale, currency],
  );
  const format = (minor: bigint) => money.format(Number(minor) / 100);

  const totalDebit = sumOf(rows, 'debit');
  const totalCredit = sumOf(rows, 'credit');
  const balanced = totalDebit === totalCredit;
  const difference = totalDebit > totalCredit ? totalDebit - totalCredit : totalCredit - totalDebit;

  const patch = (key: string, change: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...change, dirty: true, error: null } : row)),
    );

  /** A row is complete when it names an account and carries one amount. */
  const complete = (row: Row) =>
    row.accountId !== '' && (row.debit.trim() !== '') !== (row.credit.trim() !== '');

  const commit = (row: Row) => {
    if (!row.dirty || !complete(row) || saving.current.has(row.key)) return;
    saving.current.add(row.key);
    const form = new FormData();
    form.set('id', journalId);
    form.set('entryNo', entryNo);
    if (row.lineId) form.set('lineId', row.lineId);
    form.set('accountId', row.accountId);
    form.set('description', row.description);
    form.set('departmentCode', row.departmentCode);
    form.set('debit', row.debit.trim());
    form.set('credit', row.credit.trim());
    startTransition(async () => {
      const outcome = await save(form);
      saving.current.delete(row.key);
      if (outcome.ok) {
        setRows((current) =>
          current.map((r) =>
            r.key === row.key ? { ...r, dirty: false, error: null, settled: r.lineId === null } : r,
          ),
        );
        router.refresh();
      } else {
        setRows((current) =>
          current.map((r) => (r.key === row.key ? { ...r, error: outcome.error ?? '' } : r)),
        );
      }
    });
  };

  const drop = (row: Row) => {
    if (row.lineId === null) {
      setRows((current) => {
        const rest = current.filter((r) => r.key !== row.key);
        return rest.some((r) => r.lineId === null) ? rest : [...rest, blank(defaultDepartment)];
      });
      return;
    }
    const form = new FormData();
    form.set('id', journalId);
    form.set('entryNo', entryNo);
    form.set('lineId', row.lineId);
    startTransition(async () => {
      const outcome = await remove(form);
      if (outcome.ok) router.refresh();
      else patch(row.key, { error: outcome.error ?? '' });
    });
  };

  /** Leaving a row saves it; filling the last row opens another beneath it. */
  const leave = (row: Row) => {
    commit(row);
    setRows((current) => {
      const last = current[current.length - 1];
      return last && (last.accountId || last.debit || last.credit) ? [...current, blank(defaultDepartment)] : current;
    });
  };

  // Typing a debit clears the credit and the other way round: a line carries
  // one side, and the person is choosing it by where they type.
  const amount = (row: Row, side: 'debit' | 'credit', value: string) =>
    patch(row.key, side === 'debit' ? { debit: value, credit: value ? '' : row.credit } : { credit: value, debit: value ? '' : row.debit });

  const accountLabel = (a: GridAccount) => (a.currency && a.currency !== currency ? `${a.code} · ${a.name} · ${a.currency}` : `${a.code} · ${a.name}`);

  return (
    <>
      <div className={`${styles.sapTableWrap} ${styles.sapLineTableWrap}`}>
        <table aria-labelledby="journal-lines-heading" className={styles.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{labels.account}</th>
              <th scope="col">{labels.note}</th>
              <th scope="col">{labels.department}</th>
              <th className={styles.sapNum} scope="col">
                {labels.debit}
              </th>
              <th className={styles.sapNum} scope="col">
                {labels.credit}
              </th>
              <th aria-label={labels.remove} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                className={row.lineId === null ? styles.sapEntryRow : undefined}
                data-error={row.error ? 'true' : undefined}
                key={row.key}
                onBlur={(event) => {
                  // Only when focus leaves the row altogether, not when it
                  // moves from one cell of it to the next.
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) leave(row);
                }}
              >
                <td>
                  <bdi dir="ltr">{index + 1}</bdi>
                </td>
                <td>
                  <select
                    aria-label={labels.account}
                    dir="auto"
                    onChange={(event) => patch(row.key, { accountId: event.target.value })}
                    value={row.accountId}
                  >
                    <option value="">{labels.chooseAccount}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {accountLabel(a)}
                      </option>
                    ))}
                  </select>
                  {row.error ? (
                    <span className={styles.sapRowError} role="alert">
                      {row.error}
                    </span>
                  ) : null}
                </td>
                <td>
                  <input
                    aria-label={labels.note}
                    autoComplete="off"
                    onChange={(event) => patch(row.key, { description: event.target.value })}
                    type="text"
                    value={row.description}
                  />
                </td>
                <td>
                  <select
                    aria-label={labels.department}
                    dir="auto"
                    onChange={(event) => patch(row.key, { departmentCode: event.target.value })}
                    value={row.departmentCode}
                  >
                    {departments.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.code} · {d.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={labels.debit}
                    dir="ltr"
                    inputMode="decimal"
                    min={0}
                    onChange={(event) => amount(row, 'debit', event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    step="0.01"
                    type="number"
                    value={row.debit}
                  />
                </td>
                <td>
                  <input
                    aria-label={labels.credit}
                    dir="ltr"
                    inputMode="decimal"
                    min={0}
                    onChange={(event) => amount(row, 'credit', event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    step="0.01"
                    type="number"
                    value={row.credit}
                  />
                </td>
                <td className={styles.sapRowRemove}>
                  {row.accountId || row.debit || row.credit || row.lineId ? (
                    <button
                      aria-label={labels.remove}
                      onClick={() => drop(row)}
                      title={labels.remove}
                      type="button"
                    >
                      ✕
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {Array.from({ length: FILLER_ROWS }, (_, i) => (
              <tr aria-hidden="true" className={styles.sapFiller} key={`filler-${i}`}>
                {Array.from({ length: 7 }, (_, cell) => (
                  <td key={cell} />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={styles.sapTotalRow}>
              <td colSpan={4}>
                {labels.total}
                {pending ? <span className={styles.sapNote}> · {labels.saving}</span> : null}
              </td>
              <td className={styles.sapNum}>
                <bdi dir="ltr">{format(totalDebit)}</bdi>
              </td>
              <td className={styles.sapNum}>
                <bdi dir="ltr">{format(totalCredit)}</bdi>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {/* The balance, live, from what is on screen. */}
      <p aria-live="polite" className={styles.sapBalanceLine}>
        {balanced ? (
          <span className={styles.sapBalanced}>{labels.balanced}</span>
        ) : (
          <span className={styles.sapWarn}>
            {labels.outOfBalance} · {labels.difference} {format(difference)}
          </span>
        )}
      </p>
    </>
  );
}
