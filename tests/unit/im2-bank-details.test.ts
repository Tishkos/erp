import { describe, expect, it } from 'vitest';
import {
  accountNumberProblem,
  compactCode,
  formatIban,
  ibanProblem,
  ibanRemainder,
  swiftCountry,
  swiftProblem,
} from '@/server/domain/bank-details';

/**
 * IMPROVEMENT-002 — a supplier's bank details read as a bank reads them.
 * The IBANs are the registry's published examples; one character changed is
 * caught by the check digits.
 */
describe('IBAN', () => {
  it('accepts the published examples, however they are spaced', () => {
    for (const iban of [
      'GB82 WEST 1234 5698 7654 32',
      'DE89370400440532013000',
      'IQ98 NBIQ 8501 2345 6789 012',
      'AE07 0331 2345 6789 0123 456',
      'TR33 0006 1005 1978 6457 8413 26',
      'SA03 8000 0000 6080 1016 7519',
    ]) {
      expect(ibanProblem(iban), iban).toBeNull();
      expect(ibanRemainder(iban)).toBe(1);
    }
  });

  it('catches a mistyped character by its check digits', () => {
    expect(ibanProblem('GB82 WEST 1234 5698 7654 33')).toMatch(/fails its check digits/);
  });

  it('holds a country to its length', () => {
    expect(ibanProblem('DE8937040044053201300')).toMatch(/from DE has 22 characters; .* has 21/);
  });

  it('refuses what is not an IBAN at all', () => {
    expect(ibanProblem('1234567890')).toMatch(/is not an IBAN/);
    expect(ibanProblem('')).toBeNull();
    expect(ibanProblem(null)).toBeNull();
  });

  it('prints in groups of four', () => {
    expect(formatIban('gb82west12345698765432')).toBe('GB82 WEST 1234 5698 7654 32');
    expect(compactCode(' gb82-west 1234 ')).toBe('GB82WEST1234');
  });
});

describe('SWIFT / BIC', () => {
  it('accepts 8 and 11 characters', () => {
    expect(swiftProblem('BKCHCNBJ')).toBeNull();
    expect(swiftProblem('bkch cnbj 300')).toBeNull();
    expect(swiftProblem('ARABIQBAXXX')).toBeNull();
    expect(swiftCountry('BKCHCNBJ300')).toBe('CN');
  });

  it('refuses another shape', () => {
    expect(swiftProblem('BKCHCNB')).toMatch(/not a SWIFT\/BIC code/);
    expect(swiftProblem('BKCH1NBJ')).toMatch(/not a SWIFT\/BIC code/);
    expect(swiftProblem('BKCHCNBJ30')).toMatch(/not a SWIFT\/BIC code/);
  });
});

describe('account number', () => {
  it('takes letters, digits, spaces, dashes and slashes up to 34', () => {
    expect(accountNumberProblem('6222 0210 0102-3/45')).toBeNull();
    expect(accountNumberProblem('x'.repeat(35))).toMatch(/not an account number/);
    expect(accountNumberProblem('12#45')).toMatch(/not an account number/);
  });
});
