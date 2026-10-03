/**
 * Case-insensitive match of a search phrase against every value of a row.
 *
 * The list screens filter with it, and so do their printed copies — a report
 * printed from a searched list prints the rows the search left, no more.
 */
export function matches(row: Record<string, unknown>, q: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return Object.values(row).some((value) => {
    if (value === null || value === undefined) return false;
    if (value instanceof Date) return false;
    return String(value).toLowerCase().includes(needle);
  });
}
