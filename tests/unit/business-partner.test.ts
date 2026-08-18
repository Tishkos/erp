/**
 * Phase 03.2 test gate — roles, status and duplicate identification.
 *
 * The duplicate *search* and the bank-detail approval need a database and are
 * in tests/integration/phase03-master-data.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  PARTNER_STATUSES,
  PartnerFieldRequiredError,
  PartnerNotUsableError,
  PartnerRoleError,
  assertHasRole,
  assertRoleFields,
  assertUsableForTransaction,
  matchedIdentifiers,
  normaliseEmail,
  normaliseName,
  normalisePhone,
} from '@domain/business-partner';

describe('§6 · a partner is a customer, a supplier, or both', () => {
  it('accepts either role, or both', () => {
    expect(() => assertHasRole({ isCustomer: true, isSupplier: false })).not.toThrow();
    expect(() => assertHasRole({ isCustomer: false, isSupplier: true })).not.toThrow();
    expect(() => assertHasRole({ isCustomer: true, isSupplier: true })).not.toThrow();
  });

  it('refuses a record with neither', () => {
    expect(() => assertHasRole({ isCustomer: false, isSupplier: false })).toThrow(
      PartnerRoleError,
    );
  });

  it('has the five statuses §6 names', () => {
    expect(PARTNER_STATUSES).toEqual(['prospect', 'active', 'on_hold', 'blocked', 'inactive']);
  });
});

describe('§6 · who may be used on a transaction', () => {
  const partner = (status: (typeof PARTNER_STATUSES)[number], active = true) => ({
    code: 'BP-001',
    status,
    active,
  });

  it('permits an active partner', () => {
    expect(() => assertUsableForTransaction(partner('active'))).not.toThrow();
  });

  it('refuses a blocked partner', () => {
    expect(() => assertUsableForTransaction(partner('blocked'))).toThrow(PartnerNotUsableError);
    expect(() => assertUsableForTransaction(partner('blocked'))).toThrow(
      /without an authorised override/,
    );
  });

  it('refuses on-hold, inactive and prospect', () => {
    // §6 — "A lead can exist without an approved Business Partner; a Sales
    // Order, Project, invoice or service transaction cannot."
    for (const status of ['on_hold', 'inactive', 'prospect'] as const) {
      expect(() => assertUsableForTransaction(partner(status)), status).toThrow(
        PartnerNotUsableError,
      );
    }
  });

  it('refuses a deactivated partner whatever its status says', () => {
    expect(() => assertUsableForTransaction(partner('active', false))).toThrow(/inactive/);
  });

  it('permits an override, which the caller must have authority for', () => {
    expect(() =>
      assertUsableForTransaction(partner('blocked'), { override: true }),
    ).not.toThrow();
  });
});

describe('Appendix B · role-specific mandatory fields', () => {
  it('enforces nothing when nothing is configured', () => {
    // Which fields are mandatory is a business decision (§28); the mechanism is
    // built, the policy is the Business Process Owner's.
    expect(() => assertRoleFields('customer', [], {})).not.toThrow();
  });

  it('enforces what is configured', () => {
    expect(() =>
      assertRoleFields('customer', ['creditLimitIqd', 'email'], { email: 'a@b.com' }),
    ).toThrow(PartnerFieldRequiredError);

    expect(() =>
      assertRoleFields('customer', ['creditLimitIqd'], { creditLimitIqd: '1000.0000' }),
    ).not.toThrow();
  });

  it('names every missing field at once', () => {
    expect(() => assertRoleFields('supplier', ['taxIdentifier', 'phone'], {})).toThrow(
      /must carry taxIdentifier, phone/,
    );
  });

  it('treats an empty string as missing', () => {
    expect(() => assertRoleFields('customer', ['email'], { email: '' })).toThrow(
      PartnerFieldRequiredError,
    );
  });
});

describe('§4.4 · recognising the same party typed twice', () => {
  it('sees through case, punctuation and spacing in a name', () => {
    expect(normaliseName('Al-Rafidain Trading Co.')).toBe(normaliseName('al rafidain trading co'));
    expect(normaliseName('  ACME   LLC  ')).toBe('acme llc');
  });

  it('sees through phone formatting', () => {
    expect(normalisePhone('+964 770 123 4567')).toBe(normalisePhone('07701234567'));
    expect(normalisePhone('00964-770-123-4567')).toBe('07701234567');
  });

  it('sees through email case and spacing', () => {
    expect(normaliseEmail('  Sales@Example.COM ')).toBe('sales@example.com');
  });

  it('reports every identifier two records share', () => {
    const matched = matchedIdentifiers(
      {
        legalName: 'Al-Rafidain Trading Co.',
        email: 'SALES@rafidain.iq',
        phone: '+964 770 123 4567',
        registrationNo: 'REG-9911',
      },
      {
        legalName: 'al rafidain trading co',
        email: 'sales@rafidain.iq',
        phone: '07701234567',
        registrationNo: 'REG-9911',
      },
    );

    expect(matched.sort()).toEqual(['email', 'name', 'phone', 'registration number']);
  });

  it('reports nothing for two genuinely different parties', () => {
    expect(
      matchedIdentifiers(
        { legalName: 'Baghdad Steel', email: 'a@b.iq' },
        { legalName: 'Basra Cement', email: 'c@d.iq' },
      ),
    ).toEqual([]);
  });

  it('does not match on an identifier only one side carries', () => {
    // Two records with no registration number are not thereby the same company.
    expect(
      matchedIdentifiers(
        { legalName: 'Baghdad Steel', registrationNo: null },
        { legalName: 'Basra Cement', registrationNo: null },
      ),
    ).toEqual([]);
  });
});
