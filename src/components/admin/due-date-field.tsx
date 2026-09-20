'use client';

import { useEffect, useRef, useState } from 'react';
import { dueDateFor, type PaymentTerms } from '@domain/payment-terms';
import { PAIRED_CHOICE } from './paired-picker';

/**
 * The due date a document's own header can work out — §16.
 *
 * "Net 30" is a fact about the partner, recorded once on their record, and a
 * person raising an invoice should not be counting thirty days on a calendar
 * to repeat it. So the field fills itself the moment the partner and the
 * document date are both known, by the same `dueDateFor` the service uses when
 * it saves — what is shown and what is stored are one calculation, not two
 * that agree today.
 *
 * It fills, it does not lock. The first time somebody types in the box the
 * field stops following the terms and keeps what they typed: terms are the
 * default and the invoice is the authority. A partner with no terms gets the
 * document date, which is what "no terms were agreed" comes to — the same
 * fallback the server applies, shown rather than hidden.
 */
export interface PartnerTerms {
  readonly partnerId: string;
  /** Null when the partner has no terms, or none that are still configured. */
  readonly terms: PaymentTerms | null;
}

export function DueDateField({
  label,
  name,
  partnerField,
  dateField,
  terms,
  required = false,
}: {
  readonly label: string;
  /** The field the date is submitted under. */
  readonly name: string;
  /** The hidden field a PairedPicker writes the partner's id into. */
  readonly partnerField: string;
  /** The date field the terms are counted from. */
  readonly dateField: string;
  readonly terms: readonly PartnerTerms[];
  readonly required?: boolean;
}) {
  const box = useRef<HTMLInputElement>(null);
  const typedIn = useRef(false);
  const [value, setValue] = useState('');

  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;

    const follow = () => {
      if (typedIn.current) return;

      const partnerId = fieldValue(form, partnerField);
      const documentDate = fieldValue(form, dateField);
      // Half a question has no answer: keep whatever is in the box until both
      // the partner and the date are known.
      if (!partnerId || !documentDate) return;

      const agreed = terms.find((entry) => entry.partnerId === partnerId)?.terms ?? null;
      try {
        setValue(agreed ? dueDateFor(agreed, documentDate) : documentDate);
      } catch {
        // An unusable date or an incomplete set of instalments: say nothing
        // and let the person fill the field themselves.
      }
    };

    const onInput = (event: Event) => {
      // Typing in this box is the person taking it over, and the event reaches
      // the form before React's own handler does — so the claim is staked here.
      if (event.target === box.current) {
        typedIn.current = true;
        return;
      }
      follow();
    };

    form.addEventListener('input', onInput);
    form.addEventListener(PAIRED_CHOICE, follow);
    return () => {
      form.removeEventListener('input', onInput);
      form.removeEventListener(PAIRED_CHOICE, follow);
    };
  }, [dateField, partnerField, terms]);

  return (
    <input
      aria-label={label}
      name={name}
      onChange={(event) => setValue(event.target.value)}
      ref={box}
      required={required}
      type="date"
      value={value}
    />
  );
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement ? field.value : '';
}
