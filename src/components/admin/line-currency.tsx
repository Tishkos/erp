'use client';

import { useEffect } from 'react';

/**
 * The currency follows the account.
 *
 * An account may be tied to one currency — a dollar bank account holds dollars
 * and nothing else. Leaving the two controls independent means a person picks
 * that account, leaves the currency on IQD because that is where it was, and is
 * refused after they have typed the amount. The account is the thing they chose
 * deliberately, so it wins: choosing it sets the currency and greys out every
 * other option, which shows *why* the choice is gone rather than silently
 * removing it.
 *
 * An account with no restriction leaves every currency open again.
 *
 * The select stays enabled throughout — a disabled `<select>` submits nothing,
 * and the server would then fall back to IQD, which is the bug this fixes. The
 * server re-checks the pairing regardless, so this is a convenience, never the
 * control.
 */
export function LineCurrency({
  accountSelectId,
  currencySelectId,
  restrictions,
}: {
  readonly accountSelectId: string;
  readonly currencySelectId: string;
  /** Account id → the only currency it accepts, or null when it accepts any. */
  readonly restrictions: Readonly<Record<string, string | null>>;
}) {
  useEffect(() => {
    const account = document.getElementById(accountSelectId) as HTMLSelectElement | null;
    const currency = document.getElementById(currencySelectId) as HTMLSelectElement | null;
    if (!account || !currency) return;

    const apply = () => {
      const only = restrictions[account.value] ?? null;
      for (const option of Array.from(currency.options)) {
        option.disabled = only !== null && option.value !== only;
      }
      if (only !== null) currency.value = only;
    };

    apply();
    account.addEventListener('change', apply);
    return () => account.removeEventListener('change', apply);
  }, [accountSelectId, currencySelectId, restrictions]);

  return null;
}
