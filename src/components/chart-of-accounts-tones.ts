import type { AccountType } from '@domain/accounts';

/**
 * The colour each account type wears on the Chart of Accounts — the type badge
 * in the tree and the icon chip on the account (the Intent UI redesign,
 * 2026-10-06). One table, so an asset reads the same in both places.
 *
 * The hues are the ones the old type tiles had: assets blue, liabilities red,
 * equity the accent, revenue green, expenses amber. Every one is a theme token,
 * so it follows the palette and the accent, light and dark.
 *
 * A plain module, not a client one: the account page is a server component and
 * reads the same table.
 */
export type AccountTone = 'info' | 'danger' | 'primary' | 'success' | 'warning';

export const ACCOUNT_TYPE_TONE: Readonly<Record<AccountType, AccountTone>> = {
  asset: 'info',
  liability: 'danger',
  equity: 'primary',
  revenue: 'success',
  expense: 'warning',
};

/** A badge may also be quiet: the grey of a neutral fact. */
export type BadgeTone = AccountTone | 'secondary';

/** The tint and its ink, by tone — behind an icon chip or a badge. */
export const TONE_CHIP: Readonly<Record<BadgeTone, string>> = {
  info: 'bg-info-subtle text-info-subtle-fg',
  danger: 'bg-danger-subtle text-danger-subtle-fg',
  primary: 'bg-primary-subtle text-primary-subtle-fg',
  success: 'bg-success-subtle text-success-subtle-fg',
  warning: 'bg-warning-subtle text-warning-subtle-fg',
  secondary: 'bg-secondary text-secondary-fg',
};

/**
 * Intent's badge (`components/intent/badge.tsx`, `isCircle: false`), drawn
 * with the tint utilities themselves. The vendored badge reads its colour
 * through `var(--color-primary-subtle)`, which is resolved on the root element,
 * and there the compiled theme leaves the primary tint as the solid accent —
 * so its `primary` badge came out as a filled button. The utilities resolve on
 * the badge itself, where the palette's tint is right.
 */
export function toneBadge(tone: BadgeTone, extra = ''): string {
  return `inline-flex items-center gap-x-1.5 whitespace-nowrap rounded-md px-2 py-px font-medium text-xs/5 forced-colors:outline ${TONE_CHIP[tone]}${extra ? ` ${extra}` : ''}`;
}

export function toneOf(type: string): AccountTone {
  return (ACCOUNT_TYPE_TONE as Readonly<Record<string, AccountTone>>)[type] ?? 'primary';
}
