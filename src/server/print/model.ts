import type { Locale } from '@/i18n/config';

/**
 * One printable thing — a document or a report — in a shape that knows
 * nothing about paper, spreadsheets or word processors.
 *
 * Every export is built twice over: once by reading the services the screen
 * reads, into this model, and once by rendering the model into a format. The
 * split is the guarantee the three formats agree with each other and with the
 * screen: the figures are fetched in one place, and the PDF, the workbook and
 * the Word file are three drawings of the same numbers.
 *
 * Figures stay as the decimal strings the services return. A renderer turns
 * them into what its format wants — a formatted string for paper, a number for
 * a spreadsheet cell — so nothing is rounded before the last moment and a
 * total is never re-added from already-rounded text.
 */

/** How a column's values are read. */
export type ColumnKind =
  /** Free text, already in the words it is shown in. */
  | 'text'
  /** An identifier: a number, a code. Printed left to right in either language. */
  | 'code'
  /** An ISO `YYYY-MM-DD` business date. */
  | 'date'
  /** A decimal string, in the model's currency. */
  | 'money'
  /** A decimal string, a count of units. */
  | 'quantity';

export interface Column {
  readonly key: string;
  readonly label: string;
  readonly kind: ColumnKind;
  /** Relative width. Money and codes are narrow; names are wide. */
  readonly weight?: number;
  /**
   * A money column that shows up to this many places instead of the
   * currency's own — a unit cost, which is rarely a whole dinar.
   */
  readonly decimals?: number;
  /**
   * A signed balance shown as the ledger shows it — the amount, then Dr or
   * Cr — while the workbook keeps the signed number.
   */
  readonly sides?: { readonly debit: string; readonly credit: string };
}

/** A cell holds the service's value, never a formatted one. Null is blank. */
export type Cell = string | null;

export type RowTone =
  /** An ordinary line. */
  | 'line'
  /** A grouping line on a statement, carrying the sum of what is under it. */
  | 'header'
  /** One account under a statement line. */
  | 'account'
  /** A figure the report computes: a margin, a result, a side's total. */
  | 'subtotal'
  /** The balance brought forward on a statement. */
  | 'opening'
  /** The balance carried forward on a statement. */
  | 'closing';

export interface Row {
  readonly cells: Readonly<Record<string, Cell>>;
  readonly tone?: RowTone;
  /** Steps of indentation on a hierarchical report. */
  readonly depth?: number;
  /**
   * Whether this row is one of those the totals add up. A statement's opening
   * line, a group row that already carries its children's sum, a subtotal —
   * each would be counted twice. Defaults to true for `line` rows only.
   */
  readonly counts?: boolean;
}

export interface Totals {
  readonly label: string;
  /** The service's own totals, by column. These are what paper prints. */
  readonly cells: Readonly<Record<string, Cell>>;
  /**
   * The columns whose total is a sum of the rows above it — a formula in a
   * workbook. Any other total (a closing balance, which is where the running
   * balance ends, not a sum) is written as the service's figure. Defaults to
   * every numeric column with a total.
   */
  readonly sum?: readonly string[];
}

export interface Table {
  readonly title?: string;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  /** What to say when there are no rows. */
  readonly empty: string;
  readonly totals?: Totals;
}

export interface Fact {
  readonly label: string;
  readonly value: string;
  /** Printed left to right whatever the language: numbers, codes, dates. */
  readonly ltr?: boolean;
}

export interface PrintModel {
  readonly kind: 'document' | 'report';
  /** The document's or report's name in the build's words. */
  readonly title: string;
  /** The system number, printed large. Documents only. */
  readonly number?: string;
  /** The status, in words — every document states it. */
  readonly status?: string;
  /**
   * Whether the document has posted. A document that has not carries the
   * DRAFT / NOT POSTED watermark on every page, in every format.
   */
  readonly posted?: boolean;
  readonly orientation: 'portrait' | 'landscape';
  /** The header fields, exactly as the screen shows them. */
  readonly fields: readonly Fact[];
  /** The filters the screen was run with. Reports only. */
  readonly filters: readonly Fact[];
  readonly tables: readonly Table[];
  /** Figures after the tables: the closing balance, the result. */
  readonly summary: readonly Fact[];
  /** Prepared by / Approved by (CEO) / Received by. */
  readonly signatures: boolean;
  /** The currency every money column is in. */
  readonly currency: 'IQD' | 'USD';
  /** The file name without its extension — the document number for a document. */
  readonly fileName: string;
  /** The sheet name in a workbook. */
  readonly sheetName: string;
}

/** Who printed it, where and when — the letterhead and its provenance. */
export interface Letterhead {
  readonly locale: Locale;
  readonly companyEn: string;
  readonly companyAr: string;
  /** "HQ · Head Office". */
  readonly branch: string;
  readonly printedBy: string;
  /** ISO instant. */
  readonly printedAt: string;
  readonly labels: PrintLabels;
}

/** The words the renderers print themselves, in the document's language. */
export interface PrintLabels {
  readonly branch: string;
  readonly printedAt: string;
  readonly printedBy: string;
  readonly filters: string;
  /** "Page {page} of {pages}" — both placeholders are replaced. */
  readonly pageOf: string;
  readonly watermark: string;
  readonly preparedBy: string;
  readonly approvedBy: string;
  readonly receivedBy: string;
}

export const FORMATS = ['pdf', 'xlsx', 'docx'] as const;
export type ExportFormat = (typeof FORMATS)[number];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value);
}

export const CONTENT_TYPE: Readonly<Record<ExportFormat, string>> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Whether a row adds into its table's totals. */
export function counts(row: Row): boolean {
  return row.counts ?? (row.tone === undefined || row.tone === 'line');
}

/** Numeric columns align to the end of the cell and are added up. */
export function isNumeric(column: Column): boolean {
  return column.kind === 'money' || column.kind === 'quantity';
}

/**
 * REQ-IMPROVE-001 OP-9 (IM6) — the most rows one file may carry.
 *
 * An export is rendered in memory, and a reader who asks for "all movements
 * since 2019" as a PDF would hold the server's memory for as long as the
 * render takes. Above the cap the answer is a sentence — narrow the filters
 * — rather than a file that may or may not arrive. The cap is counted over
 * every table in the model, so a document with a thousand allocations is
 * measured the same way as a report.
 */
export const EXPORT_ROW_CAP = Number(process.env.EXPORT_ROW_CAP ?? 20_000);

export function rowsIn(model: PrintModel): number {
  return model.tables.reduce((n, table) => n + table.rows.length, 0);
}
