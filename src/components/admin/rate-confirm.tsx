'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The exchange rate a Paid paper will post at, said before anything is created
 * (2026-10-21, by direction: "it should say before creating it: is the current
 * exchange rate correct"). It follows the paid date typed in the same form,
 * asks `endpoint?date=` for that day's accounting rate, shows what the payment
 * comes to in dinars at it, and asks the person to confirm. The confirmation
 * posts the rate's own id (`rate_confirmed`): the server refuses if the rate of
 * that day is not the one confirmed.
 */
interface RateAnswer {
  readonly rate?: {
    readonly currency: string;
    readonly rateId: string | null;
    readonly iqdPerUnit: string;
    readonly effectiveFrom: string;
    readonly amountTxn: string;
    readonly amountIqd: string;
  } | null;
  readonly error?: string;
}

export function RateConfirm({
  endpoint,
  currency,
  dateField = 'paper_date',
  initialDate,
  locale,
  labels,
}: {
  readonly endpoint: string;
  /** The application's currency, for the sentence when that day has no rate. */
  readonly currency: string;
  readonly dateField?: string;
  readonly initialDate: string;
  readonly locale: string;
  readonly labels: {
    /** "Exchange rate on {date}" */
    readonly title: string;
    /** "1 {currency} = {rate} IQD (in force from {from})" */
    readonly rate: string;
    /** "{currency} {amount} comes to IQD {iqd}" */
    readonly converts: string;
    /** "The rate is correct — post the payment at it" */
    readonly confirm: string;
    /** "Checking the rate…" */
    readonly checking: string;
    /** "No {currency} rate for that date. Enter it under Currencies and Rates first." */
    readonly none: string;
  };
}) {
  const box = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState(initialDate);
  const [answer, setAnswer] = useState<RateAnswer | null>(null);
  const [ticked, setTicked] = useState(false);

  // Follows the date field of its own form (a native input the date picker writes to).
  useEffect(() => {
    const form = box.current?.closest('form');
    const field = form?.querySelector<HTMLInputElement>(`input[name="${dateField}"]`);
    if (!field) return;
    const read = () => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(field.value)) setDate((old) => (old === field.value ? old : field.value));
    };
    read();
    field.addEventListener('input', read);
    field.addEventListener('change', read);
    const timer = setInterval(read, 700);
    return () => {
      field.removeEventListener('input', read);
      field.removeEventListener('change', read);
      clearInterval(timer);
    };
  }, [dateField]);

  useEffect(() => {
    let stopped = false;
    setAnswer(null);
    setTicked(false);
    fetch(`${endpoint}?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      .then((response) => response.json() as Promise<RateAnswer>)
      .then((value) => {
        if (!stopped) setAnswer(value);
      })
      .catch(() => {
        if (!stopped) setAnswer({ error: 'unreachable' });
      });
    return () => {
      stopped = true;
    };
  }, [endpoint, date]);

  const number = (value: string, digits = 2) =>
    new Intl.NumberFormat(locale === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(value));
  const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
  const rate = answer?.rate ?? null;

  return (
    <div className="my-3 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-subtle-fg" data-rate-confirm="" ref={box}>
      <p className="font-semibold">{fill(labels.title, { date })}</p>
      {!answer ? <p>{labels.checking}</p> : null}
      {answer && !rate ? <p data-rate-missing="">{fill(labels.none, { currency })}</p> : null}
      {rate ? (
        <>
          <p className="mt-1">
            <bdi dir="ltr">{fill(labels.rate, { currency: rate.currency, rate: number(rate.iqdPerUnit, 8), from: rate.effectiveFrom })}</bdi>
          </p>
          <p>
            <bdi dir="ltr">{fill(labels.converts, { currency: rate.currency, amount: number(rate.amountTxn), iqd: number(rate.amountIqd) })}</bdi>
          </p>
          <label className="mt-2 flex items-start gap-2 font-medium">
            <input checked={ticked} name="rate_confirmed_check" onChange={(event) => setTicked(event.target.checked)} required type="checkbox" />
            <span>{labels.confirm}</span>
          </label>
          {ticked && rate.rateId ? <input name="rate_confirmed" type="hidden" value={rate.rateId} /> : null}
        </>
      ) : null}
    </div>
  );
}
