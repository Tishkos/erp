'use client';

import { useEffect, useRef, useState } from 'react';
import { lineTotal, MONEY_PLACES, toNumber } from '@/lib/decimal';
import { inLedger } from './invoice-currency';
import styles from './admin.module.css';

/**
 * The advance a purchase invoice is paid in front, and what it comes to —
 * §15.3, by direction 2026-10-03.
 *
 * "when eg 20 percent should show us how much total advanced": a percentage on
 * its own is a sum somebody has to do in their head against a total that is
 * still being typed, and getting it wrong means asking a bank for the wrong
 * money. So the figure is worked out here, from the lines as they are entered,
 * and shown beside the box.
 *
 * It is shown, not submitted. Only the percentage crosses to the server, and
 * the server works the figure out again from the total it has just committed
 * (`advanceOf`, the same arithmetic in the same order) — so the figure on the
 * screen and the figure asked of the bank come from one rule rather than two
 * that agree today. A form that posted its own arithmetic would be a form that
 * could lie about it.
 *
 * Two figures and nothing else (2026-10-03): the money the supplier gets in
 * front, and the dinars that leave the bank account to send it. The sentence
 * that used to follow them folded the cell onto three lines to say something
 * true of every advance ever raised.
 *
 * The lines are read off the form by name, the way `due-date-field.tsx`
 * watches the partner and the date: a form-level `input` listener, because the
 * grid is a component of its own and this is not its business.
 */
export function AdvanceField({
  label,
  name,
  currencyField,
  ledgerCurrency,
  ledgerRates,
  locale,
  defaultPercent,
  importField,
}: {
  readonly label: string;
  readonly name: string;
  /**
   * The share an import is paid in front unless the accountant writes another
   * (2026-10-06, by direction: "automatically 20% … payment application").
   * It stands while the `importField` box is ticked and nothing has been typed
   * here; untick Import and the box is empty again, type and it is yours.
   */
  readonly defaultPercent?: string;
  readonly importField?: string;
  /**
   * The form field holding the currency the invoice is agreed in, so the
   * advance is said in that currency as well as in dinars (2026-10-03).
   */
  readonly currencyField: string;
  readonly ledgerCurrency: string;
  /** One unit of each currency in dinars, as a decimal string at the rate scale. */
  readonly ledgerRates: Readonly<Record<string, string>>;
  readonly locale: string;
}) {
  const box = useRef<HTMLInputElement>(null);
  const [percent, setPercent] = useState(defaultPercent ?? '');
  // Once the accountant has typed a share it is theirs: the default never comes back over it.
  const typedRef = useRef(false);
  const [total, setTotal] = useState<bigint>(0n);
  const [agreed, setAgreed] = useState(ledgerCurrency);

  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;

    /*
     * The invoice's total, summed off the line grid's own fields.
     *
     * `line_count` is what the grid says it has; the rows are read until it
     * runs out, and a row without a quantity and a price contributes nothing
     * — which is every row somebody is halfway through typing.
     */
    const readTotal = () => {
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

      // And which currency those prices are in.
      const chosen = value(form, currencyField);
      if (chosen) setAgreed(chosen);
    };

    /*
     * The default share follows the Import box: an import is paid 20% in
     * front unless the accountant says otherwise; an expense or a local
     * purchase starts with no advance at all.
     */
    const followImport = () => {
      if (!defaultPercent || !importField || typedRef.current) return;
      const tick = form.elements.namedItem(importField);
      const ticked = tick instanceof HTMLInputElement ? tick.checked : true;
      setPercent(ticked ? defaultPercent : '');
    };

    readTotal();
    followImport();
    form.addEventListener('input', readTotal);
    form.addEventListener('input', followImport);
    return () => {
      form.removeEventListener('input', readTotal);
      form.removeEventListener('input', followImport);
    };
  }, [currencyField, defaultPercent, importField]);

  /*
   * The share, by the same steps the server takes: the percentage scaled to
   * four places, multiplied, divided by a hundred, rounded half-up on the last
   * place. Kept in step with `advanceOf` deliberately — if the two ever
   * disagree the screen is the one that is wrong, and the server's figure is
   * the one the bank is asked for.
   */
  const share = advanceShare(total, percent);
  const shown = (value: bigint, places: number, least = 0) =>
    toNumber(value, MONEY_PLACES).toLocaleString(locale === 'ar' ? 'ar' : 'en-US', {
      maximumFractionDigits: places,
      minimumFractionDigits: least,
    });

  return (
    <>
      <input
        aria-label={label}
        inputMode="decimal"
        max={100}
        min={0}
        name={name}
        /*
         * Never more than a hundred (2026-10-03). An advance of 120% asks a
         * bank for more than the goods cost, so the box does not take the
         * figure: `advanceOf` refuses it on the server and 0270's CHECK
         * refuses the row, and a box that accepted it would be a box that
         * made somebody find out at the third refusal.
         */
        onChange={(event) => {
          typedRef.current = true;
          const typed = event.target.value;
          const asked = Number(typed);
          setPercent(Number.isFinite(asked) && asked > 100 ? '100' : typed);
        }}
        ref={box}
        step="any"
        type="number"
        value={percent}
      />
      {share !== null ? (
        <span className={styles.sapEnteredNote}>
          <bdi dir="ltr">
            {agreed} {shown(share, 2, 2)}
          </bdi>
          {/* And what leaves the bank account, which is the dinars. */}
          {agreed !== ledgerCurrency && ledgerRates[agreed] ? (
            <>
              {' · '}
              <bdi dir="ltr">
                {ledgerCurrency} {shown(inLedger(share, ledgerRates[agreed]!), 0)}
              </bdi>
            </>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** The value of a named field, whatever kind of control holds it. */
function value(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) return field.value;
  if (field instanceof HTMLSelectElement) return field.value;
  return '';
}

/**
 * The twin of `advanceOf` in `domain/payment-applications.ts`.
 *
 * Duplicated rather than imported because a client component here does not
 * import from `src/server` — the same arrangement `src/lib/decimal.ts` has
 * with the money domain, and `src/lib/dates.ts` with the loan schedule. The
 * steps are the server's, in the server's order, and
 * `ap16-advance-field.test.ts` runs the two over the same figures and fails if
 * they ever part company.
 */
export function advanceShare(totalIqd: bigint, percent: string): bigint | null {
  const text = percent.trim();
  if (text === '') return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  if (totalIqd <= 0n) return null;

  const [whole = '0', fraction = ''] = text.split('.');
  const places = (fraction + '0000').slice(0, 4);
  const scaled = BigInt(whole) * 10_000n + BigInt(places);
  if (scaled <= 0n) return null;

  if (scaled > 100n * 10_000n) return null;

  const denominator = 100n * 10_000n;
  const numerator = totalIqd * scaled;
  const share = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? share + 1n : share;
  return rounded <= 0n ? null : rounded;
}
