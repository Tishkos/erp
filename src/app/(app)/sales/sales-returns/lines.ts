/**
 * How many line rows the Sales Return form offers.
 *
 * Its own module because a `'use server'` file may export nothing but async
 * functions, and the form and the action must agree on the number.
 */
export const LINE_ROWS = 8;
