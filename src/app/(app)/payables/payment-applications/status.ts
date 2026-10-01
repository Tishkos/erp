/**
 * The chip each payment application status wears — the shared status
 * palette (`status status--<x>`), nothing new drawn.
 */
export const STATUS_CHIP: Readonly<Record<string, string>> = {
  draft: 'draft',
  approved: 'approved',
  sent: 'submitted',
  confirmed: 'posted',
  debited: 'settled',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

/** "SWIFT pending" / "SWIFT confirmed" — the diagram's wording when the method is SWIFT. */
export function statusKey(status: string, kind: string): string {
  return kind === 'swift' && (status === 'sent' || status === 'confirmed')
    ? `status_swift_${status}`
    : `status_${status}`;
}
