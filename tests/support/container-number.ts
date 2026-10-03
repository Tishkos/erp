import { checkDigitFor } from '../../src/lib/container-number';

/**
 * A container number with its ISO 6346 check digit — tests that make up
 * numbers make up valid ones, as the screens and services now refuse a wrong
 * last digit (IMPROVEMENT-002).
 */
export function containerNo(owner: string, serial: string | number): string {
  const head = `${owner.toUpperCase()}${String(serial).padStart(6, '0').slice(-6)}`;
  const digit = checkDigitFor(head);
  if (digit === null) throw new Error(`'${head}' is not the first ten characters of a container number.`);
  return `${head}${digit}`;
}
