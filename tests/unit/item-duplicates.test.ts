/**
 * Phase 03.3 test gate — *"Item duplicate detection runs before save."*
 *
 * §4.4 requires duplicate detection on master data. For an item the stakes are
 * higher than tidiness: two records for one product split its stock and its
 * FIFO layers, and §1.1 forbids the deletion that merging them would need.
 */
import { describe, expect, it } from 'vitest';
import {
  DuplicateItemError,
  assertNotDuplicateItem,
  findItemDuplicates,
  matchedItemIdentifiers,
  normaliseBarcode,
  normaliseItemName,
  type ItemIdentity,
} from '@domain/item-duplicates';

const existing: ItemIdentity[] = [
  {
    id: 'i1',
    code: 'ITM-0001',
    name: 'Al-Rafidain Cable 2m',
    barcodes: ['6291041500213'],
    supplierItemCodes: [{ supplierCode: 'SUP-1', itemCode: 'RC-2M' }],
  },
  {
    id: 'i2',
    code: 'ITM-0002',
    name: 'Al-Rafidain Cable 3m',
    barcodes: ['6291041500220'],
    supplierItemCodes: [],
  },
];

describe('§4.4 · normalising what people retype', () => {
  it('treats case, punctuation and spacing as noise', () => {
    expect(normaliseItemName('Al-Rafidain  Cable, 2m')).toBe(normaliseItemName('al rafidain cable 2m'));
  });

  it('keeps digits, because in an item name they are the size', () => {
    // "Cable 2m" and "Cable 3m" are different products, and collapsing them
    // would produce a warning people learn to click through.
    expect(normaliseItemName('Cable 2m')).not.toBe(normaliseItemName('Cable 3m'));
  });

  it('compares a barcode without its separators', () => {
    expect(normaliseBarcode('6291-0415-0021-3')).toBe('6291041500213');
  });
});

describe('03.3 gate · what counts as a duplicate item', () => {
  it('matches on the name', () => {
    expect(
      matchedItemIdentifiers({ name: 'AL RAFIDAIN CABLE 2M' }, existing[0]!),
    ).toEqual(['name']);
  });

  it('matches on a barcode, which identifies one product', () => {
    expect(
      matchedItemIdentifiers({ name: 'Something else', barcodes: ['6291041500213'] }, existing[0]!),
    ).toEqual(['barcode']);
  });

  it('matches on the same supplier’s code for the same thing', () => {
    expect(
      matchedItemIdentifiers(
        { name: 'Other', supplierItemCodes: [{ supplierCode: 'SUP-1', itemCode: 'rc-2m' }] },
        existing[0]!,
      ),
    ).toEqual(['supplier item code']);
  });

  it('does not match the same code from a different supplier', () => {
    // Two suppliers using the same internal code for different products is
    // ordinary, not a duplicate.
    expect(
      matchedItemIdentifiers(
        { name: 'Other', supplierItemCodes: [{ supplierCode: 'SUP-2', itemCode: 'RC-2M' }] },
        existing[0]!,
      ),
    ).toEqual([]);
  });

  it('reports every identifier that matched, not just the first', () => {
    expect(
      matchedItemIdentifiers(
        { name: 'Al-Rafidain Cable 2m', barcodes: ['6291041500213'] },
        existing[0]!,
      ),
    ).toEqual(['name', 'barcode']);
  });

  it('finds nothing for a genuinely new item', () => {
    expect(findItemDuplicates({ name: 'Ethernet Switch 8-port' }, existing)).toEqual([]);
  });

  it('does not report an item as its own duplicate when it is edited', () => {
    expect(
      findItemDuplicates({ id: 'i1', name: 'Al-Rafidain Cable 2m' }, existing),
    ).toEqual([]);
  });
});

describe('03.3 gate · the check runs before the save', () => {
  it('refuses a duplicate, naming what matched and what to do', () => {
    try {
      assertNotDuplicateItem({ name: 'al-rafidain cable 2m' }, existing);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateItemError);
      const e = error as DuplicateItemError;
      expect(e.matches[0]!.itemCode).toBe('ITM-0001');
      expect(e.matches[0]!.matchedOn).toEqual(['name']);
      // §25 — reason and corrective action, including why it matters.
      expect(e.message).toMatch(/split its stock and its FIFO layers/);
    }
  });

  it('permits the save once a person has confirmed it is a different product', () => {
    // The override is the user's judgement; the service records it (§4.4).
    expect(() =>
      assertNotDuplicateItem({ name: 'al-rafidain cable 2m' }, existing, {
        confirmedNotDuplicate: true,
      }),
    ).not.toThrow();
  });

  it('permits a new item that matches nothing', () => {
    expect(() => assertNotDuplicateItem({ name: 'Fibre Patch Panel' }, existing)).not.toThrow();
  });
});
