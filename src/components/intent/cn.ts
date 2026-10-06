/**
 * Intent UI's class helpers (upstream imports them from the `cn` package),
 * served by the clsx + tailwind-merge the application already has.
 */
import { clsx, type ClassValue } from 'clsx';
import { twJoin as join, twMerge } from 'tailwind-merge';

export type ClassNameValue = ClassValue;

/** Joins class names and lets a later Tailwind utility override an earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Joins class names without merging conflicts — upstream's `twJoin`. */
export function twJoin(...inputs: ClassValue[]): string {
  return join(clsx(inputs));
}
