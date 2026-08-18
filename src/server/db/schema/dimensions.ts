/**
 * Dimensions framework — Phase 02.4.
 *
 * §4.2: "Dimensions shall be mandatory or optional by account and document
 * type." Three tables, one per layer of that resolution, plus a registry
 * recording where each dimension's values actually live.
 *
 * The dimension **type** enum already exists — it is created in migration 0003
 * for `account_required_dimension`, which is the account layer. This file adds
 * the other two layers and the registry.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, pgEnum, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { accountType as accountTypeEnum, dimensionType } from './accounting';
import { documentType } from './workflow';

/** §4.2 — a dimension is mandatory or optional. Nothing else. */
export const dimensionRequirement = pgEnum('dimension_requirement', ['mandatory', 'optional']);

/**
 * Where each dimension draws its values from.
 *
 * Branch and Department have masters from Phase 01. Business Line and Business
 * Partner arrive in Phase 03, Warehouse in Phase 04, Project in Phase 11,
 * Employee in Phase 15. A dimension with no source table is registered but not
 * yet usable — it cannot be required on an account and a value cannot be
 * supplied for it.
 *
 * That refusal is deliberate. Accepting a Warehouse code before warehouses
 * exist would fill a column with values nothing can check, and Phase 04 would
 * inherit the mess.
 */
export const dimensionDefinition = pgTable(
  'dimension_definition',
  {
    dimension: dimensionType('dimension').primaryKey(),
    label: text('label').notNull(),
    /** Table holding this dimension's values; null until its phase lands. */
    sourceTable: text('source_table'),
    /** Column in that table carrying the code a posting references. */
    sourceCodeColumn: text('source_code_column'),
    /** Column marking a value as still usable, when the master has one. */
    sourceActiveColumn: text('source_active_column'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    // A source table without the column to read from it is not a source.
    check(
      'dimension_definition_source_complete',
      sql`(${t.sourceTable} is null) = (${t.sourceCodeColumn} is null)`,
    ),
    // Identifiers are interpolated into dynamic SQL by the lookup function, so
    // the shape is constrained here rather than trusted there.
    check(
      'dimension_definition_identifier_shape',
      sql`(${t.sourceTable} is null or ${t.sourceTable} ~ '^[a-z_][a-z0-9_]*$')
          and (${t.sourceCodeColumn} is null or ${t.sourceCodeColumn} ~ '^[a-z_][a-z0-9_]*$')
          and (${t.sourceActiveColumn} is null or ${t.sourceActiveColumn} ~ '^[a-z_][a-z0-9_]*$')`,
    ),
  ],
);

/**
 * Layer 1 — the setting for a document type.
 *
 * Sits above the account so that the 02.4 gate holds: "The same account can be
 * mandatory for one document type and optional for another, if so configured."
 * A row saying `optional` is therefore a deliberate relaxation, not an absence
 * of configuration — which is why absence and `optional` are different things
 * and only one of them is stored.
 */
export const documentTypeDimension = pgTable(
  'document_type_dimension',
  {
    documentTypeCode: text('document_type_code')
      .notNull()
      .references(() => documentType.code, { onDelete: 'cascade' }),
    dimension: dimensionType('dimension').notNull(),
    requirement: dimensionRequirement('requirement').notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentTypeCode, t.dimension] })],
);

/**
 * Layer 3 — §4.2's own defaults, by account type.
 *
 * The blueprint's validation column states these directly: Department/Cost
 * Centre for operating expense accounts, Business Line for revenue and direct
 * cost accounts. Held as data rather than as code so the Business Process Owner
 * can change them without a release, and so they are visible to an auditor
 * asking why a posting was refused.
 */
export const accountTypeDimensionDefault = pgTable(
  'account_type_dimension_default',
  {
    accountType: accountTypeEnum('account_type').notNull(),
    dimension: dimensionType('dimension').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountType, t.dimension] })],
);
