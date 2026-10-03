'use client';

import { useEffect, useRef, useState } from 'react';
import { MONEY_PLACES, scaled, toNumber } from '@/lib/decimal';
import styles from './admin.module.css';

/**
 * What the bank will actually put in the account — by direction, 2026-10-03:
 * "where is the amount when taking loan should give us make into credit please
 * and amount of the loan".
 *
 * A loan letter states a principal and a commission, and those two are not the
 * same as the money that arrives. When the commission is deducted at
 * disbursement the bank sends the principal less the commission and the company
 * still owes the principal — so the form said neither figure and the person
 * entering it had to do the subtraction in their head against a number the bank
 * will send tomorrow.
 *
 * Both are said here as the letter is typed: what lands in the account, and
 * what is owed. Shown, never submitted — `loans.disburse` works the same
 * figures out again from the stored loan when the money actually arrives, and a
 * form that posted its own arithmetic would be a form that could lie about it.
 */
export function LoanProceeds({
  principalField,
  percentField,
  treatmentField,
  deductedCodes,
  labels,
  locale,
}: {
  readonly principalField: string;
  readonly percentField: string;
  readonly treatmentField: string;
  /** The treatments the bank takes out of the money it sends. */
  readonly deductedCodes: readonly string[];
  readonly labels: {
    readonly lands: string;
    readonly owed: string;
    readonly commission: string;
  };
  readonly locale: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [figures, setFigures] = useState<{
    principal: bigint;
    commission: bigint;
    deducted: boolean;
  } | null>(null);

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return;

    const read = () => {
      const principal = scaled(value(form, principalField), MONEY_PLACES);
      if (principal === null || principal <= 0n) {
        setFigures(null);
        return;
      }
      const percent = scaled(value(form, percentField), MONEY_PLACES);
      const commission = percent !== null && percent > 0n ? commissionShare(principal, percent) : 0n;

      setFigures({
        principal,
        commission,
        deducted: deductedCodes.includes(value(form, treatmentField)),
      });
    };

    read();
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    return () => {
      form.removeEventListener('input', read);
      form.removeEventListener('change', read);
    };
  }, [principalField, percentField, treatmentField, deductedCodes]);

  if (!figures) return <span ref={anchor} />;

  const shown = (amount: bigint) =>
    toNumber(amount, MONEY_PLACES).toLocaleString(locale === 'ar' ? 'ar' : 'en-US', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    });
  // Deducted at disbursement: the bank keeps its commission out of what it
  // sends. Any other treatment and the whole principal arrives.
  const lands = landsInAccount(figures.principal, figures.commission, figures.deducted);

  return (
    <span className={styles.sapEnteredNote} ref={anchor}>
      <bdi dir="ltr">
        {labels.lands} {shown(lands)}
      </bdi>
      {figures.deducted && figures.commission > 0n ? (
        <>
          {' · '}
          <bdi dir="ltr">
            {labels.commission} {shown(figures.commission)}
          </bdi>
        </>
      ) : null}
      {' · '}
      <bdi dir="ltr">
        {labels.owed} {shown(figures.principal)}
      </bdi>
    </span>
  );
}

/**
 * The twins of `commissionOf` and `netProceeds` in `domain/loans.ts`.
 *
 * Duplicated rather than imported because a client component here does not
 * import from `src/server` — the same arrangement `src/lib/decimal.ts` has with
 * the money domain. The steps are the server's, in the server's order, and
 * `tr02-loan-proceeds.test.ts` runs the two over the same figures and fails if
 * they ever part company.
 */
export function commissionShare(principal: bigint, percent: bigint): bigint {
  const raw = (principal * percent) / (100n * 10n ** BigInt(MONEY_PLACES));
  // To the cent, half up — amounts here are never negative.
  const rest = raw % 100n;
  return rest * 2n >= 100n ? raw - rest + 100n : raw - rest;
}

/** What lands in the account: the principal less a commission taken out of it. */
export function landsInAccount(principal: bigint, commission: bigint, deducted: boolean): bigint {
  return deducted ? principal - commission : principal;
}

/** The value of a named field, whatever kind of control holds it. */
function value(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) return field.value;
  if (field instanceof HTMLSelectElement) return field.value;
  return '';
}
