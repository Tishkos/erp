import { describe, expect, it } from 'vitest';
import { matching, pickOne, pickOutcome } from '@domain/pick';

/**
 * Typing the name of one invoice.
 *
 * The rule that matters is the one about ambiguity: a return is raised against a
 * single invoice, so a phrase that could mean two of them must pick neither.
 */
interface Row {
  readonly invoiceNo: string;
  readonly partnerCode: string;
  readonly partnerName: string;
}

const ROWS: readonly Row[] = [
  { invoiceNo: 'API-HQ-2026-000001', partnerCode: 'SUP-000001', partnerName: 'Issa Trading' },
  { invoiceNo: 'API-HQ-2026-000002', partnerCode: 'SUP-000001', partnerName: 'Issa Trading' },
  { invoiceNo: 'API-HQ-2026-000010', partnerCode: 'SUP-000002', partnerName: 'Aiko Solar' },
];

const key = (row: Row) => row.invoiceNo;
const fields = (row: Row) => [row.invoiceNo, row.partnerCode, row.partnerName];

describe('finding one record from what was typed', () => {
  it('takes a whole invoice number, whatever its case or padding', () => {
    expect(pickOne(ROWS, '  api-hq-2026-000002 ', key, fields)?.invoiceNo).toBe('API-HQ-2026-000002');
  });

  it('takes a partial number that can only be one invoice', () => {
    expect(pickOne(ROWS, '000010', key, fields)?.invoiceNo).toBe('API-HQ-2026-000010');
  });

  it('refuses a partial number that could be two', () => {
    // "00000" is in 000001 and 000002 — and guessing would raise a return
    // against the wrong invoice.
    expect(pickOne(ROWS, '00000', key, fields)).toBeNull();
    expect(pickOutcome(ROWS, '00000', key, fields)).toBe('ambiguous');
  });

  it('prefers an exact number over a longer one that contains it', () => {
    const rows = [
      { invoiceNo: 'INV-1', partnerCode: 'C1', partnerName: 'One' },
      { invoiceNo: 'INV-10', partnerCode: 'C2', partnerName: 'Two' },
    ];
    expect(pickOne(rows, 'INV-1', (r) => r.invoiceNo)?.invoiceNo).toBe('INV-1');
  });

  it('finds an invoice by its partner when only one is theirs', () => {
    expect(pickOne(ROWS, 'aiko', key, fields)?.invoiceNo).toBe('API-HQ-2026-000010');
  });

  it('reads several words as all having to be true', () => {
    expect(matching(ROWS, 'issa 000002', fields)).toHaveLength(1);
    expect(matching(ROWS, 'issa aiko', fields)).toHaveLength(0);
  });

  it('narrows to a partner without picking one of their invoices', () => {
    expect(matching(ROWS, 'Issa Trading', fields)).toHaveLength(2);
    expect(pickOne(ROWS, 'Issa Trading', key, fields)).toBeNull();
  });

  it('says nothing was typed, so the screen can stay quiet', () => {
    expect(pickOutcome(ROWS, '   ', key, fields)).toBe('empty');
    expect(matching(ROWS, '', fields)).toHaveLength(3);
  });

  it('says a phrase matches nothing at all', () => {
    expect(pickOutcome(ROWS, 'zzz', key, fields)).toBe('none');
  });
});
