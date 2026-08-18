/**
 * Phase 06.4 — the picking rules, tested where they are pure.
 *
 * Two of the three 06.4 gates live here, because both are arithmetic and
 * identity rather than storage:
 *
 *   - *"Picked quantity cannot exceed the reserved quantity"*
 *   - *"Serial/batch selection at pick is carried through to the Delivery Note"*
 *     — which is only meaningful if the selection was complete when captured.
 *
 * The third gate — *"Pick List creates no accounting entry and no stock
 * movement"* — is a property of the schema and is tested against the database.
 */
import { describe, expect, it } from 'vitest';
import {
  assertIdentitiesComplete,
  assertWithinReservation,
  pickShortfall,
  DuplicateSerialPickError,
  PickExceedsReservationError,
  PickIdentityMismatchError,
  SerialQuantityError,
  UnidentifiedPickError,
} from '@domain/picking';
import { parseQuantity } from '@domain/uom';

const q = (units: string) => parseQuantity(units);

describe('06.4 gate · picked quantity cannot exceed the reserved quantity', () => {
  it('allows a pick up to the reservation', () => {
    expect(() =>
      assertWithinReservation('ITM-1', { reserved: q('10'), alreadyPicked: 0n }, q('10')),
    ).not.toThrow();
  });

  it('refuses one unit beyond it', () => {
    expect(() =>
      assertWithinReservation('ITM-1', { reserved: q('10'), alreadyPicked: 0n }, q('10.000001')),
    ).toThrow(PickExceedsReservationError);
  });

  it('judges the excess cumulatively across pick lists', () => {
    // Neither 40 is an over-pick on its own; the second one is, against 60.
    const position = { reserved: q('60'), alreadyPicked: q('40') };

    expect(() => assertWithinReservation('ITM-1', position, q('20'))).not.toThrow();
    expect(() => assertWithinReservation('ITM-1', position, q('40'))).toThrow(
      PickExceedsReservationError,
    );
  });

  it('treats picking less than reserved as ordinary', () => {
    // The picker found six of the ten. That is a shortfall for the warehouse to
    // chase, not an error to refuse — the stock is simply not on the shelf.
    expect(() =>
      assertWithinReservation('ITM-1', { reserved: q('10'), alreadyPicked: 0n }, q('6')),
    ).not.toThrow();

    expect(pickShortfall({ requested: q('10'), picked: q('6') })).toBe(q('4'));
  });

  it('reports no negative shortfall', () => {
    expect(pickShortfall({ requested: q('10'), picked: q('10') })).toBe(0n);
  });

  it('refuses a zero pick rather than recording one', () => {
    // "Picked nothing" is a line that is not on the sheet. A zero row would
    // count as a pick against the reservation in every later sum.
    expect(() =>
      assertWithinReservation('ITM-1', { reserved: q('10'), alreadyPicked: 0n }, 0n),
    ).toThrow(RangeError);
  });

  it('says what is left to pick, not only that the pick was too large (§25)', () => {
    try {
      assertWithinReservation('ITM-CABLE', { reserved: q('60'), alreadyPicked: q('40') }, q('40'));
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('ITM-CABLE');
      expect((error as Error).message).toContain('available to pick: 20');
    }
  });
});

describe('06.4 gate · serial and batch selection is complete at the pick', () => {
  it('accepts one serial per unit', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-SER',
        tracking: 'serial',
        pickedQuantity: q('2'),
        units: [
          { serialNumber: 'SN-1', quantity: q('1') },
          { serialNumber: 'SN-2', quantity: q('1') },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts a quantity out of a batch', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BAT',
        tracking: 'batch',
        pickedQuantity: q('15'),
        units: [
          { batchNumber: 'B-1', quantity: q('10') },
          { batchNumber: 'B-2', quantity: q('5') },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a tracked pick with nothing selected', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-SER',
        tracking: 'serial',
        pickedQuantity: q('2'),
        units: [],
      }),
    ).toThrow(UnidentifiedPickError);
  });

  it('refuses selections that do not add up to what was picked', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BAT',
        tracking: 'batch',
        pickedQuantity: q('15'),
        units: [{ batchNumber: 'B-1', quantity: q('10') }],
      }),
    ).toThrow(PickIdentityMismatchError);
  });

  it('refuses selections for more than was picked', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BAT',
        tracking: 'batch',
        pickedQuantity: q('10'),
        units: [{ batchNumber: 'B-1', quantity: q('15') }],
      }),
    ).toThrow(PickIdentityMismatchError);
  });

  it('refuses two units against one serial', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-SER',
        tracking: 'serial',
        pickedQuantity: q('2'),
        units: [{ serialNumber: 'SN-1', quantity: q('2') }],
      }),
    ).toThrow(SerialQuantityError);
  });

  it('refuses the same serial twice — one unit cannot be picked twice', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-SER',
        tracking: 'serial',
        pickedQuantity: q('2'),
        units: [
          { serialNumber: 'SN-1', quantity: q('1') },
          { serialNumber: 'SN-1', quantity: q('1') },
        ],
      }),
    ).toThrow(DuplicateSerialPickError);
  });

  it('refuses a batch row with no batch number', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BAT',
        tracking: 'batch',
        pickedQuantity: q('5'),
        units: [{ batchNumber: '   ', quantity: q('5') }],
      }),
    ).toThrow(UnidentifiedPickError);
  });

  it('takes no selections at all for an untracked item', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-PLAIN',
        tracking: null,
        pickedQuantity: q('5'),
        units: [],
      }),
    ).not.toThrow();

    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-PLAIN',
        tracking: null,
        pickedQuantity: q('5'),
        units: [{ batchNumber: 'B-1', quantity: q('5') }],
      }),
    ).toThrow(PickIdentityMismatchError);
  });

  it('wants both identifiers for a serial_and_batch item (§9.3)', () => {
    // §9.3 allows an item to carry both. Each row is then one serial *and* the
    // batch it came out of — a serial is still one unit.
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BOTH',
        tracking: 'serial_and_batch',
        pickedQuantity: q('2'),
        units: [
          { serialNumber: 'SN-1', batchNumber: 'B-1', quantity: q('1') },
          { serialNumber: 'SN-2', batchNumber: 'B-1', quantity: q('1') },
        ],
      }),
    ).not.toThrow();

    // The serial alone is not enough...
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BOTH',
        tracking: 'serial_and_batch',
        pickedQuantity: q('1'),
        units: [{ serialNumber: 'SN-1', quantity: q('1') }],
      }),
    ).toThrow(UnidentifiedPickError);

    // ...and neither is the batch alone.
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BOTH',
        tracking: 'serial_and_batch',
        pickedQuantity: q('1'),
        units: [{ batchNumber: 'B-1', quantity: q('1') }],
      }),
    ).toThrow(UnidentifiedPickError);
  });

  it('still holds a serial to one unit when a batch is recorded beside it', () => {
    expect(() =>
      assertIdentitiesComplete({
        itemCode: 'ITM-BOTH',
        tracking: 'serial_and_batch',
        pickedQuantity: q('2'),
        units: [{ serialNumber: 'SN-1', batchNumber: 'B-1', quantity: q('2') }],
      }),
    ).toThrow(SerialQuantityError);
  });

  it('explains which way the selection is wrong (§25)', () => {
    try {
      assertIdentitiesComplete({
        itemCode: 'ITM-BAT',
        tracking: 'batch',
        pickedQuantity: q('15'),
        units: [{ batchNumber: 'B-1', quantity: q('10') }],
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('Select the remaining units.');
    }

    try {
      assertIdentitiesComplete({
        itemCode: 'ITM-BAT',
        tracking: 'batch',
        pickedQuantity: q('10'),
        units: [{ batchNumber: 'B-1', quantity: q('15') }],
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('Remove the selections that were not picked.');
    }
  });
});
