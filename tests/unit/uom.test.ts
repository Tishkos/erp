/**
 * Phase 03.3 test gate — UOM conversion and the two §9 prohibitions.
 */
import { describe, expect, it } from 'vitest';
import {
  COSTING_METHODS,
  ITEM_TRACKING,
  InexactConversionError,
  ItemDefinitionError,
  ItemInactiveError,
  UomConversionError,
  assertItemDefinition,
  assertItemUsableOn,
  convert,
  formatQuantity,
  fromBase,
  parseQuantity,
  toBase,
  toBaseExact,
  type ItemDefinition,
  type UomConversion,
} from '@domain/uom';

/** A box of twelve. */
const box: UomConversion = { uomCode: 'BOX', numerator: 12n, denominator: 1n };
/** A box of three — the case a decimal factor cannot represent. */
const boxOfThree: UomConversion = { uomCode: 'BOX3', numerator: 3n, denominator: 1n };
/** The base unit converts to itself at one. */
const each: UomConversion = { uomCode: 'EA', numerator: 1n, denominator: 1n };
/** A gram, as a thousandth of the base kilogram. */
const gram: UomConversion = { uomCode: 'G', numerator: 1n, denominator: 1000n };

describe('quantities are exact decimals', () => {
  it('parses and formats to six places', () => {
    expect(parseQuantity('1')).toBe(1_000_000n);
    expect(parseQuantity('1.5')).toBe(1_500_000n);
    expect(parseQuantity('0.000001')).toBe(1n);
    expect(formatQuantity(1_500_000n)).toBe('1.5');
    expect(formatQuantity(1_000_000n)).toBe('1');
  });

  it('keeps the zeros that are part of the number', () => {
    // Three services had added a second "strip trailing zeros" pass on top of
    // this one, and it turned 40 into 4 — a validation message that told the
    // warehouse the wrong figure. `formatQuantity` already drops the fractional
    // tail; a second pass cannot tell a fractional zero from the last digit of
    // a round number.
    expect(formatQuantity(40_000_000n)).toBe('40');
    expect(formatQuantity(100_000_000n)).toBe('100');
    expect(formatQuantity(10_500_000n)).toBe('10.5');
    expect(formatQuantity(0n)).toBe('0');
  });

  it('refuses more precision than it can hold', () => {
    expect(() => parseQuantity('1.0000001')).toThrow(UomConversionError);
    expect(() => parseQuantity('one')).toThrow(UomConversionError);
  });
});

describe('§9.3 · converting between units', () => {
  it('converts to the base unit', () => {
    expect(formatQuantity(toBase(parseQuantity('5'), box))).toBe('60');
  });

  it('converts back from the base unit', () => {
    expect(formatQuantity(fromBase(parseQuantity('60'), box))).toBe('5');
  });

  it('treats the base unit as unity', () => {
    const q = parseQuantity('42.5');
    expect(toBase(q, each)).toBe(q);
    expect(fromBase(q, each)).toBe(q);
  });

  it('handles a unit smaller than the base', () => {
    // 2500 grams is 2.5 kilograms.
    expect(formatQuantity(toBase(parseQuantity('2500'), gram))).toBe('2.5');
    expect(formatQuantity(fromBase(parseQuantity('2.5'), gram))).toBe('2500');
  });

  it('round-trips exactly, which a decimal factor could not', () => {
    // The 03.3 gate. A box of three stored as 0.333333 loses a unit every few
    // thousand conversions; as a fraction it cancels.
    for (const quantity of ['1', '7', '123.456789', '0.000003', '999999']) {
      const original = parseQuantity(quantity);
      expect(formatQuantity(fromBase(toBase(original, boxOfThree), boxOfThree)), quantity).toBe(
        formatQuantity(original),
      );
    }
  });

  it('round-trips exactly across ten thousand conversions', () => {
    let quantity = parseQuantity('17');
    for (let i = 0; i < 10_000; i++) {
      quantity = fromBase(toBase(quantity, boxOfThree), boxOfThree);
    }
    expect(formatQuantity(quantity)).toBe('17');
  });

  it('converts between two non-base units in one step', () => {
    // 1 box of twelve = 4 boxes of three. Done in one expression so the
    // intermediate never rounds.
    expect(formatQuantity(convert(parseQuantity('1'), box, boxOfThree))).toBe('4');
    expect(formatQuantity(convert(parseQuantity('4'), boxOfThree, box))).toBe('1');
  });

  it('round-trips between two non-base units', () => {
    const original = parseQuantity('5');
    expect(formatQuantity(convert(convert(original, box, gram), gram, box))).toBe('5');
  });

  it('refuses a non-positive conversion', () => {
    expect(() => toBase(1n, { uomCode: 'BAD', numerator: 0n, denominator: 1n })).toThrow(
      UomConversionError,
    );
    expect(() => toBase(1n, { uomCode: 'BAD', numerator: 1n, denominator: 0n })).toThrow(
      UomConversionError,
    );
  });
});

describe('when rounding would be a real-world impossibility', () => {
  it('refuses a quantity that is not a whole number of base units', () => {
    // A third of an indivisible box is not a receipt anyone can put on a shelf.
    const third: UomConversion = { uomCode: 'THIRD', numerator: 1n, denominator: 3n };
    expect(() => toBaseExact(parseQuantity('1'), third)).toThrow(InexactConversionError);
  });

  it('accepts one that is', () => {
    expect(formatQuantity(toBaseExact(parseQuantity('5'), box))).toBe('60');
  });

  it('says what to do instead', () => {
    const third: UomConversion = { uomCode: 'THIRD', numerator: 1n, denominator: 3n };
    expect(() => toBaseExact(parseQuantity('1'), third)).toThrow(
      /Enter the quantity in a unit it divides into, or in the base unit/,
    );
  });
});

describe('§9.3 · every stock item is tracked', () => {
  const item = (overrides: Partial<ItemDefinition> = {}): ItemDefinition => ({
    code: 'ITEM-001',
    isStock: true,
    tracking: 'batch',
    costingMethod: 'fifo',
    active: true,
    ...overrides,
  });

  it('offers serial, batch or both — and nothing else', () => {
    expect(ITEM_TRACKING).toEqual(['serial', 'batch', 'serial_and_batch']);
  });

  it('accepts a tracked stock item', () => {
    for (const tracking of ITEM_TRACKING) {
      expect(() => assertItemDefinition(item({ tracking })), tracking).not.toThrow();
    }
  });

  it('refuses a stock item with no tracking', () => {
    expect(() => assertItemDefinition(item({ tracking: null }))).toThrow(ItemDefinitionError);
    expect(() => assertItemDefinition(item({ tracking: null }))).toThrow(
      /No-tracking is not allowed/,
    );
  });

  it('refuses tracking on a service', () => {
    expect(() => assertItemDefinition(item({ isStock: false, tracking: 'serial' }))).toThrow(
      /there is nothing to track/,
    );
  });

  it('accepts a service with no tracking', () => {
    expect(() => assertItemDefinition(item({ isStock: false, tracking: null }))).not.toThrow();
  });
});

describe('§9.2 · FIFO is the only valuation method', () => {
  it('recognises exactly one costing method', () => {
    expect(COSTING_METHODS).toEqual(['fifo']);
  });

  it('refuses anything else', () => {
    expect(() =>
      assertItemDefinition({
        code: 'ITEM-001',
        isStock: true,
        tracking: 'batch',
        costingMethod: 'weighted_average' as never,
        active: true,
      }),
    ).toThrow(/single valuation method/);
  });
});

describe('Appendix B · inactive-date enforcement', () => {
  const item = (overrides: Partial<ItemDefinition> = {}): ItemDefinition => ({
    code: 'ITEM-001',
    isStock: true,
    tracking: 'batch',
    costingMethod: 'fifo',
    active: true,
    ...overrides,
  });

  it('permits an active item', () => {
    expect(() => assertItemUsableOn(item(), '2026-08-16')).not.toThrow();
  });

  it('refuses a deactivated item', () => {
    expect(() => assertItemUsableOn(item({ active: false }), '2026-08-16')).toThrow(
      ItemInactiveError,
    );
  });

  it('judges the inactive date against the document, not against today', () => {
    // A document dated before the item was retired is still valid; one dated on
    // or after it is not.
    const retiring = item({ inactiveFrom: '2026-09-01' });
    expect(() => assertItemUsableOn(retiring, '2026-08-31')).not.toThrow();
    expect(() => assertItemUsableOn(retiring, '2026-09-01')).toThrow(ItemInactiveError);
    expect(() => assertItemUsableOn(retiring, '2026-12-01')).toThrow(ItemInactiveError);
  });
});
