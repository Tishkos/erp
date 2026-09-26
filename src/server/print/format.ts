import {
  formatBusinessDate,
  formatQuantity,
  formatStatementAmount,
  formatTimestamp,
  type Locale,
} from '@/i18n/config';
import type { Cell, Column, PrintModel } from './model';

/**
 * How a cell reads on paper — the PDF, the Word file and the print view.
 *
 * The same formatters the screens use, so a figure prints as it was shown.
 * Money is written the way the statements already write it (sponsor,
 * 2026-09-01): thousands separators, the currency named once in the column
 * heading rather than on every row, a negative in brackets.
 */
export function display(
  column: Column,
  value: Cell,
  model: Pick<PrintModel, 'currency'>,
  locale: Locale,
): string {
  if (value === null || value === '') return '';
  switch (column.kind) {
    case 'money': {
      if (column.sides) {
        const amount = Number(value);
        const figure = formatStatementAmount(Math.abs(amount), model.currency, locale);
        return amount === 0 ? figure : `${figure} ${amount < 0 ? column.sides.credit : column.sides.debit}`;
      }
      if (column.decimals !== undefined) {
        return new Intl.NumberFormat(locale, { maximumFractionDigits: column.decimals }).format(Number(value));
      }
      return formatStatementAmount(value, model.currency, locale);
    }
    case 'quantity':
      return formatQuantity(value, locale);
    case 'date':
      return formatBusinessDate(value, locale);
    default:
      return value;
  }
}

/** A money column says its currency once, in the heading. */
export function heading(column: Column, model: Pick<PrintModel, 'currency'>): string {
  return column.kind === 'money' ? `${column.label} · ${model.currency}` : column.label;
}

export function printedAt(iso: string, locale: Locale): string {
  return formatTimestamp(iso, locale);
}

/** "Page 2 of 5", in the document's language. */
export function pageOf(template: string, page: number, pages: number): string {
  return template.replace('{page}', String(page)).replace('{pages}', String(pages));
}

/** A file name the browser and every OS accept, from a document number. */
export function safeFileName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^_+|_+$/g, '') || 'export';
}
