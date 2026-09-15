/**
 * Why a document cannot be raised, said precisely.
 *
 * The Sales Invoice form told somebody "Add a customer first" while their
 * Customers screen was showing a customer. Both statements were true and
 * neither was useful: the customer existed and had been deactivated, so the
 * picker was empty and the message described a different problem.
 *
 * Following that instruction makes a second customer nobody wanted, and leaves
 * the first one still deactivated. §25 asks for the reason and the corrective
 * action, and "add one" is the corrective action for an empty table only.
 */
import { describe, expect, it } from 'vitest';
import { gapFor, gapsFor } from '@/server/domain/setup-gaps';

describe('setup gaps', () => {
  it('says nothing when something can be used', () => {
    expect(gapFor('customers', 3, 2)).toBeNull();
    expect(gapFor('customers', 1, 1)).toBeNull();
  });

  it('asks for one to be added when the table is empty', () => {
    expect(gapFor('customers', 0, 0)).toEqual({ key: 'no_customers' });
  });

  it('says they exist and are inactive when that is what is wrong', () => {
    // The case the sponsor hit: one customer, deactivated.
    expect(gapFor('customers', 1, 0)).toEqual({ key: 'no_active_customers', count: 1 });
    expect(gapFor('suppliers', 4, 0)).toEqual({ key: 'no_active_suppliers', count: 4 });
  });

  it('carries the count only when there is something to count', () => {
    // "0 customers exist and none is active" would be a sentence about nothing.
    expect(gapFor('customers', 0, 0)).not.toHaveProperty('count');
    expect(gapFor('customers', 2, 0)).toHaveProperty('count', 2);
  });

  it('reports every gap on a form, in field order', () => {
    expect(
      gapsFor([
        { kind: 'customers', total: 1, usable: 0 },
        { kind: 'items', total: 0, usable: 0 },
        { kind: 'warehouses', total: 2, usable: 2 },
      ]),
    ).toEqual([{ key: 'no_active_customers', count: 1 }, { key: 'no_items' }]);
  });

  it('reports nothing when the form can be filled in', () => {
    expect(
      gapsFor([
        { kind: 'customers', total: 1, usable: 1 },
        { kind: 'items', total: 3, usable: 3 },
      ]),
    ).toEqual([]);
  });
});
