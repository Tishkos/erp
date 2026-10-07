'use client';

import { useEffect, useRef, useState } from 'react';
import { MONEY_PLACES, scaled, toNumber } from '@/lib/decimal';
import styles from './admin.module.css';

/** What the ledger says about one account — the shape `accountBalanceAction` answers with. */
export interface AccountBalanceView {
  readonly code: string;
  readonly name: string;
  /** The currency the account is kept in, when it names one. */
  readonly currency: string | null;
  /** Debit less credit in dinars, a signed decimal string. */
  readonly balanceIqd: string;
  /** Debit less credit in `currency`, for an account kept in another currency. */
  readonly balanceTxn: string | null;
}

/** Which account to ask about: a chart-of-accounts account, or a bank / cash account (its G/L account). */
export interface AccountBalanceAsk {
  readonly accountId?: string | null;
  readonly bankCashAccountId?: string | null;
}

export interface AccountBalanceLabels {
  /** "Balance". */
  readonly balance: string;
  /** "Dr" — the side of a debit balance. */
  readonly debit: string;
  /** "Cr" — the side of a credit balance. */
  readonly credit: string;
}

/**
 * The balance of the account chosen in a select, under it — 2026-10-06, by
 * direction: "i want to know the balance for each account we select …
 * directly from the chart of accounts … show it nicely".
 *
 * Read from the general ledger by `load` (a server action) as the signed-in
 * person, so it is the figure the account's own profile shows; a person who
 * may not read the ledger is answered with nothing, and nothing is drawn. The
 * select is found by its name on its form, the way `AdvanceField` reads the
 * lines: the select belongs to the page, this line only listens to it. It
 * follows the choice — a change, or a value the page sets itself (the advance
 * account follows the currency box without an event of its own), so the value
 * is also looked at twice a second, a comparison of two strings.
 *
 * `fallbackAccountId` answers for the empty choice: "As configured" is the
 * account the posting rule would use, and that is the balance shown.
 */
export function AccountBalanceNote({
  selectName,
  formId,
  kind = 'gl',
  fallbackAccountId,
  load,
  labels,
  locale,
}: {
  readonly selectName: string;
  /** The form the select is attached to by its `form` attribute, when it is not inside one. */
  readonly formId?: string;
  /** `gl`: the select's value is a chart-of-accounts id; `bank_cash`: a bank or cash account's. */
  readonly kind?: 'gl' | 'bank_cash';
  readonly fallbackAccountId?: string | null;
  readonly load: (ask: AccountBalanceAsk) => Promise<AccountBalanceView | null>;
  readonly labels: AccountBalanceLabels;
  readonly locale: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [shown, setShown] = useState<AccountBalanceView | null>(null);
  const asked = useRef<string | null>(null);

  // Follow the select.
  useEffect(() => {
    const form = formId ? document.getElementById(formId) : host.current?.closest('form');
    if (!(form instanceof HTMLFormElement)) return;
    const read = () => {
      const field = form.elements.namedItem(selectName);
      const value = field instanceof HTMLSelectElement || field instanceof HTMLInputElement ? field.value : '';
      setChosen((current) => (current === value ? current : value));
    };
    read();
    const field = form.elements.namedItem(selectName);
    const target: EventTarget = field instanceof Element ? field : form;
    target.addEventListener('change', read);
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    const timer = window.setInterval(read, 500);
    return () => {
      target.removeEventListener('change', read);
      form.removeEventListener('input', read);
      form.removeEventListener('change', read);
      window.clearInterval(timer);
    };
  }, [formId, selectName]);

  // Ask the ledger when the choice changes.
  useEffect(() => {
    if (chosen === null) return;
    const ask: AccountBalanceAsk =
      chosen === ''
        ? { accountId: fallbackAccountId ?? null }
        : kind === 'bank_cash'
          ? { bankCashAccountId: chosen }
          : { accountId: chosen };
    const key = `${ask.accountId ?? ''}|${ask.bankCashAccountId ?? ''}`;
    if (asked.current === key) return;
    asked.current = key;
    if (!ask.accountId && !ask.bankCashAccountId) {
      setShown(null);
      return;
    }
    load(ask)
      .then((answer) => {
        if (asked.current === key) setShown(answer);
      })
      .catch(() => {
        if (asked.current === key) setShown(null);
      });
  }, [chosen, fallbackAccountId, kind, load]);

  return (
    <span className={`${styles.sapEnteredNote} tabular-nums`} data-account-balance="" ref={host}>
      {shown ? <BalanceFigure balance={shown} labels={labels} locale={locale} /> : null}
    </span>
  );
}

/**
 * One account's balance, read with the page — for an account that is shown
 * rather than chosen (a record past its draft). The same words as above.
 */
export function AccountBalanceLine({
  balance,
  labels,
  locale,
}: {
  readonly balance: AccountBalanceView | null | undefined;
  readonly labels: AccountBalanceLabels;
  readonly locale: string;
}) {
  if (!balance) return null;
  return (
    <span className={`${styles.sapEnteredNote} tabular-nums`} data-account-balance="">
      <BalanceFigure balance={balance} labels={labels} locale={locale} />
    </span>
  );
}

/**
 * "Balance: IQD 1,250,000 Cr · A200010 Trade payables" — and for an account kept
 * in another currency its own figure first, then the dinars. The side says
 * which way the balance lies (debit less credit, the sign of the figure); the
 * figure itself is shown without a sign. `Number` only at the last step, to
 * format (HARDEN-2).
 */
function BalanceFigure({
  balance,
  labels,
  locale,
}: {
  readonly balance: AccountBalanceView;
  readonly labels: AccountBalanceLabels;
  readonly locale: string;
}) {
  const own = balance.currency && balance.currency !== 'IQD' && balance.balanceTxn !== null ? balance.currency : null;
  const lead = own ? (balance.balanceTxn ?? '0') : balance.balanceIqd;
  const leadValue = scaled(lead, MONEY_PLACES) ?? 0n;
  const side = leadValue > 0n ? 'debit' : leadValue < 0n ? 'credit' : null;
  const figure = (value: string, currency: string) => {
    const amount = scaled(value, MONEY_PLACES) ?? 0n;
    const places = currency === 'IQD' ? 0 : 2;
    return `${currency} ${toNumber(amount < 0n ? -amount : amount, MONEY_PLACES).toLocaleString(locale === 'ar' ? 'ar' : 'en-US', {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    })}`;
  };
  return (
    <>
      <span>{labels.balance}: </span>
      <bdi className="font-medium text-fg" dir="ltr">
        {figure(lead, own ?? 'IQD')}
      </bdi>
      {side ? (
        <span className="ms-1 rounded-md bg-secondary px-1 font-medium text-secondary-fg" data-side={side}>
          {side === 'debit' ? labels.debit : labels.credit}
        </span>
      ) : null}
      {own ? (
        <>
          {' · '}
          <bdi dir="ltr">{figure(balance.balanceIqd, 'IQD')}</bdi>
        </>
      ) : null}
      {' · '}
      <bdi dir="ltr">{balance.code}</bdi> <bdi dir="auto">{balance.name}</bdi>
    </>
  );
}
