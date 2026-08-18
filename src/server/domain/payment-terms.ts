/**
 * Payment terms, tax codes and price resolution — Phase 03.6 and 03.7.
 *
 * §4.3 lists all three as masters with **effective dates**, and §4.4 says why:
 * "Effective dates are used for exchange rates, prices, tax rates and approval
 * roles."
 *
 * The rule they share is the one the exchange-rate engine already follows: a
 * value is resolved by the **document's** date, never by today's. A price list
 * updated in June must not change what an invoice raised in March was priced
 * at, and a tax rate changed in July must not alter a return already filed.
 */
import { addDays, addMonths, endOfMonth } from './dates';

// ---------------------------------------------------------------------------
// Effective-dated resolution, shared by prices and tax rates
// ---------------------------------------------------------------------------

export interface EffectiveDated {
  readonly effectiveFrom: string;
}

export class NoEffectiveValueError extends Error {
  readonly code = 'NO_EFFECTIVE_VALUE';
  constructor(what: string, onDate: string) {
    super(
      `No ${what} is effective on ${onDate}. ` +
        'Values are resolved by the document date, so one must exist on or before it (§4.4).',
    );
    this.name = 'NoEffectiveValueError';
  }
}

/**
 * The value in force on a date: the latest one effective on or before it.
 *
 * Not the nearest, and not the newest row. A price published on 1 March governs
 * 15 March even after an April price exists — otherwise reprinting a March
 * invoice would produce a different figure, and §4.4's whole point is that it
 * does not.
 */
export function effectiveOn<T extends EffectiveDated>(
  values: readonly T[],
  onDate: string,
  what = 'value',
): T {
  const candidates = values
    .filter((value) => value.effectiveFrom <= onDate)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));

  const selected = candidates[0];
  if (!selected) throw new NoEffectiveValueError(what, onDate);
  return selected;
}

// ---------------------------------------------------------------------------
// §7.3 — prices
// ---------------------------------------------------------------------------

export interface PriceEntry extends EffectiveDated {
  readonly itemId: string;
  readonly uomCode: string;
  /** Decimal string, in the price list's currency. */
  readonly unitPrice: string;
}

export class NoPriceError extends Error {
  readonly code = 'NO_PRICE';
  constructor(
    readonly itemCode: string,
    readonly onDate: string,
  ) {
    super(
      `No price is effective for ${itemCode} on ${onDate}. ` +
        "Unit prices come from the customer's designated Price List and cannot be typed on the order (§7.3).",
    );
    this.name = 'NoPriceError';
  }
}

/**
 * §7.3 — "Unit prices are retrieved from the customer's linked Price List and
 * cannot be edited in the Sales Order."
 *
 * Deterministic and reproducible: the same partner, item and date always give
 * the same price, which is the 03.6 gate.
 */
export function priceOn(
  prices: readonly PriceEntry[],
  itemId: string,
  uomCode: string,
  onDate: string,
  itemCode = itemId,
): PriceEntry {
  const forItem = prices.filter((p) => p.itemId === itemId && p.uomCode === uomCode);
  if (forItem.length === 0) throw new NoPriceError(itemCode, onDate);

  try {
    return effectiveOn(forItem, onDate, `price for ${itemCode}`);
  } catch {
    throw new NoPriceError(itemCode, onDate);
  }
}

// ---------------------------------------------------------------------------
// §4.3 — tax and charge codes
// ---------------------------------------------------------------------------

export interface TaxRateEntry extends EffectiveDated {
  readonly taxCode: string;
  /** Percentage as a decimal string: '15' is fifteen per cent. */
  readonly ratePercent: string;
}

export class TaxAccountError extends Error {
  readonly code = 'TAX_ACCOUNT_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'TaxAccountError';
  }
}

/**
 * §4.3 — recoverable and non-recoverable tax map to different accounts.
 *
 * Recoverable tax is an asset — it is reclaimed. Non-recoverable tax is a cost.
 * Posting both to one account makes the reclaimable balance unknowable, and it
 * is discovered at the first tax return.
 */
export function assertTaxAccountsDistinct(
  codes: readonly { code: string; isRecoverable: boolean; accountId: string }[],
): void {
  const byAccount = new Map<string, { code: string; isRecoverable: boolean }[]>();

  for (const entry of codes) {
    byAccount.set(entry.accountId, [...(byAccount.get(entry.accountId) ?? []), entry]);
  }

  for (const [accountId, sharing] of byAccount) {
    const recoverable = sharing.some((c) => c.isRecoverable);
    const nonRecoverable = sharing.some((c) => !c.isRecoverable);

    if (recoverable && nonRecoverable) {
      throw new TaxAccountError(
        `Account ${accountId} is mapped to both recoverable and non-recoverable tax codes ` +
          `(${sharing.map((c) => c.code).join(', ')}). Recoverable tax is an asset and non-recoverable ` +
          'tax is a cost; one account cannot be both.',
      );
    }
  }
}

export function taxRateOn(
  rates: readonly TaxRateEntry[],
  taxCode: string,
  onDate: string,
): TaxRateEntry {
  return effectiveOn(
    rates.filter((r) => r.taxCode === taxCode),
    onDate,
    `rate for tax code ${taxCode}`,
  );
}

// ---------------------------------------------------------------------------
// §4.3, §16 — payment terms and due dates
// ---------------------------------------------------------------------------

/** How the base date for a term is chosen. */
export const DUE_DATE_BASIS = ['document_date', 'end_of_month'] as const;
export type DueDateBasis = (typeof DUE_DATE_BASIS)[number];

export interface PaymentTermInstalment {
  /** 1-based. */
  readonly sequence: number;
  /** Days after the basis date this instalment falls due. */
  readonly daysAfter: number;
  /** Share of the invoice, as a percentage. All instalments must total 100. */
  readonly percentage: string;
}

export interface PaymentTerms {
  readonly code: string;
  readonly name: string;
  readonly basis: DueDateBasis;
  /** For a single-payment term. Ignored when instalments are configured. */
  readonly dueDays: number;
  readonly instalments: readonly PaymentTermInstalment[];
}

export class PaymentTermsError extends Error {
  readonly code = 'PAYMENT_TERMS_INVALID';
  constructor(detail: string) {
    super(`Payment terms are not usable: ${detail}`);
    this.name = 'PaymentTermsError';
  }
}

/** The instalments must add to the whole invoice, or part of it is never due. */
export function assertInstalmentsComplete(terms: PaymentTerms): void {
  if (terms.instalments.length === 0) return;

  const total = terms.instalments.reduce(
    (sum, instalment) => sum + parseHundredths(instalment.percentage),
    0n,
  );

  if (total !== 10_000n) {
    throw new PaymentTermsError(
      `${terms.code} instalments total ${formatHundredths(total)}%, not 100%. ` +
        'Every part of the invoice must fall due on some date.',
    );
  }

  const sequences = terms.instalments.map((i) => i.sequence).sort((a, b) => a - b);
  const expected = sequences.map((_, index) => index + 1);
  if (JSON.stringify(sequences) !== JSON.stringify(expected)) {
    throw new PaymentTermsError(
      `${terms.code} instalments must be numbered 1..${terms.instalments.length} with no gaps.`,
    );
  }

  for (const instalment of terms.instalments) {
    if (instalment.daysAfter < 0) {
      throw new PaymentTermsError(
        `${terms.code} instalment ${instalment.sequence} falls due ${instalment.daysAfter} days after the invoice.`,
      );
    }
  }
}

/** The date a term's clock starts from. */
export function basisDateFor(terms: PaymentTerms, documentDate: string): string {
  return terms.basis === 'end_of_month' ? endOfMonth(documentDate) : documentDate;
}

/** The single due date of a term with no instalments (§16). */
export function dueDateFor(terms: PaymentTerms, documentDate: string): string {
  if (terms.instalments.length > 0) {
    const schedule = instalmentSchedule(terms, documentDate, '0');
    return schedule[schedule.length - 1]!.dueDate;
  }

  return addDays(basisDateFor(terms, documentDate), terms.dueDays);
}

export interface ScheduledInstalment {
  readonly sequence: number;
  readonly dueDate: string;
  /** Scaled by MONEY_SCALE, as elsewhere in the system. */
  readonly amount: bigint;
}

/**
 * §16 — the instalment schedule.
 *
 * The last instalment absorbs the rounding, so the parts always add back to the
 * invoice exactly. Distributing the remainder across instalments would be
 * defensible arithmetic and indefensible accounting: the total would move
 * depending on how it was split.
 */
export function instalmentSchedule(
  terms: PaymentTerms,
  documentDate: string,
  totalAmount: string,
): ScheduledInstalment[] {
  assertInstalmentsComplete(terms);

  const basis = basisDateFor(terms, documentDate);
  const total = parseScaled(totalAmount);

  if (terms.instalments.length === 0) {
    return [{ sequence: 1, dueDate: addDays(basis, terms.dueDays), amount: total }];
  }

  const ordered = [...terms.instalments].sort((a, b) => a.sequence - b.sequence);
  const schedule: ScheduledInstalment[] = [];
  let allocated = 0n;

  for (const [index, instalment] of ordered.entries()) {
    const isLast = index === ordered.length - 1;
    const amount = isLast
      ? total - allocated
      : (total * parseHundredths(instalment.percentage)) / 10_000n;

    allocated += amount;
    schedule.push({
      sequence: instalment.sequence,
      dueDate: addDays(basis, instalment.daysAfter),
      amount,
    });
  }

  return schedule;
}

/** Months-based terms, for the "net 2 months" style §16 also allows. */
export function dueDateAfterMonths(documentDate: string, months: number): string {
  return addMonths(documentDate, months);
}

function parseHundredths(percentage: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percentage.trim());
  if (!match) {
    throw new PaymentTermsError(`"${percentage}" is not a percentage`);
  }
  return BigInt(`${match[1]}${(match[2] ?? '').padEnd(2, '0')}`);
}

function formatHundredths(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

function parseScaled(amount: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(amount.trim());
  if (!match) {
    throw new PaymentTermsError(`"${amount}" is not an amount`);
  }
  const scaled = BigInt(`${match[2]}${(match[3] ?? '').padEnd(4, '0')}`);
  return match[1] === '-' ? -scaled : scaled;
}
