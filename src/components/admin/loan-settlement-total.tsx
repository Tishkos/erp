'use client';

import { useEffect, useRef, useState } from 'react';
import { MONEY_PLACES, scaled, toText } from '@/lib/decimal';
import { formatMoney, type Locale } from '@/i18n/config';

/**
 * What ending a loan early actually costs, said as the figures are typed — by
 * direction, 2026-10-04.
 *
 * A 5,000 early settlement fee was entered on a loan of 10,000 and this line
 * still read "Settlement total 10,000": the quote behind it was worked out when
 * the page was drawn, and knew nothing of a fee typed afterwards. The loan was
 * then settled for 15,000 — a figure the person settling it had never been
 * shown. A preview that disagrees with what posts is worse than no preview.
 *
 * The sum is `loans.settleEarly`'s own, in its order: the principal left, plus
 * the interest the bank asks, plus its charge for closing early. Shown, never
 * submitted — the service works all three out again from the stored loan, and a
 * form that posted its own arithmetic could lie about it.
 */
export function LoanSettlementTotal({
  outstandingTxn,
  totalTxn,
  interestField,
  feeField,
  principalField,
  currency,
  labels,
  locale,
}: {
  /** The principal left, scaled as the server writes money. */
  readonly outstandingTxn: string;
  /** The quote's own total, shown until the form has been read. */
  readonly totalTxn: string;
  readonly interestField: string;
  readonly feeField: string;
  /** The principal paid, when the form lets less than all of it be paid. */
  readonly principalField?: string;
  readonly currency: string;
  readonly labels: {
    readonly outstanding: string;
    readonly total: string;
  };
  readonly locale: Locale;
}) {
  const anchor = useRef<HTMLParagraphElement>(null);
  const [typed, setTyped] = useState<string | null>(null);

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return;

    const read = () => {
      const left = scaled(outstandingTxn, MONEY_PLACES);
      // The principal typed, or all of it when the box is empty or half-typed.
      const outstanding = (principalField ? scaled(value(form, principalField), MONEY_PLACES) : null) ?? left;
      if (outstanding === null) {
        setTyped(null);
        return;
      }
      // A box left empty, or half-typed, is nothing yet — not a reason to stop
      // saying what the settlement costs.
      const interest = scaled(value(form, interestField), MONEY_PLACES) ?? 0n;
      const fee = scaled(value(form, feeField), MONEY_PLACES) ?? 0n;
      setTyped(toText(outstanding + interest + fee, MONEY_PLACES));
    };

    read();
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    return () => {
      form.removeEventListener('input', read);
      form.removeEventListener('change', read);
    };
  }, [outstandingTxn, interestField, feeField, principalField]);

  const money = (amount: string) => formatMoney(amount, currency, locale);

  return (
    <p className="muted" ref={anchor}>
      {labels.outstanding} {money(outstandingTxn)}
      {' · '}
      {labels.total} {money(typed ?? totalTxn)}
    </p>
  );
}

/** The value of a named field, whatever kind of control holds it. */
function value(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) return field.value;
  if (field instanceof HTMLSelectElement) return field.value;
  return '';
}
