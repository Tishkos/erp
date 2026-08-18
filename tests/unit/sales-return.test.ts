/**
 * Phase 06.9 — the sales-return rules, tested where they are pure.
 *
 *   - §7.5 return quantity cannot exceed invoiced less previous accepted returns
 *   - §7.5 inspection routes to saleable, quarantine or damaged
 *   - the credit memo values the return at the *original* FIFO cost
 *
 * *"No exchange mechanism exists anywhere in the return flow"* cannot be tested
 * here, because the way it is enforced is that there is nothing to call. It is
 * asserted against the schema instead.
 */
import { describe, expect, it } from 'vitest';
import {
  assertDestinationMatches,
  assertWithinInvoiced,
  creditAmountFor,
  isSaleableAgain,
  originalUnitCost,
  returnCostFor,
  returnableQuantity,
  OverReturnError,
  ReturnCostError,
  WrongDestinationError,
  RETURN_DISPOSITIONS,
} from '@domain/sales-return';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const q = (units: string) => parseQuantity(units);
const iqd = (amount: string) => parseDecimal(amount, 4n);

describe('06.9 gate · a return cannot exceed what was invoiced (§7.5)', () => {
  it('allows returning what the customer bought', () => {
    expect(() =>
      assertWithinInvoiced('ITM-1', { invoiced: q('60'), alreadyReturned: 0n }, q('60')),
    ).not.toThrow();
  });

  it('refuses one unit more', () => {
    expect(() =>
      assertWithinInvoiced('ITM-1', { invoiced: q('60'), alreadyReturned: 0n }, q('60.000001')),
    ).toThrow(OverReturnError);
  });

  it('counts previous accepted returns', () => {
    expect(() =>
      assertWithinInvoiced('ITM-1', { invoiced: q('60'), alreadyReturned: q('40') }, q('20')),
    ).not.toThrow();

    expect(() =>
      assertWithinInvoiced('ITM-1', { invoiced: q('60'), alreadyReturned: q('40') }, q('30')),
    ).toThrow(OverReturnError);
  });

  it('refuses a zero return rather than recording one', () => {
    expect(() =>
      assertWithinInvoiced('ITM-1', { invoiced: q('60'), alreadyReturned: 0n }, 0n),
    ).toThrow(RangeError);
  });

  it('reports what is still returnable, never a negative', () => {
    expect(returnableQuantity({ invoiced: q('60'), returned: q('40') })).toBe(q('20'));
    expect(returnableQuantity({ invoiced: q('60'), returned: q('60') })).toBe(0n);
  });

  it('says what is left and why (§25)', () => {
    try {
      assertWithinInvoiced('ITM-CABLE', { invoiced: q('60'), alreadyReturned: q('50') }, q('20'));
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('still returnable: 10');
      expect((error as Error).message).toContain('never billed for are not a return');
    }
  });
});

describe('06.9 gate · inspection routes to one of three places (§7.5)', () => {
  it('has three dispositions and no fourth', () => {
    expect([...RETURN_DISPOSITIONS]).toEqual(['saleable', 'quarantine', 'damaged']);
  });

  it('lets saleable goods go back to a selling warehouse', () => {
    expect(() => assertDestinationMatches('saleable', 'WH-BGW', 'main')).not.toThrow();
    expect(() => assertDestinationMatches('saleable', 'WH-BR2', 'branch')).not.toThrow();
  });

  it('refuses saleable goods into a damaged-goods store', () => {
    expect(() => assertDestinationMatches('saleable', 'WH-DMG', 'damaged_goods')).toThrow(
      WrongDestinationError,
    );
  });

  it('insists damaged goods land in a damaged-goods store', () => {
    // §7.5's "damaged returned goods cannot be sold" is enforced by *where* the
    // stock sits, so this check is what that control rests on.
    expect(() => assertDestinationMatches('damaged', 'WH-DMG', 'damaged_goods')).not.toThrow();
    expect(() => assertDestinationMatches('damaged', 'WH-BGW', 'main')).toThrow(
      WrongDestinationError,
    );
    expect(() => assertDestinationMatches('damaged', 'WH-QTN', 'quarantine')).toThrow(
      WrongDestinationError,
    );
  });

  it('insists quarantined goods land in quarantine', () => {
    expect(() => assertDestinationMatches('quarantine', 'WH-QTN', 'quarantine')).not.toThrow();
    expect(() => assertDestinationMatches('quarantine', 'WH-BGW', 'main')).toThrow(
      WrongDestinationError,
    );
  });

  it('says only saleable goods may be sold again', () => {
    expect(isSaleableAgain('saleable')).toBe(true);
    expect(isSaleableAgain('quarantine')).toBe(false);
    expect(isSaleableAgain('damaged')).toBe(false);
  });
});

describe('06.9 gate · a return is valued at the original cost, not today’s', () => {
  it('derives the unit cost from what the delivery recorded', () => {
    // 60 units delivered at a COGS of 360 — 6 each.
    expect(
      originalUnitCost({
        itemCode: 'ITM-1',
        deliveredQuantity: q('60'),
        deliveredCogsIqd: iqd('360'),
      }),
    ).toBe(iqd('6'));
  });

  it('handles a delivery that spanned two FIFO layers', () => {
    // 150 delivered costing 1,100 — an average of 7.3333 per unit, which is what
    // those particular units actually cost.
    const unit = originalUnitCost({
      itemCode: 'ITM-1',
      deliveredQuantity: q('150'),
      deliveredCogsIqd: iqd('1100'),
    });

    expect(unit).toBe(iqd('7.3333'));
  });

  it('refuses to value a return against a delivery of nothing', () => {
    expect(() =>
      originalUnitCost({ itemCode: 'ITM-1', deliveredQuantity: 0n, deliveredCogsIqd: iqd('100') }),
    ).toThrow(ReturnCostError);
  });

  it('costs a partial return at that unit cost', () => {
    expect(returnCostFor({ unitCostIqd: iqd('6'), quantity: q('10') })).toBe(iqd('60'));
  });

  it('never lets two partial returns cost more than the whole line', () => {
    const unit = originalUnitCost({
      itemCode: 'ITM-1',
      deliveredQuantity: q('3'),
      deliveredCogsIqd: iqd('10'),
    });

    const first = returnCostFor({ unitCostIqd: unit, quantity: q('1') });
    const second = returnCostFor({ unitCostIqd: unit, quantity: q('2') });

    // 10 / 3 truncates, so the parts come to slightly less than the whole. That
    // is the safe direction: the remainder stays in cost of sales rather than
    // inflating inventory.
    expect(first + second).toBeLessThanOrEqual(iqd('10'));
  });
});

describe('06.9 · the credit is at the price the customer paid (§7.5)', () => {
  it('credits the whole line when the whole line comes back', () => {
    expect(
      creditAmountFor({
        invoicedQuantity: q('60'),
        invoicedNetIqd: iqd('1200'),
        returningQuantity: q('60'),
      }),
    ).toBe(iqd('1200'));
  });

  it('pro-rates a partial return, discount and all', () => {
    // 60 at 20 = 1,200 gross, discounted to 1,080. Returning 20 credits 360 —
    // the customer gets back what they actually paid for those units.
    expect(
      creditAmountFor({
        invoicedQuantity: q('60'),
        invoicedNetIqd: iqd('1080'),
        returningQuantity: q('20'),
      }),
    ).toBe(iqd('360'));
  });

  it('credits nothing against an invoice line of nothing', () => {
    expect(
      creditAmountFor({
        invoicedQuantity: 0n,
        invoicedNetIqd: iqd('1200'),
        returningQuantity: q('20'),
      }),
    ).toBe(0n);
  });
});
