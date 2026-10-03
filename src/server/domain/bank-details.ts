/**
 * A supplier's bank details, read as a bank reads them — IMPROVEMENT-002
 * (sponsor, 2026-10-03: "I cannot verify a supplier SWIFT account anywhere …
 * suppliers can have multiple SWIFT and IBAN accounts … full account set up in
 * their profile").
 *
 * Pure: the shape of a SWIFT/BIC (ISO 9362) and of an IBAN (ISO 13616, with
 * its mod-97 check and the length its country gives it). A transfer file built
 * on a mistyped IBAN is returned by the bank days later, or — worse — lands in
 * somebody else's account; the check digits exist so the mistake is caught at
 * the keyboard, and here is where it is.
 */

/** Spaces and dashes out, upper case — how an IBAN or a BIC is compared. */
export function compactCode(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s-]+/g, '').toUpperCase();
}

/** An IBAN printed the way banks print it: groups of four. */
export function formatIban(value: string): string {
  return compactCode(value).replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * IBAN length by country (ISO 13616 registry). A country not listed is held to
 * the general 15–34 and its check digits, which still catch a typo.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22,
  IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18,
  NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SD: 18,
  SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
};

/** The IBAN's mod-97 remainder, computed piecewise so no number overflows. */
export function ibanRemainder(iban: string): number {
  const compact = compactCode(iban);
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/** What is wrong with an IBAN, in a sentence — or null when it is right. */
export function ibanProblem(value: string | null | undefined): string | null {
  const iban = compactCode(value);
  if (!iban) return null;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) {
    return `${formatIban(iban)} is not an IBAN: two letters for the country, two check digits, then the account.`;
  }
  const country = iban.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  if (expected !== undefined && iban.length !== expected) {
    return `An IBAN from ${country} has ${expected} characters; ${formatIban(iban)} has ${iban.length}.`;
  }
  if (expected === undefined && (iban.length < 15 || iban.length > 34)) {
    return `An IBAN has 15 to 34 characters; ${formatIban(iban)} has ${iban.length}.`;
  }
  if (ibanRemainder(iban) !== 1) {
    return `${formatIban(iban)} fails its check digits — a character is mistyped.`;
  }
  return null;
}

/** What is wrong with a SWIFT/BIC, in a sentence — or null when it is right. */
export function swiftProblem(value: string | null | undefined): string | null {
  const bic = compactCode(value);
  if (!bic) return null;
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    return `${bic} is not a SWIFT/BIC code: 8 or 11 characters — the bank (4 letters), the country (2), the place (2), and the branch (3, optional).`;
  }
  return null;
}

/** The country a SWIFT/BIC names (its 5th and 6th letters). */
export function swiftCountry(value: string | null | undefined): string | null {
  const bic = compactCode(value);
  return bic.length >= 6 ? bic.slice(4, 6) : null;
}

/** An account number as entered: letters, digits, spaces, dashes and slashes. */
export function accountNumberProblem(value: string | null | undefined): string | null {
  const number = (value ?? '').trim();
  if (!number) return null;
  if (number.length > 34 || !/^[A-Za-z0-9 /-]+$/.test(number)) {
    return `"${number}" is not an account number: up to 34 letters and digits.`;
  }
  return null;
}
