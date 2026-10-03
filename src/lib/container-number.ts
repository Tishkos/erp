/**
 * ISO 6346 container numbers — the shape and the check digit, for the screen
 * and the server alike (the grid warns as a number is typed; the service
 * refuses it all the same).
 *
 * Owner code (three letters), category (U, J, Z or R), six serial digits and
 * a check digit computed from the ten before it: letters take 10…38 skipping
 * the multiples of 11, each character is weighted 2^position, and the sum
 * modulo 11 (10 read as 0) is the digit.
 */
const SHAPE = /^[A-Z]{3}[UJZR][0-9]{7}$/;

export const isContainerShape = (value: string) => SHAPE.test(value);

/** The check digit the first ten characters call for, or null when they are not a container's. */
export function checkDigitFor(head: string): number | null {
  if (!/^[A-Z]{3}[UJZR][0-9]{6}$/.test(head)) return null;
  const letterValue = (c: string) => {
    let v = 10;
    for (let code = 65; code < c.charCodeAt(0); code += 1) {
      v += 1;
      if (v % 11 === 0) v += 1;
    }
    return v;
  };
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const c = head[i]!;
    sum += (/[A-Z]/.test(c) ? letterValue(c) : Number(c)) * 2 ** i;
  }
  return (sum % 11) % 10;
}

/** The number as typed with spaces and dashes taken out, upper case. */
export const compactContainerNo = (value: string) => value.replace(/[\s-]+/g, '').toUpperCase();
