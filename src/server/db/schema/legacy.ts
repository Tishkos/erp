import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businessPartner } from './organisation';
import { appUser } from './platform';

/**
 * The legacy books — REQ-LEGACY-001 (2026-10-02).
 *
 *   legacy_import_run   every dry run and apply of the accountant's export,
 *                       with its report, as the sheet migration keeps its runs.
 *   legacy_document     the old system's registers kept as they were: every
 *                       sale line, purchase line, receipt and payment, linked
 *                       to the partner it names where one matched. Read-only
 *                       history — nothing here posts; the opening balances
 *                       carry the net position.
 */
export const legacyImportRun = pgTable('legacy_import_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  mode: text('mode').notNull(),
  /** The uploaded files' names, in the order given. */
  fileNames: jsonb('file_names').notNull().$type<string[]>(),
  /** SHA-256 over the files' contents, in name order — what "the same set" means. */
  setSha256: text('set_sha256').notNull(),
  cutOverDate: date('cut_over_date').notNull(),
  report: jsonb('report').notNull(),
  runBy: uuid('run_by')
    .notNull()
    .references(() => appUser.id),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
});

export const LEGACY_DOCUMENT_KINDS = ['sale', 'purchase', 'receipt', 'payment'] as const;
export type LegacyDocumentKind = (typeof LEGACY_DOCUMENT_KINDS)[number];

export const legacyDocument = pgTable(
  'legacy_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().$type<LegacyDocumentKind>(),
    /** The old system's list or voucher number. */
    legacyNo: text('legacy_no').notNull(),
    lineNo: integer('line_no').notNull().default(1),
    /** The old system's account number, as written on the row (vouchers) or matched by name (sales). */
    legacyAccountNo: text('legacy_account_no'),
    partyName: text('party_name').notNull(),
    partnerId: uuid('partner_id').references(() => businessPartner.id),
    documentDate: date('document_date'),
    itemName: text('item_name'),
    quantity: text('quantity'),
    unit: text('unit'),
    unitCostIqd: text('unit_cost_iqd'),
    unitPriceIqd: text('unit_price_iqd'),
    amount: text('amount'),
    currency: text('currency'),
    operation: text('operation'),
    sourceFile: text('source_file').notNull(),
    sourceRow: integer('source_row').notNull(),
    importRunId: uuid('import_run_id')
      .notNull()
      .references(() => legacyImportRun.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('legacy_document_key_uniq').on(t.kind, t.legacyNo, t.lineNo, t.sourceRow),
    index('legacy_document_partner_idx').on(t.partnerId, t.kind),
    index('legacy_document_account_idx').on(t.legacyAccountNo),
    check('legacy_document_kind', sql`${t.kind} in ('sale', 'purchase', 'receipt', 'payment')`),
  ],
);
