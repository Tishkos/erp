import { describe, expect, it } from 'vitest';
import { overflowOf } from '@/components/admin/tabs-overflow';

/**
 * The section tabs never scroll sideways (2026-10-06, by direction: "try to
 * avoid the header tab … scrollable"): what does not fit goes behind More,
 * and the current tab is always on the row.
 */
describe('section tabs · what goes behind More', () => {
  const tens = [100, 100, 100, 100, 100];

  it('keeps every tab when the row fits, More or not', () => {
    expect(overflowOf(tens, 0, 500, 80, 0)).toEqual([]);
    expect(overflowOf(tens, 4, 516, 80, 4)).toEqual([]);
  });

  it('moves the tail behind More, leaving room for the button', () => {
    // 450 of room: More (80) leaves 370 → three tabs.
    expect(overflowOf(tens, 0, 450, 80, 0)).toEqual([3, 4]);
    // The gap counts between tabs and before More: 400 − 80 − 10 leaves 310,
    // and three tabs with their two gaps are 320.
    expect(overflowOf(tens, 10, 400, 80, 1)).toEqual([2, 3, 4]);
  });

  it('keeps the current tab on the row, in its place, giving up the run from its end', () => {
    expect(overflowOf(tens, 0, 450, 80, 4)).toEqual([2, 3]);
    expect(overflowOf(tens, 0, 450, 80, 3)).toEqual([2, 4]);
  });

  it('keeps the current tab even when it alone is all there is room for', () => {
    expect(overflowOf([100, 300, 100], 0, 200, 80, 1)).toEqual([0, 2]);
    expect(overflowOf([100, 300, 100], 0, 120, 80, 0)).toEqual([1, 2]);
  });

  it('forgives a fraction of a pixel, as measured widths have', () => {
    expect(overflowOf([100.2, 99.9, 100.3], 0, 300, 80, 0)).toEqual([]);
  });
});
