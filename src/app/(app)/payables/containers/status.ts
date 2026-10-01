/** The chip a container status wears — the shared status palette, nothing new drawn. */
export function containerChip(row: { readonly statusCode: string }): string {
  switch (row.statusCode) {
    case 'received':
      return 'settled';
    case 'missing_damaged':
    case 'late':
      return 'rejected';
    case 'at_port':
    case 'customs_cleared':
      return 'approved';
    case 'on_sea':
      return 'submitted';
    default:
      return 'draft';
  }
}
