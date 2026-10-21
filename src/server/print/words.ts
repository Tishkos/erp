import { formatMoney, type Locale } from '@/i18n/config';
import type { PrintModel } from './model';

/**
 * An amount written out in words, as a cheque or an invoice says it under the
 * figure (2026-10-21, by direction: "2,000 IQD should be two thousand IQD —
 * in Arabic too"): "Two thousand Iraqi dinars" / "ألفان دينار عراقي".
 *
 * Exact: the figure is read as a decimal string and split into whole units
 * and their fraction as integers, never through a float. Dinars are written
 * whole, as the page prints them (rounded half up); dollars with their cents.
 * The Arabic follows the usual tafqit: the units, tens and hundreds joined by
 * "و", a scale word in its dual (ألفان), plural (ثلاثة آلاف) or accusative
 * singular (أحد عشر ألفًا) as the count asks, the currency named once in the
 * singular, as Iraqi cheques write it ("فقط … دينار عراقي لا غير").
 */

type Currency = 'IQD' | 'USD';

const MONEY = /^‎?\s*(-|\()?\s*([\d,]+(?:\.\d+)?)\)?\s*(IQD|USD)\s*$/;

/** A printed figure ("47,190,000 IQD", "(10,000) IQD") back into a signed decimal and its currency. */
export function readPrintedMoney(text: string): { amount: string; currency: Currency } | null {
  const match = MONEY.exec(text.trim());
  if (!match) return null;
  const digits = match[2]!.replace(/,/g, '');
  return { amount: match[1] ? `-${digits}` : digits, currency: match[3] as Currency };
}

/**
 * The amount a document is for, to be written in words: what the builder
 * names (`amountInWords`), else the first money figure of its summary (a
 * payment's or a receipt's amount), else its first table's total in the last
 * money column that has one (an invoice's amount). Reports are not spelt.
 */
export function spelledAmountOf(model: PrintModel): { amount: string; currency: Currency } | null {
  if (model.amountInWords === null) return null;
  if (model.amountInWords) return { amount: model.amountInWords.amount, currency: model.amountInWords.currency ?? model.currency };
  if (model.kind !== 'document') return null;
  for (const fact of model.summary) {
    const money = readPrintedMoney(fact.value);
    if (money) return money;
  }
  for (const table of model.tables) {
    if (!table.totals) continue;
    const columns = table.columns.filter((column) => column.kind === 'money' && (table.totals!.cells[column.key] ?? null) !== null);
    const last = columns[columns.length - 1];
    if (last) return { amount: table.totals.cells[last.key]!, currency: (last.currency as Currency | undefined) ?? model.currency };
  }
  return null;
}

/** "Forty-seven million … Iraqi dinars" / "سبعة وأربعون مليونًا … دينار عراقي", or null for nought or what cannot be read. */
export function amountInWords(amount: string, currency: Currency, locale: Locale): string | null {
  const match = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(amount);
  if (!match) return null;
  const negative = Boolean(match[1]);
  let whole = BigInt(match[2]!);
  const fractionDigits = match[3] ?? '';
  let minor = 0n;
  if (currency === 'IQD') {
    // Whole dinars, half up, as the figure is printed.
    if (fractionDigits && Number(fractionDigits[0]) >= 5) whole += 1n;
  } else {
    // Cents, half up on the third place.
    const padded = (fractionDigits + '000').slice(0, 3);
    minor = BigInt(padded.slice(0, 2)) + (Number(padded[2]) >= 5 ? 1n : 0n);
    if (minor === 100n) {
      whole += 1n;
      minor = 0n;
    }
  }
  if (whole === 0n && minor === 0n) return null;
  return locale === 'ar' ? arabic(whole, minor, currency, negative) : english(whole, minor, currency, negative);
}

/**
 * What the three formats print under the figures: the amount in figures with
 * its currency ("57,190,000 IQD") beside the same amount in words — both, by
 * direction (2026-10-22: "no amount in numbers … should contain also the
 * amount in numbers and currency").
 */
export function amountLineOf(model: PrintModel, locale: Locale): { figure: string; words: string } | null {
  const spelled = spelledAmountOf(model);
  if (!spelled) return null;
  const words = amountInWords(spelled.amount, spelled.currency, locale);
  if (!words) return null;
  return { figure: formatMoney(spelled.amount, spelled.currency, locale).replace(/\u200e/g, ''), words };
}

// ------------------------------------------------------------------- English

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion'];

function englishBelowThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`);
  const rest = n % 100;
  if (rest >= 20) parts.push(rest % 10 ? `${EN_TENS[Math.floor(rest / 10)]}-${EN_ONES[rest % 10]}` : EN_TENS[Math.floor(rest / 10)]!);
  else if (rest > 0) parts.push(EN_ONES[rest]!);
  return parts.join(' ');
}

export function englishNumber(value: bigint): string {
  if (value === 0n) return 'zero';
  const groups = groupsOf(value);
  const parts: string[] = [];
  groups.forEach((group, index) => {
    if (group === 0) return;
    const scale = EN_SCALES[groups.length - 1 - index]!;
    parts.push(scale ? `${englishBelowThousand(group)} ${scale}` : englishBelowThousand(group));
  });
  return parts.join(' ');
}

function english(whole: bigint, minor: bigint, currency: Currency, negative: boolean): string {
  const [one, many, minorOne, minorMany] =
    currency === 'IQD' ? ['Iraqi dinar', 'Iraqi dinars', 'fils', 'fils'] : ['US dollar', 'US dollars', 'cent', 'cents'];
  const parts: string[] = [];
  if (whole > 0n) parts.push(`${englishNumber(whole)} ${whole === 1n ? one : many}`);
  if (minor > 0n) parts.push(`${englishNumber(minor)} ${minor === 1n ? minorOne : minorMany}`);
  const text = `${negative ? 'minus ' : ''}${parts.join(' and ')}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// -------------------------------------------------------------------- Arabic

const AR_ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const AR_TEENS = ['عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = ['', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة', 'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة'];
/** One, two, three to ten, eleven and more — for each scale. */
const AR_SCALES: readonly { one: string; two: string; plural: string; many: string }[] = [
  { one: 'ألف', two: 'ألفان', plural: 'آلاف', many: 'ألفًا' },
  { one: 'مليون', two: 'مليونان', plural: 'ملايين', many: 'مليونًا' },
  { one: 'مليار', two: 'ملياران', plural: 'مليارات', many: 'مليارًا' },
  { one: 'ترليون', two: 'ترليونان', plural: 'ترليونات', many: 'ترليونًا' },
  { one: 'كوادرليون', two: 'كوادرليونان', plural: 'كوادرليونات', many: 'كوادرليونًا' },
];

function arabicBelowHundred(n: number): string {
  if (n === 0) return '';
  if (n < 10) return AR_ONES[n]!;
  if (n < 20) return AR_TEENS[n - 10]!;
  const ones = n % 10;
  const tens = AR_TENS[Math.floor(n / 10)]!;
  return ones ? `${AR_ONES[ones]} و${tens}` : tens;
}

function arabicBelowThousand(n: number): string {
  const hundreds = AR_HUNDREDS[Math.floor(n / 100)]!;
  const rest = arabicBelowHundred(n % 100);
  return [hundreds, rest].filter(Boolean).join(' و');
}

/** A group of three digits with its scale word, in the form the count asks for. */
function arabicScaled(group: number, scale: (typeof AR_SCALES)[number]): string {
  if (group === 1) return scale.one;
  if (group === 2) return scale.two;
  const hundreds = Math.floor(group / 100);
  const rest = group % 100;
  if (rest >= 3 && rest <= 10) return `${arabicBelowThousand(group)} ${scale.plural}`;
  if (rest >= 11) return `${arabicBelowThousand(group)} ${scale.many}`;
  // Whole hundreds: مئة ألف, مئتا ألف, ثلاثمئة ألف.
  if (rest === 0) return `${hundreds === 2 ? 'مئتا' : AR_HUNDREDS[hundreds]} ${scale.one}`;
  // مئة وألف, مئتان وألفان.
  return `${AR_HUNDREDS[hundreds]} و${rest === 1 ? scale.one : scale.two}`;
}

export function arabicNumber(value: bigint): string {
  if (value === 0n) return 'صفر';
  const groups = groupsOf(value);
  const parts: string[] = [];
  groups.forEach((group, index) => {
    if (group === 0) return;
    const level = groups.length - 1 - index;
    parts.push(level === 0 ? arabicBelowThousand(group) : arabicScaled(group, AR_SCALES[level - 1]!));
  });
  return parts.join(' و');
}

function arabic(whole: bigint, minor: bigint, currency: Currency, negative: boolean): string {
  const [unit, minorUnit] = currency === 'IQD' ? ['دينار عراقي', 'فلس'] : ['دولار أمريكي', 'سنت'];
  const parts: string[] = [];
  // دينار عراقي واحد — the count after the noun for one, as Arabic says it.
  if (whole > 0n) parts.push(whole === 1n ? `${unit} واحد` : `${arabicNumber(whole)} ${unit}`);
  if (minor > 0n) parts.push(`${arabicNumber(minor)} ${minorUnit}`);
  return `${negative ? 'سالب ' : ''}${parts.join(' و')}`;
}

/** Three-digit groups, the largest first. */
function groupsOf(value: bigint): number[] {
  const groups: number[] = [];
  let rest = value;
  while (rest > 0n) {
    groups.unshift(Number(rest % 1000n));
    rest /= 1000n;
  }
  return groups;
}
