'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { IntentSelect } from '@/components/admin/intent-select';

/** Fired on the form (bubbling from the select) whenever the account chosen changes; `detail` is its id or ''. */
export const ADVANCE_ACCOUNT_EVENT = 'erp:advance-account';

export interface AdvanceAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string;
}

/**
 * Where the advance leaves from — §15.3, widened 2026-10-06 by direction
 * ("automatically 20% percentage payment application when applied").
 *
 * A payment application cannot exist without the account it is paid from, and
 * an import is paid from an account in its own currency (D3). So the list
 * follows the form's currency box the way `AdvanceField` follows the lines:
 * only the accounts in that currency are offered, the first of them is chosen
 * when the Import box is ticked, and a choice the accountant made stays until
 * the currency makes it impossible. Untick Import and nothing is chosen — a
 * local purchase has no payment application to raise.
 *
 * Nothing here is submitted but the account's id; the service checks it again
 * against the import's currency before anything is written.
 */
export function AdvanceAccountSelect({
  label,
  name,
  accounts,
  currencyField,
  importField,
  noneLabel,
}: {
  readonly label: string;
  readonly name: string;
  readonly accounts: readonly AdvanceAccount[];
  readonly currencyField: string;
  readonly importField?: string;
  readonly noneLabel: string;
}) {
  const box = useRef<HTMLSelectElement>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [imported, setImported] = useState(true);
  const [chosen, setChosen] = useState('');
  // Once the accountant has chosen, the default never comes back over it — unless the currency leaves it behind.
  const typedRef = useRef(false);

  useEffect(() => {
    const form = box.current?.form;
    if (!form) return;
    const read = () => {
      const money = form.elements.namedItem(currencyField);
      const tick = importField ? form.elements.namedItem(importField) : null;
      setCurrency(money instanceof HTMLSelectElement || money instanceof HTMLInputElement ? money.value || 'IQD' : 'IQD');
      setImported(tick instanceof HTMLInputElement ? tick.checked : true);
    };
    read();
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    return () => {
      form.removeEventListener('input', read);
      form.removeEventListener('change', read);
    };
  }, [currencyField, importField]);

  const offered = useMemo(
    () => (currency === null ? accounts : accounts.filter((account) => account.currency === currency)),
    [accounts, currency],
  );

  useEffect(() => {
    if (currency === null) return;
    if (!imported) {
      // No import, no application: nothing is chosen, and the default is free to return when it is ticked again.
      typedRef.current = false;
      if (chosen !== '') setChosen('');
      return;
    }
    // A choice that still stands, stands — "none" included, once the accountant chose it.
    if (chosen !== '' && offered.some((account) => account.id === chosen)) return;
    if (chosen === '' && typedRef.current) return;
    // Nothing chosen yet, or the currency left the choice behind: the first account in that currency.
    const first = offered[0]?.id ?? '';
    if (first !== chosen) setChosen(first);
  }, [chosen, currency, imported, offered]);

  // Say what is chosen to the rest of the form — the advance's selection waits for an account (2026-10-07,
  // by direction: "if there is no bank account the payable upfront cannot be selected"). A value set here by
  // the defaults fires no input event of its own, so the form is told.
  useEffect(() => {
    box.current?.dispatchEvent(new CustomEvent(ADVANCE_ACCOUNT_EVENT, { bubbles: true, detail: chosen }));
  }, [chosen]);

  return (
    <IntentSelect
      aria-label={label}
      name={name}
      onChange={(event) => {
        typedRef.current = true;
        setChosen(event.target.value);
      }}
      ref={box}
      value={chosen}
    >
      <option value="">{noneLabel}</option>
      {offered.map((account) => (
        <option key={account.id} value={account.id}>
          {`${account.code} · ${account.name} (${account.currency})`}
        </option>
      ))}
    </IntentSelect>
  );
}
