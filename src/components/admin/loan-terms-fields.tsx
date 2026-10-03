'use client';

import { useId, useState } from 'react';
import { addMonths } from '@/lib/dates';
import styles from './admin.module.css';

/**
 * The two parts of the new-loan form that answer back while they are filled
 * in — REQ-AP-001 §15.7.
 *
 * By direction (2026-10-03). The rest of the dialog is `Field` and `Select`
 * posting straight to a server action, which is how every form here works and
 * how this one should stay; these two questions cannot be asked that way:
 *
 *   * the bank may not be in the register yet, and a person raising a loan
 *     should not have to leave the dialog to add it;
 *   * the number of instalments decides how many due dates there are to ask
 *     for, and "usually the banks are the ones" who set them — so each date is
 *     a field of its own, and they appear and disappear with the count.
 *
 * Both are written against `admin.module.css` directly, as every other client
 * form in this codebase is (`statement-line-dialog.tsx`,
 * `new-account-dialog.tsx`): `Field` and `Select` take no change handler,
 * deliberately, so that a screen works before its JavaScript arrives. The
 * markup here is theirs class for class — including that a select's label
 * carries no asterisk and a date input carries `dateInput` — so that nothing
 * on the dialog looks as though it came from somewhere else.
 */

export interface Choice {
  readonly value: string;
  readonly label: string;
}

export interface LoanBankLabels {
  readonly bank: string;
  readonly another: string;
  readonly name: string;
  readonly nameHint: string;
  readonly swift: string;
}

/**
 * The bank, chosen from the register or named here.
 *
 * Naming one here creates it in the same transaction as the loan, so a
 * half-made bank cannot be left behind by a loan the service goes on to
 * refuse.
 */
export function LoanBankField({
  banks,
  labels,
  newBankValue,
}: {
  readonly banks: readonly Choice[];
  readonly labels: LoanBankLabels;
  readonly newBankValue: string;
}) {
  const [chosen, setChosen] = useState(banks[0]?.value ?? newBankValue);
  const naming = chosen === newBankValue;

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="f-bank_code">
          {labels.bank}
        </label>
        <select
          className={styles.select}
          id="f-bank_code"
          name="bank_code"
          onChange={(event) => setChosen(event.target.value)}
          required
          value={chosen}
        >
          {banks.map((bank, index) => (
            <option key={`${bank.value}-${index}`} value={bank.value}>
              {bank.label}
            </option>
          ))}
          <option value={newBankValue}>{labels.another}</option>
        </select>
      </div>

      {/* Only when the register has no row for it. Unmounted rather than
          hidden, so a bank chosen from the list posts no name at all — which
          is how the action tells the two apart. */}
      {naming ? (
        <>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="f-bank_name">
              {labels.name}
              <span aria-hidden="true" className={styles.required}>
                *
              </span>
            </label>
            <input autoComplete="off" className={styles.input} id="f-bank_name" name="bank_name" required />
            <span className={styles.hint}>{labels.nameHint}</span>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="f-bank_swift">
              {labels.swift}
            </label>
            <input autoComplete="off" className={styles.input} id="f-bank_swift" name="bank_swift" />
          </div>
        </>
      ) : null}
    </>
  );
}

export interface LoanScheduleLabels {
  readonly count: string;
  readonly frequency: string;
  readonly frequencies: readonly Choice[];
  readonly first: string;
  /**
   * The label of an instalment between the first and the final one, with
   * `{position}` where its number goes. A string, not a function: these labels
   * come from a server component, and a function cannot cross into a client one.
   */
  readonly nth: string;
  readonly final: string;
  readonly hint: string;
}

/** A loan is repaid in at least one instalment, and nobody writes sixty. */
const MOST_INSTALMENTS = 60;

export function LoanScheduleFields({
  today,
  labels,
}: {
  readonly today: string;
  readonly labels: LoanScheduleLabels;
}) {
  const id = useId();
  const [count, setCount] = useState('4');
  const [frequency, setFrequency] = useState('quarterly');
  const [first, setFirst] = useState(today);
  // Only the dates a person typed. The rest belong to the rhythm and reckon
  // themselves again when the rhythm, the count or the first date changes —
  // which is the whole reason this is state and not a defaultValue.
  const [typed, setTyped] = useState<Record<number, string>>({});

  const asked = Number(count);
  const rows = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MOST_INSTALMENTS) : 0;
  const step = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 0;

  /** What the bank's rhythm makes this date, before anybody retypes it. */
  const rhythm = (index: number): string => {
    if (index === 0) return first;
    // "On dates I type" seeds nothing past the first: an irregular schedule
    // should not look regular until somebody has corrected it.
    return step === 0 ? '' : addMonths(first, index * step);
  };

  const dates = Array.from({ length: rows }, (_, index) => typed[index] ?? rhythm(index));

  /**
   * The rhythm the loan is recorded as keeping.
   *
   * Monthly or quarterly only while every date is still the rhythm's own. The
   * moment one is retyped the schedule is this bank's and no formula's, and
   * saying otherwise would invite the service to generate it again from the
   * first date and quietly discard what was typed.
   */
  const declared = dates.every((date, index) => date === rhythm(index)) ? frequency : 'custom';

  const label = (index: number): string => {
    if (index === 0) return labels.first;
    if (index === rows - 1) return labels.final;
    return labels.nth.replace('{position}', String(index + 1));
  };

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-count`}>
          {labels.count}
          <span aria-hidden="true" className={styles.required}>
            *
          </span>
        </label>
        <input
          autoComplete="off"
          className={styles.input}
          id={`${id}-count`}
          max={MOST_INSTALMENTS}
          min={1}
          name="instalment_count"
          onChange={(event) => setCount(event.target.value)}
          required
          step={1}
          type="number"
          value={count}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-frequency`}>
          {labels.frequency}
        </label>
        <select
          className={styles.select}
          id={`${id}-frequency`}
          onChange={(event) => setFrequency(event.target.value)}
          value={frequency}
        >
          {labels.frequencies.map((option, index) => (
            <option key={`${option.value}-${index}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className={styles.hint}>{labels.hint}</span>
      </div>

      {/* One field per instalment: the first, then each by its number, then
          the final one. They follow the count — ask for three and three are
          asked about. */}
      {dates.map((date, index) => (
        <div className={styles.field} key={index}>
          <label className={styles.label} htmlFor={`${id}-due-${index}`}>
            {label(index)}
            <span aria-hidden="true" className={styles.required}>
              *
            </span>
          </label>
          <input
            autoComplete="off"
            className={`${styles.input} ${styles.dateInput}`}
            id={`${id}-due-${index}`}
            name={`due_${index}`}
            onChange={(event) => {
              setTyped((current) => ({ ...current, [index]: event.target.value }));
              // The first date is what the rhythm counts from, so moving it
              // moves every date still keeping that rhythm.
              if (index === 0) setFirst(event.target.value);
            }}
            required
            type="date"
            value={date}
          />
        </div>
      ))}

      {/* What the action reads: how many dates were asked about, the rhythm the
          loan is recorded as keeping, and the first date every loan must name. */}
      <input name="due_count" type="hidden" value={String(rows)} />
      <input name="frequency" type="hidden" value={declared} />
      <input name="first_due_date" type="hidden" value={dates[0] ?? ''} />
    </>
  );
}
