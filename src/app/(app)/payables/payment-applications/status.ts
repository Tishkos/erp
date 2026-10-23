import { statusLabelKey } from '@/server/domain/payment-applications';

/**
 * The chip each payment application status wears — the shared status
 * palette (`status status--<x>`), nothing new drawn.
 */
export const STATUS_CHIP: Readonly<Record<string, string>> = {
  draft: 'draft',
  // Sent for approval (2026-10-06).
  submitted: 'submitted',
  approved: 'approved',
  sent: 'submitted',
  confirmed: 'posted',
  debited: 'settled',
  rejected: 'rejected',
  cancelled: 'cancelled',
  // Paid, then undone (0427): the shared chip for a reversed document.
  reversed: 'reversed',
};

/** "SWIFT pending" / "SWIFT confirmed" — the diagram's wording when the method is SWIFT; "Sent for approval". */
export function statusKey(status: string, kind: string): string {
  return statusLabelKey(status, kind);
}
