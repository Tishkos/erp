/**
 * How many line rows the Sales Invoice form offers.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions, and the grid and the action that reads it must agree on the number.
 */
export const LINE_ROWS = 8;
