'use client';

import { useEffect, useRef, useState } from 'react';
import { lineTotal, MONEY_PLACES, scaled, toNumber } from '@/lib/decimal';
import { IntentSelect } from '@/components/admin/intent-select';
import { ADVANCE_ACCOUNT_EVENT } from './advance-account-select';
import { inLedger } from './invoice-currency';
import styles from './admin.module.css';

/** How the advance is agreed — the selection's three choices (0411). */
export type AdvanceChoice = 'none' | 'percent' | 'amount';

export interface AdvanceFieldLabels {
  /** "Payable in advance" — the selection. */
  readonly basis: string;
  readonly none: string;
  readonly percent: string;
  readonly amount: string;
  /** The box beside it: "Advance payment %" / "Advance amount". */
  readonly percentBox: string;
  readonly amountBox: string;
  /** "Payable amount", "Left to pay". */
  readonly payable: string;
  readonly left: string;
  /** "That is {percent}% of the total", raw — the placeholder is filled here. */
  readonly share: string;
  /** Said under an amount above the invoice's total; the form will not send it. */
  readonly overTotal: string;
  /** Said while no account is chosen to pay it from: nothing can be paid in front from nowhere. */
  readonly needsAccount?: string;
}

/**
 * The advance a purchase invoice is paid in front — two fields, side by side
 * (2026-10-06, by direction: "no extra field — two fields; one is hidden when
 * the payable selection is 'no upfront payment'; then for Payable by
 * percentage / Payable by amount open a new input next to it").
 *
 *   Payable in advance   No upfront payment · Payable by percentage ·
 *                        Payable by amount (`advance_basis`)
 *   the box beside it    a percentage (`advance_percent`, more than nought,
 *                        never more than a hundred) or an amount
 *                        (`advance_amount`, more than nought, never more than
 *                        the invoice) — not drawn, so not sent, for none
 *
 * Under the box a line says what it comes to, worked out from the lines as
 * they are typed: by percentage the payable amount and what is left to pay; by
 * amount the share of the total it is and what is left. In the currency the
 * invoice is agreed in, and the dinars beside a foreign figure. Exact, on
 * bigints (`src/lib/decimal.ts`); the server works it out again
 * (`invoiceAdvance`) and refuses what this box would not take.
 *
 * No preset share (by direction: "what is 20 percentage? it should start
 * [at] import, any percentage"): with Import ticked the selection opens on
 * Payable by percentage with the box empty, without it on No upfront payment;
 * once the person chooses, the choice is theirs.
 *
 * The lines are read off the form by name, the way `due-date-field.tsx`
 * watches the partner and the date: a form-level `input` listener, because the
 * grid is a component of its own and this is not its business.
 */
export function AdvanceField({
  labels,
  currencyField,
  ledgerCurrency,
  ledgerRates,
  locale,
  importField,
  accountField,
}: {
  readonly labels: AdvanceFieldLabels;
  /**
   * The "Advance paid from" select. While it names no account the selection
   * is No upfront payment and cannot be changed (2026-10-07, by direction: "if
   * there is no bank account the payable upfront cannot be selected — which
   * bank account is it going to be issued from?").
   */
  readonly accountField?: string;
  /** The Import tick box: ticked, the selection opens on Payable by percentage. */
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
  const select = useRef<HTMLSelectElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<AdvanceChoice>(importField ? 'percent' : 'none');
  const choiceRef = useRef<AdvanceChoice>(importField ? 'percent' : 'none');
  const [typed, setTyped] = useState('');
  // Once the person has chosen, the Import box no longer moves the selection.
  const chosenRef = useRef(false);
  const [total, setTotal] = useState<bigint>(0n);
  const [agreed, setAgreed] = useState(ledgerCurrency);
  // Whether an account to pay it from is chosen; without one the advance is "none" and locked.
  const [hasAccount, setHasAccount] = useState(!accountField);

  useEffect(() => {
    const form = select.current?.form;
    if (!form || !accountField) return;
    const read = (event?: Event) => {
      const chosen = event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : value(form, accountField);
      setHasAccount(chosen !== '');
    };
    read();
    form.addEventListener(ADVANCE_ACCOUNT_EVENT, read);
    form.addEventListener('change', read);
    return () => {
      form.removeEventListener(ADVANCE_ACCOUNT_EVENT, read);
      form.removeEventListener('change', read);
    };
  }, [accountField]);

  useEffect(() => {
    const form = select.current?.form;
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
     * The selection follows the Import box until the person chooses: an
     * import opens on Payable by percentage with the box empty (any share,
     * none preset), a local purchase or an expense on No upfront payment.
     */
    const followImport = () => {
      if (!importField || chosenRef.current) return;
      const tick = form.elements.namedItem(importField);
      const ticked = tick instanceof HTMLInputElement ? tick.checked : true;
      const next: AdvanceChoice = ticked ? 'percent' : 'none';
      if (next === choiceRef.current) return;
      choiceRef.current = next;
      setChoice(next);
      setTyped('');
    };

    readTotal();
    followImport();
    form.addEventListener('input', readTotal);
    form.addEventListener('input', followImport);
    return () => {
      form.removeEventListener('input', readTotal);
      form.removeEventListener('input', followImport);
    };
  }, [currencyField, importField]);

  /*
   * What the box comes to. By percentage, the share by the same steps the
   * server takes (`advanceShare`, the twin of `advanceOf`); by amount, the
   * amount itself and the share of the total it is. If the two ever disagree
   * the screen is the one that is wrong: the server's figure is the one the
   * bank is asked for.
   */
  // No account, no advance: what is shown and sent is "none" until one is chosen.
  const shownChoice: AdvanceChoice = hasAccount ? choice : 'none';
  const payable = shownChoice === 'percent' ? advanceShare(total, typed) : shownChoice === 'amount' ? amountOf(typed) : null;
  const over = shownChoice === 'amount' && payable !== null && total > 0n && payable > total;
  const left = payable !== null && !over ? total - payable : null;
  const shown = (value: bigint, places: number, least = 0) =>
    toNumber(value, MONEY_PLACES).toLocaleString(locale === 'ar' ? 'ar' : 'en-US', {
      maximumFractionDigits: places,
      minimumFractionDigits: least,
    });
  const money = (value: bigint) => `${agreed} ${shown(value, agreed === 'IQD' ? 0 : 2, agreed === 'IQD' ? 0 : 2)}`;
  const inDinars = (value: bigint) =>
    agreed !== ledgerCurrency && ledgerRates[agreed] ? `${ledgerCurrency} ${shown(inLedger(value, ledgerRates[agreed]!), 0)}` : null;

  // An amount above the invoice is not sent: the box says why and the form will not submit it.
  useEffect(() => {
    box.current?.setCustomValidity(over ? labels.overTotal : '');
  }, [labels.overTotal, over]);

  return (
    <>
      <div className={styles.sapField}>
        <span className={styles.sapLabel}>{labels.basis}</span>
        <IntentSelect
          aria-label={labels.basis}
          disabled={!hasAccount}
          name="advance_basis"
          onChange={(event) => {
            chosenRef.current = true;
            choiceRef.current = event.target.value as AdvanceChoice;
            setChoice(event.target.value as AdvanceChoice);
            setTyped('');
          }}
          ref={select}
          value={shownChoice}
        >
          <option value="none">{labels.none}</option>
          <option value="percent">{labels.percent}</option>
          <option value="amount">{labels.amount}</option>
        </IntentSelect>
        {/* A disabled select is not sent: the form still says "none". */}
        {hasAccount ? null : <input name="advance_basis" type="hidden" value="none" />}
        {!hasAccount && labels.needsAccount ? (
          <span className={styles.sapEnteredNote} data-advance-needs-account="">
            {labels.needsAccount}
          </span>
        ) : null}
      </div>
      {shownChoice === 'none' ? null : (
        <div className={styles.sapField} data-advance-box={shownChoice}>
          <span className={styles.sapLabel}>{shownChoice === 'percent' ? labels.percentBox : labels.amountBox}</span>
          <input
            aria-invalid={over || undefined}
            aria-label={shownChoice === 'percent' ? labels.percentBox : labels.amountBox}
            dir="ltr"
            inputMode="decimal"
            // Never more than a hundred (2026-10-03): the box does not take the figure,
            // `invoiceAdvance` refuses it on the server and 0270's CHECK refuses the row.
            {...(shownChoice === 'percent' ? { max: 100 } : {})}
            min={0}
            name={shownChoice === 'percent' ? 'advance_percent' : 'advance_amount'}
            onChange={(event) => {
              const text = event.target.value;
              const asked = Number(text);
              setTyped(shownChoice === 'percent' && Number.isFinite(asked) && asked > 100 ? '100' : text);
            }}
            ref={box}
            step="any"
            type="number"
            value={typed}
          />
          {/* Two short read-only lines under the box: what it comes to, and what is left. */}
          {payable !== null ? (
            <span className={`${styles.sapEnteredNote} tabular-nums`} data-payable-amount="">
              {over ? (
                <span className="text-danger-subtle-fg">{labels.overTotal}</span>
              ) : shownChoice === 'percent' ? (
                <>
                  <span>{labels.payable}: </span>
                  <bdi className="font-medium text-fg" dir="ltr">
                    {money(payable)}
                  </bdi>
                  {inDinars(payable) ? (
                    <>
                      {' · '}
                      <bdi dir="ltr">{inDinars(payable)}</bdi>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <span>{labels.share.replace('{percent}', shareText(payable, total, locale))}</span>
                  {inDinars(payable) ? (
                    <>
                      {' · '}
                      <bdi dir="ltr">{inDinars(payable)}</bdi>
                    </>
                  ) : null}
                </>
              )}
            </span>
          ) : null}
          {left !== null ? (
            <span className={`${styles.sapEnteredNote} tabular-nums`} data-left-to-pay="">
              <span>{labels.left}: </span>
              <bdi dir="ltr">{money(left)}</bdi>
            </span>
          ) : null}
        </div>
      )}
    </>
  );
}

/** An amount typed in the box, at four places; null while it is not one above nought. */
function amountOf(text: string): bigint | null {
  const value = scaled(text.trim(), MONEY_PLACES);
  return value === null || value <= 0n ? null : value;
}

/** amount ÷ total as a percentage at two places, half up — the twin of `advanceShareOf`. */
function shareText(amount: bigint, total: bigint, locale: string): string {
  if (total <= 0n) return '0';
  const numerator = amount * 10_000n;
  const hundredths = numerator / total + ((numerator % total) * 2n >= total ? 1n : 0n);
  return toNumber(hundredths, 2).toLocaleString(locale === 'ar' ? 'ar' : 'en-US', { maximumFractionDigits: 2 });
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
