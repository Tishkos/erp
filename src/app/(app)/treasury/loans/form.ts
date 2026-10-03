/**
 * What the new-loan form and its action agree on.
 *
 * Its own module because a `'use server'` file may export only async
 * functions, so a constant the action needs cannot live beside it — the same
 * arrangement as `payables/invoices/lines.ts`.
 */

/**
 * The bank-code value that means "not in the register; I have typed its name".
 * Underscored so it cannot collide with a code from the BANK_CODE series.
 */
export const NEW_BANK = '__new__';

/** Due-date rows to read when the form's own count does not arrive. */
export const DUE_ROWS = 1;
