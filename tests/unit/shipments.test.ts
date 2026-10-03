/**
 * REQ-AP-001 §17–§18 — the shipment rules, decidable without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  assertContainerNumber,
  assertReceiptLines,
  assertStatusMove,
  checkDigitOk,
  expectedCheckDigit,
  planContainers,
  isContainerNo,
  parseContainerList,
  progress,
  receiptOutcome,
  spreadEqually,
} from '@domain/shipments';

const U = 1_000_000n;

describe('§17.2 · container numbers', () => {
  it('knows the ISO 6346 shape and its check digit', () => {
    expect(isContainerNo('CSQU3054383')).toBe(true);
    expect(checkDigitOk('CSQU3054383')).toBe(true);
    expect(checkDigitOk('CSQU3054384')).toBe(false);
    expect(isContainerNo('CSQ3054383')).toBe(false);
    expect(isContainerNo('CSQX3054383')).toBe(false);
  });

  it('reads a paste: lines, commas, spaces and dashes inside a number; names the rest', () => {
    expect(parseContainerList('MSCU1234565\nTGHU7654321, CAIU2345678\nFSCU 345678-9\n\nMSCU1234565\nNOPE')).toEqual({
      numbers: ['MSCU1234565', 'TGHU7654321', 'CAIU2345678', 'FSCU3456789'],
      invalid: ['NOPE'],
      repeated: ['MSCU1234565'],
    });
    expect(parseContainerList('MSCU1234565 TGHU7654321').numbers).toEqual(['MSCU1234565', 'TGHU7654321']);
  });
});

describe('§17.3 · the stages a person sets', () => {
  it('goes forward, may skip, and leaves Received to the receipt and Late to the sweep', () => {
    expect(() => assertStatusMove('C', 'not_loaded', 'on_sea')).not.toThrow();
    expect(() => assertStatusMove('C', 'on_sea', 'customs_cleared')).not.toThrow();
    expect(() => assertStatusMove('C', 'late', 'at_port')).not.toThrow();
    expect(() => assertStatusMove('C', 'at_port', 'on_sea')).toThrow(/already past/);
    expect(() => assertStatusMove('C', 'at_port', 'received')).toThrow(/container receipt/);
    expect(() => assertStatusMove('C', 'on_sea', 'late')).toThrow(/daily check/);
    expect(() => assertStatusMove('C', 'received', 'at_port')).toThrow(/received/);
  });
});

describe('§17.5 · X of Y; §24.3 · the spread', () => {
  it('counts what counts as received, among the live containers', () => {
    expect(
      progress([
        { countsAsReceived: true },
        { countsAsReceived: false },
        { countsAsReceived: true, cancelled: true },
      ]),
    ).toEqual({ received: 1, total: 2, partly: true, all: false });
    expect(progress([]).all).toBe(false);
  });

  it('spreads in whole units, the last taking the remainder', () => {
    expect(spreadEqually(1000n * U, 4)).toEqual([250n * U, 250n * U, 250n * U, 250n * U]);
    expect(spreadEqually(10n * U, 3)).toEqual([3n * U, 3n * U, 4n * U]);
    expect(spreadEqually(5n * U + 500_000n, 2)).toEqual([2n * U, 3n * U + 500_000n]);
  });
});

describe('§18 · the receipt', () => {
  it('whole is Received; anything else is Missing / damaged and needs its reason', () => {
    const whole = [{ planned: 10n, received: 10n, damaged: 0n, short: 0n }];
    const short = [{ planned: 10n, received: 9n, damaged: 0n, short: 1n }];
    const damaged = [{ planned: 10n, received: 10n, damaged: 1n, short: 0n }];
    expect(receiptOutcome(whole)).toBe('received');
    expect(receiptOutcome(short)).toBe('missing_damaged');
    expect(receiptOutcome(damaged)).toBe('missing_damaged');
    expect(() => assertReceiptLines(short, '')).toThrow(/Say what happened/);
    expect(() => assertReceiptLines(short, 'Seal broken')).not.toThrow();
    expect(() => assertReceiptLines([], null)).toThrow(/no lines/);
    expect(() => assertReceiptLines([{ planned: 1n, received: -1n, damaged: 0n, short: 0n }], 'x')).toThrow(/never below zero/);
  });
});

describe('IM2 · a container number typed on a screen', () => {
  it('is refused when its check digit is wrong, naming the right one', () => {
    expect(assertContainerNumber('mscu 123456-6')).toBe('MSCU1234566');
    expect(expectedCheckDigit('MSCU1234565')).toBe(6);
    expect(() => assertContainerNumber('MSCU1234565')).toThrow(/should be 6/);
    expect(() => assertContainerNumber('MSC1234566')).toThrow(/not a container number/);
  });
});

describe('IM2 · what each container of a B/L carries', () => {
  const models = [
    { key: 'a', label: 'PANEL', available: 100n * U },
    { key: 'b', label: 'INVERTER', available: 10n * U },
  ];
  it('divides a model left empty in every row equally, the last taking the rest', () => {
    const { plan, estimated } = planContainers(models, [{ quantities: {} }, { quantities: {} }, { quantities: {} }]);
    expect(plan.map((row) => row[0])).toEqual([33n * U, 33n * U, 34n * U]);
    expect(plan.map((row) => row[1])).toEqual([3n * U, 3n * U, 4n * U]);
    expect(estimated).toBe(true);
  });
  it('takes typed quantities as typed, an empty cell beside them meaning none', () => {
    const { plan, estimated } = planContainers(models, [
      { quantities: { a: 60n * U, b: null } },
      { quantities: { a: 40n * U, b: 10n * U } },
    ]);
    expect(plan).toEqual([
      [60n * U, 0n],
      [40n * U, 10n * U],
    ]);
    expect(estimated).toBe(false);
  });
  it('never plans more than is left of what was ordered', () => {
    expect(() => planContainers(models, [{ quantities: { a: 60n * U } }, { quantities: { a: 41n * U } }])).toThrow(/PANEL: 101 in these containers, but only 100/);
    expect(() => planContainers(models, [{ quantities: { a: -1n } }])).toThrow(/never less than none/);
  });
});
