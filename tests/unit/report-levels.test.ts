/**
 * Reporting levels — the roll-up every financial report unfolds along.
 *
 * By direction (2026-08-29): level 1 only the headers, level 2 headers and
 * sub-headers, level 3 down to the accounts. A header's figure is the sum of
 * what is beneath it, whichever level is shown.
 */
import { describe, expect, it } from 'vitest';
import { levelFrom, maxLevel, rollUp, type ChartRow } from '@domain/report-levels';

const chart: ChartRow[] = [
  { id: 'A', code: 'A', name: 'Assets', parentId: null, isGroup: true, accountType: 'asset' },
  { id: 'A1', code: 'A000001', name: 'Current assets', parentId: 'A', isGroup: true, accountType: 'asset' },
  { id: 'A11', code: 'A000011', name: 'Cash', parentId: 'A1', isGroup: false, accountType: 'asset' },
  { id: 'A12', code: 'A000012', name: 'Bank', parentId: 'A1', isGroup: false, accountType: 'asset' },
  { id: 'A2', code: 'A000002', name: 'Fixed assets', parentId: 'A', isGroup: true, accountType: 'asset' },
  { id: 'A21', code: 'A000021', name: 'Vehicles', parentId: 'A2', isGroup: false, accountType: 'asset' },
  { id: 'R', code: 'R', name: 'Revenue', parentId: null, isGroup: true, accountType: 'revenue' },
  { id: 'R1', code: 'R000001', name: 'Sales', parentId: 'R', isGroup: false, accountType: 'revenue' },
];

const figures = [
  { accountCode: 'A000011', debit: '100.0000', credit: '0.0000' },
  { accountCode: 'A000012', debit: '250.5000', credit: '50.0000' },
  { accountCode: 'R000001', debit: '0.0000', credit: '300.5000' },
];

describe('the deepest level a chart offers', () => {
  it('is the depth of the deepest posting account', () => {
    expect(maxLevel(chart)).toBe(3);
  });

  it('is at least one, even for an empty chart', () => {
    expect(maxLevel([])).toBe(1);
  });
});

describe('reading the level from the address', () => {
  it('falls to the deepest level when nothing usable was asked for', () => {
    expect(levelFrom(undefined, 3)).toBe(3);
    expect(levelFrom('all', 3)).toBe(3);
    expect(levelFrom('0', 3)).toBe(3);
  });

  it('clamps a level the chart cannot show', () => {
    expect(levelFrom('9', 3)).toBe(3);
    expect(levelFrom('2', 3)).toBe(2);
  });
});

describe('rolling figures up the chart', () => {
  it('shows only the type roots at level 1, carrying the sums beneath them', () => {
    const rows = rollUp(chart, figures, 1);
    expect(rows.map((r) => [r.code, r.depth, r.debit, r.credit])).toEqual([
      ['A', 1, '350.5000', '50.0000'],
      ['R', 1, '0.0000', '300.5000'],
    ]);
  });

  it('opens the headers at level 2 and the accounts at level 3', () => {
    expect(rollUp(chart, figures, 2).map((r) => r.code)).toEqual(['A', 'A000001', 'R', 'R000001']);
    expect(rollUp(chart, figures, 3).map((r) => r.code)).toEqual([
      'A',
      'A000001',
      'A000011',
      'A000012',
      'R',
      'R000001',
    ]);
  });

  it('leaves out a branch with no movement, as the Trial Balance does', () => {
    // Fixed assets and Vehicles have nothing posted, so neither appears.
    expect(rollUp(chart, figures, 3).map((r) => r.code)).not.toContain('A000002');
  });

  it('shows a posting account shallower than the level as itself', () => {
    // Sales sits at depth 2; at level 3 it is still the row, not folded away.
    const sales = rollUp(chart, figures, 3).find((r) => r.code === 'R000001');
    expect(sales).toMatchObject({ depth: 2, isGroup: false, credit: '300.5000' });
  });
});
