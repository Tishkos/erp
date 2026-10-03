/**
 * How many line rows the Opening Stock form starts with.
 *
 * One, because the grid grows as it is typed: filling the current line opens
 * the next, the way the invoice grids do. The number the action reads travels
 * with the form (`line_count`), and this is only the fallback for a submission
 * that carried none.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions, and the grid and the action that reads it must agree on it.
 */
export const OPENING_ROWS = 1;
