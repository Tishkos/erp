/**
 * CSV rendering for exports — Phase 01.12.
 *
 * RFC 4180 quoting, and one defence that is not in RFC 4180: a value beginning
 * with `=`, `+`, `-` or `@` is prefixed with a single quote before it is
 * written.
 *
 * Excel treats such a value as a formula. An exported field containing
 * `=HYPERLINK(...)` or `=cmd|...` executes when the recipient opens the file,
 * which turns a permitted export into a way of running something on an
 * accountant's machine. The prefix costs a leading apostrophe in the cell and
 * removes the class of attack entirely. §25's security requirements are about
 * what the system lets happen, not only about what it stores.
 */

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = String(value);

  if (FORMULA_START.test(text)) text = `'${text}`;

  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Render rows to CSV in the given column order.
 *
 * The column list comes from the export query, which came from the screen's
 * query — so a column the reader could not see on screen is not in the header
 * row either. A blank column would tell them what was withheld.
 */
export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [columns.map(escapeCell).join(',')];

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(row[column])).join(','));
  }

  // CRLF per RFC 4180, and a trailing newline so the file ends cleanly.
  return lines.join('\r\n') + '\r\n';
}
