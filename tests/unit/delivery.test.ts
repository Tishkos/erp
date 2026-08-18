/**
 * Phase 06.5 — the delivery rules, tested where they are pure.
 *
 *   - §7.2 partial and multiple deliveries from one Sales Order
 *   - §7.7 delivery quantities reconcile to the source Sales Order
 *   - §7.2 Proof of Delivery captures recipient name, signature and photos
 *
 * The FIFO cost and the Dr COGS / Cr Inventory posting are proved against the
 * database, because they are facts about layers and journals rather than about
 * arithmetic on their own.
 */
import { describe, expect, it } from 'vitest';
import {
  assertProofOfDeliveryComplete,
  assertWithinOrdered,
  isLineDelivered,
  isProofOfDeliveryComplete,
  orderStatusAfterDelivery,
  outstandingDelivery,
  DeliveryExceedsPickError,
  IncompleteProofOfDeliveryError,
  OverDeliveryError,
} from '@domain/delivery';
import { parseQuantity } from '@domain/uom';

const q = (units: string) => parseQuantity(units);

describe('06.5 gate · deliveries accumulate and reconcile to the order (§7.7)', () => {
  it('allows a first partial delivery', () => {
    expect(() =>
      assertWithinOrdered(
        'ITM-1',
        { ordered: q('100'), alreadyDelivered: 0n, picked: q('60') },
        q('60'),
      ),
    ).not.toThrow();
  });

  it('allows the second delivery that completes the line', () => {
    expect(() =>
      assertWithinOrdered(
        'ITM-1',
        { ordered: q('100'), alreadyDelivered: q('60'), picked: q('40') },
        q('40'),
      ),
    ).not.toThrow();
  });

  it('refuses the delivery that would take the line past what was ordered', () => {
    // Neither 60 is an over-delivery alone; the second one is.
    expect(() =>
      assertWithinOrdered(
        'ITM-1',
        { ordered: q('100'), alreadyDelivered: q('60'), picked: q('60') },
        q('60'),
      ),
    ).toThrow(OverDeliveryError);
  });

  it('refuses to deliver more than the warehouse picked', () => {
    // The van holds what the picker put in it. Sending more would put serials on
    // the note that nobody scanned (§9.9).
    expect(() =>
      assertWithinOrdered(
        'ITM-1',
        { ordered: q('100'), alreadyDelivered: 0n, picked: q('60') },
        q('80'),
      ),
    ).toThrow(DeliveryExceedsPickError);
  });

  it('refuses a zero delivery rather than recording one', () => {
    expect(() =>
      assertWithinOrdered('ITM-1', { ordered: q('100'), alreadyDelivered: 0n, picked: q('60') }, 0n),
    ).toThrow(RangeError);
  });

  it('says what is still owed, not only that the delivery was too large (§25)', () => {
    try {
      assertWithinOrdered(
        'ITM-CABLE',
        { ordered: q('100'), alreadyDelivered: q('90'), picked: q('20') },
        q('20'),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('ITM-CABLE');
      expect((error as Error).message).toContain('still to deliver: 10');
    }
  });

  it('reports what is outstanding, never a negative', () => {
    expect(outstandingDelivery({ ordered: q('100'), delivered: q('60') })).toBe(q('40'));
    expect(outstandingDelivery({ ordered: q('100'), delivered: q('100') })).toBe(0n);
  });

  it('treats a line as delivered only when nothing is left', () => {
    expect(isLineDelivered({ ordered: q('100'), delivered: q('99.999999') })).toBe(false);
    expect(isLineDelivered({ ordered: q('100'), delivered: q('100') })).toBe(true);
  });
});

describe('06.5 · the order moves to Partially Delivered, then Delivered (Appendix B)', () => {
  it('says nothing while nothing has been delivered', () => {
    expect(
      orderStatusAfterDelivery([
        { ordered: q('100'), delivered: 0n },
        { ordered: q('50'), delivered: 0n },
      ]),
    ).toBeNull();
  });

  it('is partially delivered while any line still owes', () => {
    expect(
      orderStatusAfterDelivery([
        { ordered: q('100'), delivered: q('100') },
        { ordered: q('50'), delivered: q('10') },
      ]),
    ).toBe('partially_executed');
  });

  it('is delivered only when every line is', () => {
    expect(
      orderStatusAfterDelivery([
        { ordered: q('100'), delivered: q('100') },
        { ordered: q('50'), delivered: q('50') },
      ]),
    ).toBe('executed');
  });

  it('is partially delivered when one line has started and another has not', () => {
    expect(
      orderStatusAfterDelivery([
        { ordered: q('100'), delivered: q('60') },
        { ordered: q('50'), delivered: 0n },
      ]),
    ).toBe('partially_executed');
  });
});

describe('06.5 gate · Proof of Delivery captures what §7.2 asks for', () => {
  const complete = {
    recipientName: 'Ahmed Kareem',
    signatureAttachmentId: '00000000-0000-0000-0000-000000000001',
    photoCount: 2,
  };

  it('accepts a complete proof', () => {
    expect(() => assertProofOfDeliveryComplete(complete)).not.toThrow();
    expect(isProofOfDeliveryComplete(complete)).toBe(true);
  });

  it('refuses a proof with no recipient named', () => {
    expect(() => assertProofOfDeliveryComplete({ ...complete, recipientName: '   ' })).toThrow(
      IncompleteProofOfDeliveryError,
    );
  });

  it('refuses a proof with no signature', () => {
    expect(() =>
      assertProofOfDeliveryComplete({ ...complete, signatureAttachmentId: null }),
    ).toThrow(IncompleteProofOfDeliveryError);
  });

  it('refuses a proof with no photograph', () => {
    expect(() => assertProofOfDeliveryComplete({ ...complete, photoCount: 0 })).toThrow(
      IncompleteProofOfDeliveryError,
    );
  });

  it('names everything that is missing at once, not one thing at a time (§25)', () => {
    // A driver at a customer's door should be told the whole list, not sent back
    // three times.
    try {
      assertProofOfDeliveryComplete({
        recipientName: null,
        signatureAttachmentId: null,
        photoCount: 0,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('the recipient’s name');
      expect(message).toContain('a signature');
      expect(message).toContain('at least one delivery photo');
    }
  });

  it('reports incompleteness without throwing, for a screen', () => {
    expect(isProofOfDeliveryComplete({ ...complete, photoCount: 0 })).toBe(false);
  });
});
