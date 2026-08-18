/**
 * Import batches — Phase 01.11.
 *
 * §4.4: "Bulk import requires validation preview, error file, import batch ID
 * and rollback before final posting."
 *
 * The batch is the unit of rollback, and the row is the unit of traceability.
 * §26 requires master data to be imported "with source ID", so every row keeps
 * the identifier it carried in the system it came from — and, once committed,
 * the identifier of the record it became. A migration that cannot answer "where
 * did this customer come from?" is a migration nobody can audit.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { IMPORT_BATCH_STATUSES, IMPORT_ROW_STATUSES } from '../../domain/import';
import { appUser } from './platform';

export const importBatchStatus = pgEnum('import_batch_status', IMPORT_BATCH_STATUSES);
export const importRowStatus = pgEnum('import_row_status', IMPORT_ROW_STATUSES);

export const importBatch = pgTable(
  'import_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Which import definition this batch runs through. */
    definitionKey: text('definition_key').notNull(),
    fileName: text('file_name'),
    status: importBatchStatus('status').notNull().default('draft'),

    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    branchCode: text('branch_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
    rollbackReason: text('rollback_reason'),
  },
  (t) => [
    index('import_batch_status_idx').on(t.status, t.createdAt),
    check(
      'import_batch_counts_consistent',
      sql`${t.validRows} + ${t.invalidRows} <= ${t.totalRows}`,
    ),
    // A committed batch has a time; anything else does not.
    check(
      'import_batch_committed_at_matches',
      sql`(${t.status} = 'committed') = (${t.committedAt} is not null)
          or ${t.status} = 'rolled_back'`,
    ),
  ],
);

export const importRow = pgTable(
  'import_row',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatch.id, { onDelete: 'cascade' }),
    rowNo: integer('row_no').notNull(),

    /** §26 — the identifier this row carried in its source system. */
    sourceId: text('source_id'),
    /** The row exactly as it arrived, so a rejection can be explained. */
    rawValues: jsonb('raw_values').notNull(),

    status: importRowStatus('status').notNull().default('pending'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    /** The record this row became. Null until the batch commits. */
    targetId: text('target_id'),
  },
  (t) => [
    uniqueIndex('import_row_no_uniq').on(t.batchId, t.rowNo),
    index('import_row_status_idx').on(t.batchId, t.status),
    index('import_row_source_idx').on(t.sourceId),
    // A row is either fine or it says why not.
    check(
      'import_row_error_matches_status',
      sql`(${t.status} = 'invalid') = (${t.errorMessage} is not null)`,
    ),
  ],
);
