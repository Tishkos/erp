/**
 * Phase 01.7 test gate — *"Submission freezes the fields marked controlled;
 * uncontrolled fields remain editable where the status allows."*
 *
 * §24: *"Submission freezes controlled fields and starts the approval
 * workflow."*
 */
import { describe, expect, it } from 'vitest';
import {
  ControlledFieldFrozenError,
  assertControlledFieldsUnchanged,
  changedControlledFields,
  editabilityOf,
  freezesControlledFields,
} from '@domain/controlled-fields';
import { DocumentNotEditableError } from '@domain/statuses';

const CONTROLLED = ['posting_date', 'total_debit_iqd', 'branch_code'];

describe('§24 · how much of a document may change, by status', () => {
  it('lets a draft change entirely — nothing has been approved yet', () => {
    expect(editabilityOf('draft')).toBe('all');
  });

  it('freezes the controlled fields from submission onward', () => {
    for (const status of ['submitted', 'approved', 'partially_executed', 'executed'] as const) {
      expect(editabilityOf(status), status).toBe('uncontrolled_only');
    }
  });

  it('freezes a final document completely', () => {
    // §1.1 — a correction to a posted document is a reversing document, not an
    // edit (§14.3).
    for (const status of ['posted', 'settled', 'cancelled', 'reversed', 'closed'] as const) {
      expect(editabilityOf(status), status).toBe('none');
    }
  });

  it('thaws a rejected document, because it goes back to draft', () => {
    // 'rejected' is a resting state the document leaves by returning to draft.
    expect(freezesControlledFields('draft')).toBe(false);
    expect(freezesControlledFields('submitted')).toBe(true);
  });
});

describe('§24 · what counts as a change', () => {
  it('reports a controlled field that moved', () => {
    expect(
      changedControlledFields(CONTROLLED, { posting_date: '2026-01-31' }, { posting_date: '2026-02-01' }),
    ).toEqual(['posting_date']);
  });

  it('ignores a field that was written with the same value', () => {
    // A retried save is not an edit; refusing it would make an idempotent
    // write fail the second time.
    expect(
      changedControlledFields(CONTROLLED, { posting_date: '2026-01-31' }, { posting_date: '2026-01-31' }),
    ).toEqual([]);
  });

  it('ignores a field the caller did not mention at all', () => {
    expect(changedControlledFields(CONTROLLED, { branch_code: 'HQ' }, { description: 'x' })).toEqual(
      [],
    );
  });

  it('compares a date and its string form as the same value', () => {
    // The driver returns a business date as a string and a timestamp as a Date;
    // a false "changed" here would block an untouched field.
    const iso = '2026-01-31T00:00:00.000Z';
    expect(
      changedControlledFields(['at'], { at: new Date(iso) }, { at: iso }),
    ).toEqual([]);
  });

  it('reports a nested value that moved', () => {
    expect(
      changedControlledFields(['lines'], { lines: [{ debit: '1' }] }, { lines: [{ debit: '2' }] }),
    ).toEqual(['lines']);
  });
});

describe('01.7 gate · the freeze', () => {
  it('permits any change while the document is a draft', () => {
    expect(() =>
      assertControlledFieldsUnchanged(
        'journal_entry',
        'draft',
        CONTROLLED,
        { posting_date: '2026-01-31' },
        { posting_date: '2026-02-01' },
      ),
    ).not.toThrow();
  });

  it('refuses a controlled field once submitted, naming it', () => {
    try {
      assertControlledFieldsUnchanged(
        'journal_entry',
        'submitted',
        CONTROLLED,
        { posting_date: '2026-01-31' },
        { posting_date: '2026-02-01' },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ControlledFieldFrozenError);
      const e = error as ControlledFieldFrozenError;
      expect(e.fields).toEqual(['posting_date']);
      // §25 — the reason and the corrective action.
      expect(e.message).toMatch(/Recall the document/);
    }
  });

  it('leaves an uncontrolled field editable once submitted', () => {
    // The whole point of the distinction: fixing a typo must not require a
    // recall, or people learn to approve without reading.
    expect(() =>
      assertControlledFieldsUnchanged(
        'journal_entry',
        'submitted',
        CONTROLLED,
        { description: 'Rnt' },
        { description: 'Rent' },
      ),
    ).not.toThrow();
  });

  it('names every controlled field a change would touch, not just the first', () => {
    try {
      assertControlledFieldsUnchanged(
        'journal_entry',
        'approved',
        CONTROLLED,
        { posting_date: '2026-01-31', total_debit_iqd: '100' },
        { posting_date: '2026-02-01', total_debit_iqd: '200' },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ControlledFieldFrozenError).fields).toEqual([
        'posting_date',
        'total_debit_iqd',
      ]);
    }
  });

  it('refuses even an uncontrolled field once the document is final', () => {
    expect(() =>
      assertControlledFieldsUnchanged(
        'journal_entry',
        'posted',
        CONTROLLED,
        { description: 'Rnt' },
        { description: 'Rent' },
      ),
    ).toThrow(DocumentNotEditableError);
  });

  it('permits a no-op write against a final document', () => {
    // Writing the same values changes nothing, and a save that re-sends what is
    // already there should not fail.
    expect(() =>
      assertControlledFieldsUnchanged(
        'journal_entry',
        'posted',
        CONTROLLED,
        { description: 'Rent' },
        { description: 'Rent' },
      ),
    ).not.toThrow();
  });

  it('controls nothing when a document type declares nothing', () => {
    // An explicit answer, not an oversight: some documents genuinely carry no
    // field an approver relies on.
    expect(() =>
      assertControlledFieldsUnchanged('note', 'submitted', [], { body: 'a' }, { body: 'b' }),
    ).not.toThrow();
  });
});
