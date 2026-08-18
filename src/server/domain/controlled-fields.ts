/**
 * Controlled fields — Phase 01.7, §24.
 *
 * §24: *"Submission freezes controlled fields and starts the approval
 * workflow."*
 * 01.7 gate: *"Submission freezes the fields marked controlled; uncontrolled
 * fields remain editable where the status allows."*
 *
 * The distinction matters because "frozen on submission" and "frozen entirely"
 * are different controls with different costs. An approver signs off on an
 * amount, a date, a branch and an account; if any of those can change after the
 * signature, the approval means nothing. But a description with a typo in it,
 * or a note nobody approved, should not require a full recall-and-resubmit —
 * that is the kind of friction that teaches people to approve without reading.
 *
 * So each document type declares which of its fields carry the approval. The
 * list is configuration rather than code because it differs per type and
 * because §28.1 makes it a business decision, not a technical one.
 */

import { DocumentNotEditableError, isFinal, type DocumentStatus } from './statuses';

export class ControlledFieldFrozenError extends Error {
  readonly code = 'CONTROLLED_FIELD_FROZEN';

  constructor(
    readonly documentType: string,
    readonly fields: readonly string[],
  ) {
    // §25 — the field, the reason, and what to do instead.
    super(
      `${fields.join(', ')} ${fields.length === 1 ? 'is' : 'are'} part of what was submitted for ` +
        `approval on this ${documentType} and cannot be changed now. ` +
        'Recall the document, change it, and submit it again — the approver sees what they approve (§24).',
    );
    this.name = 'ControlledFieldFrozenError';
  }
}

/** A field's value before and after a proposed change. */
export type FieldValues = Readonly<Record<string, unknown>>;

/**
 * Which of the declared controlled fields this change would alter.
 *
 * Compared by value, not by presence: an update that writes the same value is
 * not a change, and refusing it would make an idempotent save fail the second
 * time it is retried.
 */
export function changedControlledFields(
  controlled: readonly string[],
  before: FieldValues,
  after: FieldValues,
): readonly string[] {
  return controlled.filter((field) => {
    if (!(field in after)) return false;
    return !sameValue(before[field], after[field]);
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;

  // Dates and numerics arrive as strings from the driver in some paths and as
  // values in others; comparing the rendered form avoids a false "changed" on
  // a field nobody touched.
  if (a instanceof Date || b instanceof Date) {
    return String(a instanceof Date ? a.toISOString() : a) ===
      String(b instanceof Date ? b.toISOString() : b);
  }

  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  return String(a) === String(b);
}

/**
 * How much of a document may change, given its status.
 *
 *   all               a draft — nothing has been approved yet
 *   uncontrolled_only submitted, approved, executed: the approval stands, and
 *                     the fields it rests on are frozen (§24)
 *   none              posted, settled, cancelled, reversed, closed — §1.1's
 *                     "no deletion of saved or posted records", and its
 *                     counterpart: no silent edit either. A correction is a
 *                     reversing document (§14.3).
 *
 * Three answers rather than two, because "frozen on submission" and "frozen
 * forever" are different controls. Collapsing them either lets a posted figure
 * be edited or forces a recall to fix a typo, and the second teaches people to
 * approve without reading.
 */
export type Editability = 'all' | 'uncontrolled_only' | 'none';

export function editabilityOf(status: DocumentStatus): Editability {
  if (status === 'draft') return 'all';
  if (isFinal(status)) return 'none';
  return 'uncontrolled_only';
}

/**
 * Whether a status freezes controlled fields.
 *
 * Everything past draft does. A rejected document returns to draft, which
 * thaws it — that is the point of returning it rather than cancelling it.
 */
export function freezesControlledFields(status: DocumentStatus): boolean {
  return editabilityOf(status) !== 'all';
}

/**
 * The check.
 *
 * Takes the declared list so the caller cannot forget to load it and get a
 * silent pass: an empty list has to be an explicit statement that this document
 * type controls nothing, which is a defensible answer for, say, a note.
 */
export function assertControlledFieldsUnchanged(
  documentType: string,
  status: DocumentStatus,
  controlled: readonly string[],
  before: FieldValues,
  after: FieldValues,
): void {
  const editability = editabilityOf(status);
  if (editability === 'all') return;

  if (editability === 'none') {
    // A final document changes through a reversing document, not in place.
    // Every field is refused, not only the controlled ones.
    const changed = changedControlledFields(Object.keys(after), before, after);
    if (changed.length > 0) throw new DocumentNotEditableError(documentType, status);
    return;
  }

  const changed = changedControlledFields(controlled, before, after);
  if (changed.length > 0) {
    throw new ControlledFieldFrozenError(documentType, changed);
  }
}
