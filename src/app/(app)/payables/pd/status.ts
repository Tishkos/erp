/** The chip a PD status wears — the shared status palette, nothing new drawn. */
export function pdChip(row: {
  readonly isTerminal: boolean;
  readonly allowsPayment: boolean;
  readonly isExpired: boolean;
  readonly statusCode: string;
}): string {
  if (row.statusCode === 'totally_written_off') return 'settled';
  if (row.isExpired || row.statusCode === 'rejected') return 'rejected';
  if (row.allowsPayment) return 'approved';
  return 'submitted';
}
