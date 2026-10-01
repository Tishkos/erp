/**
 * How many line rows the Purchase Invoice form starts with.
 *
 * One, because the grid grows as it is typed: filling the current line opens
 * the next, the way the Journal Entry's grid does. The number the action reads
 * travels with the form (`line_count`), and this is only the fallback for a
 * submission that carried none.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions, and both the form that draws the rows and the action that reads
 * them have to agree on the fallback.
 */
export const LINE_ROWS = 1;
