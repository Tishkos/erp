import { describe, expect, it, vi } from 'vitest';

// The detector reads one figure; the question is only what it does with it. No database.
const figure = vi.hoisted(() => ({
  value: { layersIqd: '0', glIqd: '0', provisionalIqd: '0', differenceIqd: '0' },
}));
vi.mock('@/server/services/inventory-valuation', () => ({ stockAgainstGl: async () => figure.value }));
vi.mock('../../src/server/services/inventory-valuation', () => ({ stockAgainstGl: async () => figure.value }));

import { glDifference } from '../../src/server/services/exception-detectors/inventory';

const ctx = { tx: {}, today: '2026-10-05' } as never;

describe('inventory.gl_difference compares exactly, like the period close and Inventory Checks', () => {
  it('layers equal the accounts: nothing, whatever part of the stock is still "not yet posted"', async () => {
    // A container receipt's layers out of goods the invoice already booked: provisional, and already in the accounts.
    figure.value = { layersIqd: '1000.0000', glIqd: '1000.0000', provisionalIqd: '400.0000', differenceIqd: '0.0000' };
    expect(await glDifference(ctx)).toEqual([]);
  });

  it('a difference is a finding by its whole amount, even when it happens to equal the provisional part', async () => {
    figure.value = { layersIqd: '1000.0000', glIqd: '600.0000', provisionalIqd: '400.0000', differenceIqd: '400.0000' };
    const found = await glDifference(ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.detector).toBe('inventory.gl_difference');
    expect(found[0]!.facts).toMatchObject({ layersIqd: '1000.0000', glIqd: '600.0000', provisionalIqd: '400.0000', unexplainedIqd: '400.0000' });
  });

  it('the provisional part stays beside the figures as evidence', async () => {
    figure.value = { layersIqd: '90.0000', glIqd: '100.0000', provisionalIqd: '5.0000', differenceIqd: '-10.0000' };
    const [finding] = await glDifference(ctx);
    expect(finding!.evidence.map((e) => e.amount)).toContain('5.0000');
  });
});
