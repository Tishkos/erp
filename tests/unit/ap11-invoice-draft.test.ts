/**
 * REQ-AP-001 — a supplier's invoice read into a draft.
 *
 * The feature is only worth having if it is honest. A model that fills every
 * field produces a draft somebody signs; a model that leaves what it could
 * not read empty and says so produces a draft somebody checks. These hold the
 * second behaviour: nothing invented, every gap flagged, and an item matched
 * only when it plainly is that item.
 */
import { describe, expect, it } from 'vitest';
import {
  allFlags,
  cleanDate,
  cleanNumber,
  EXTRACTION_RULES,
  matchItem,
  matchLines,
  readDraft,
} from '@/server/domain/invoice-draft';

const CATALOGUE = [
  { code: 'SOL-550', name: 'Solar Panel 550W' },
  { code: 'SOL-450', name: 'Solar Panel 450W' },
  { code: 'INV-5K', name: 'Inverter 5kW' },
];

describe('AP-11 · the numbers and dates an invoice writes', () => {
  it('reads a figure however the invoice punctuates it', () => {
    expect(cleanNumber('1,250.50')).toBe('1250.50');
    expect(cleanNumber(' $ 88.50 ')).toBe('88.50');
    expect(cleanNumber('100')).toBe('100');
    expect(cleanNumber(-5)).toBe('-5');
  });

  it('refuses a figure it cannot read, rather than inventing one', () => {
    expect(cleanNumber('about 100')).toBeNull();
    expect(cleanNumber('')).toBeNull();
    expect(cleanNumber(null)).toBeNull();
    expect(cleanNumber('N/A')).toBeNull();
  });

  it('takes only an unambiguous date', () => {
    expect(cleanDate('2026-04-03')).toBe('2026-04-03');
    // 03/04/2026 is March or April depending on who typed it. Neither is
    // worth guessing on a document that sets a payment due date.
    expect(cleanDate('03/04/2026')).toBeNull();
    expect(cleanDate('')).toBeNull();
  });
});

describe('AP-11 · what the reader is told', () => {
  it('forbids inventing, and asks for the description untouched', () => {
    expect(EXTRACTION_RULES).toMatch(/Never invent/);
    expect(EXTRACTION_RULES).toMatch(/a guessed figure is worse than a blank/i);
    expect(EXTRACTION_RULES).toMatch(/Do not translate it/);
  });

  it('keeps freight out of the goods, where the landed cost takes it', () => {
    expect(EXTRACTION_RULES).toMatch(/Freight, insurance and bank charges are not goods/);
  });
});

describe('AP-11 · reading the answer', () => {
  const answer = {
    supplierName: 'Jinko Solar Co., Ltd',
    invoiceNo: 'JK-2026-881',
    invoiceDate: '2026-09-18',
    currency: 'usd',
    totalAmount: '8,850.00',
    lines: [
      { description: 'Solar Panel 550W', quantity: '100', uom: 'PCS', unitPrice: '88.50', lineTotal: '8850.00', confidence: 'sure' },
    ],
    note: null,
  };

  it('reads a whole invoice and raises nothing', () => {
    const draft = readDraft(answer);
    expect(draft.supplierName).toBe('Jinko Solar Co., Ltd');
    expect(draft.currency).toBe('USD');
    expect(draft.totalAmount).toBe('8850.00');
    expect(draft.lines[0]).toMatchObject({ quantity: '100', unitPrice: '88.50', confidence: 'sure' });
    expect(draft.flags).toHaveLength(0);
  });

  it('flags every gap instead of filling it', () => {
    const draft = readDraft({ ...answer, supplierName: null, currency: null, lines: [{ description: 'Panels' }] });
    const fields = allFlags(draft).map((flag) => flag.field);
    expect(fields).toContain('supplierName');
    expect(fields).toContain('currency');
    expect(fields).toContain('lines[0].quantity');
    expect(fields).toContain('lines[0].unitPrice');
    expect(draft.lines[0]!.quantity).toBeNull();
  });

  it('overrides a reader that claimed to be sure about a line it left empty', () => {
    // The colour on the screen follows what is actually there, not what the
    // model said about itself.
    const draft = readDraft({ ...answer, lines: [{ description: 'Panels', confidence: 'sure' }] });
    expect(draft.lines[0]!.confidence).toBe('missing');
  });

  it('says so when the date could not be read', () => {
    const draft = readDraft({ ...answer, invoiceDate: '18/09/2026' });
    expect(draft.invoiceDate).toBeNull();
    expect(draft.flags.map((flag) => flag.field)).toContain('invoiceDate');
  });

  it('survives an answer that is not an invoice at all', () => {
    expect(readDraft(null).note).toMatch(/did not answer/);
    expect(readDraft('a sentence').lines).toHaveLength(0);
  });
});

describe('AP-11 · matching an item, timidly', () => {
  it('takes an exact name', () => {
    expect(matchItem('Solar Panel 550W', CATALOGUE)).toMatchObject({ code: 'SOL-550', confidence: 'sure' });
  });

  it('takes a description that contains the item, but says it is unsure', () => {
    expect(matchItem('Solar Panel 550W Mono PERC black frame', CATALOGUE)).toMatchObject({
      code: 'SOL-550',
      confidence: 'unsure',
    });
  });

  it('refuses when several items could be meant', () => {
    // "Solar Panel" contains neither whole name and is contained by both —
    // picking one would be a wrong cost nobody could see was guessed.
    expect(matchItem('Solar Panel', CATALOGUE)).toBeNull();
  });

  it('refuses when nothing matches', () => {
    expect(matchItem('Motorcycle helmet', CATALOGUE)).toBeNull();
    expect(matchItem('', CATALOGUE)).toBeNull();
  });

  it('flags every line it could not match, and every one it matched loosely', () => {
    const draft = matchLines(
      readDraft({
        supplierName: 'X',
        currency: 'USD',
        lines: [
          { description: 'Solar Panel 550W', quantity: '1', unitPrice: '1', confidence: 'sure' },
          { description: 'Solar Panel 550W Mono', quantity: '1', unitPrice: '1', confidence: 'sure' },
          { description: 'Mystery widget', quantity: '1', unitPrice: '1', confidence: 'sure' },
        ],
      }),
      CATALOGUE,
    );
    expect(draft.lines[0]!.itemCode).toBe('SOL-550');
    expect(draft.lines[0]!.flags).toHaveLength(0);
    expect(draft.lines[1]!.itemCode).toBe('SOL-550');
    expect(draft.lines[1]!.flags[0]!.why).toMatch(/check it is the right item/);
    expect(draft.lines[2]!.itemCode).toBeNull();
    expect(draft.lines[2]!.flags[0]!.why).toMatch(/no item in the catalogue plainly matches/);
  });
});
