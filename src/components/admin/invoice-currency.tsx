'use client';

import { useEffect, useRef, useState } from 'react';
import { lineTotal, MONEY_PLACES, toNumber } from '@/lib/decimal';
import styles from './admin.module.css';

/**
 * The currency a purchase invoice is agreed in, and what it comes to in both —
 * by direction, 2026-10-03.
 *
 * "it actually should be usd not iqd uses lastest exhcnage rate dynamically …
 * in total usd total iqd".
 *
 * The company buys in dollars and keeps its books in dinars, and both figures
 * matter to different people: the supplier is owed the dollars, the ledger
 * records the dinars. So the prices are typed in the agreed currency and the
 * dinar total is shown beside it, at the rate in force on the invoice's own
 * date.
 *
 * It shows; it does not decide. Only the currency crosses to the server, which
 * reads the same rate with `rateOn` and converts every line itself — because a
 * rate that arrived from a browser is a rate somebody could have edited, and
 * the dinars here end up in the journal.
 *
 * The rates come in as a map so switching currency is instant and needs no
 * round trip; they are published facts, not secrets.
 */
export interface CurrencyChoice {
  readonly code: string;
  readonly name: string;
  /** Dinars for one unit, at the money scale, on the invoice's date. */
  readonly iqdPerUnit: string;
}

export function InvoiceCurrency({
  label,
  name,
  choices,
  ledger,
  labels,
  locale,
}: {
  readonly label: string;
  readonly name: string;
  readonly choices: readonly CurrencyChoice[];
  /** The books' own currency; chosen to begin with, and never converted. */
  readonly ledger: string;
  readonly labels: {
    readonly rate: string;
    readonly totalIn: string;
    readonly totalLedger: string;
  };
  readonly locale: string;
}) {
  const box = useRef<HTMLSelectElement>(null);
  const [chosen, setChosen] = useState(ledger);
  const [total, setTotal] = useState<bigint>(0n);

  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;

    /*
     * The invoice's total, summed off the line grid's own fields — the same
     * reading `advance-field.tsx` takes, and for the same reason: the grid is
     * a component of its own and this is not its business.
     */
    const read = () => {
      const claimed = Number(value(form, 'line_count'));
      const rows = Number.isInteger(claimed) && claimed > 0 ? Math.min(claimed, 500) : 0;
      let sum = 0n;
      for (let row = 0; row < rows; row += 1) {
        const line = lineTotal(
          value(form, `quantity_${row}`),
          value(form, `unit_price_${row}`),
          value(form, `discount_${row}`),
        );
        if (line !== null) sum += line;
      }
      setTotal(sum);
    };

    read();
    form.addEventListener('input', read);
    return () => form.removeEventListener('input', read);
  }, []);

  const rate = choices.find((c) => c.code === chosen)?.iqdPerUnit ?? '1';
  const foreign = chosen !== ledger;
  const shown = (value: bigint) =>
    toNumber(value, MONEY_PLACES).toLocaleString(locale === 'ar' ? 'ar' : 'en-US', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0,
    });

  return (
    <>
      <select
        className={styles.select}
        id={`f-${name}`}
        name={name}
        onChange={(event) => setChosen(event.target.value)}
        ref={box}
        value={chosen}
      >
        {choices.map((choice) => (
          <option key={choice.code} value={choice.code}>
            {choice.code === choice.name ? choice.code : `${choice.code} · ${choice.name}`}
          </option>
        ))}
      </select>
      {foreign ? (
        <span className={styles.sapGridCaption}>
          <bdi dir="ltr">
            {labels.rate.replace('{rate}', shown(scaled(rate))).replace('{currency}', chosen)}
          </bdi>
          {total > 0n ? (
            <>
              {' · '}
              <bdi dir="ltr">
                {labels.totalIn.replace('{currency}', chosen).replace('{amount}', shown(total))}
              </bdi>
              {' · '}
              <bdi dir="ltr">
                {labels.totalLedger
                  .replace('{currency}', ledger)
                  .replace('{amount}', shown(inLedger(total, rate)))}
              </bdi>
            </>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** A named field's value, whatever kind of control holds it. */
function value(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) return field.value;
  if (field instanceof HTMLSelectElement) return field.value;
  return '';
}

/** A rate as written ("1470.00000000") at the money scale. */
function scaled(rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
}

/**
 * The dinar equivalent, by the server's own steps — `toIqd` in
 * `domain/money.ts`: multiply by the rate and round half-up.
 *
 * The rate is published at eight decimal places and money at four, so the
 * multiplication is done at the rate's own scale and brought back, which is
 * what keeps this and the server agreeing to the fils.
 */
export function inLedger(amount: bigint, rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  const perUnit = BigInt(whole) * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
  const product = amount * perUnit;
  const factor = 100_000_000n;
  const quotient = product / factor;
  const remainder = product % factor;
  return remainder * 2n >= factor ? quotient + 1n : quotient;
}
