import { describe, expect, it } from 'vitest';
import { isToken } from '@/components/admin/table-labels';

/**
 * Tables wrap their text so they fit the screen (2026-10-06); what is a value
 * rather than prose — a code, a document number, an amount, a date — keeps to
 * one line (`data-nowrap`).
 */
describe('table cells · what never breaks across lines', () => {
  it('keeps codes, document numbers, amounts and dates whole', () => {
    for (const value of ['INV-HQ-2026-000001', 'SUP-00001', '1,000,000 IQD', 'Oct 06, 2026', '06 أكتوبر 2026', '2026-10-06', 'WH-HQ', 'Posted']) {
      expect(isToken(value), value).toBe(true);
    }
  });

  it('lets prose wrap', () => {
    for (const value of ['Head Office Main Warehouse', 'E2E Supplier THVSZ Limited', 'Due in 0 days', 'Oct 6, 2026, 3:14 PM', '']) {
      expect(isToken(value), value).toBe(false);
    }
  });

  it('lets nothing longer than a code stay on one line', () => {
    expect(isToken('A-VERY-LONG-REFERENCE-WITHOUT-ANY-SPACE-AT-ALL')).toBe(false);
  });
});
