/**
 * How many line rows the Purchase Invoice form offers.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions, and both the form that draws the rows and the action that reads
 * them have to agree on the number.
 */
export const LINE_ROWS = 8;
