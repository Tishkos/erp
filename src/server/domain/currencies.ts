/**
 * The currencies a company may keep its books in, and a document may be
 * priced in. ISO 4217 codes; by direction the company trades in exactly these
 * four, so a picker offers exactly these four. Adding one is a
 * line here — rates live in Master Data → Currencies and Rates.
 */
export interface Currency {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

export const CURRENCIES: readonly Currency[] = [
  { code: 'IQD', name: 'Iraqi dinar', symbol: 'د.ع', decimals: 0 },
  { code: 'USD', name: 'US dollar', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
  { code: 'CNY', name: 'Chinese yuan', symbol: '¥', decimals: 2 },
];

export function currency(code: string): Currency | undefined {
  return CURRENCIES.find((c) => c.code === code.toUpperCase());
}
