/**
 * The Exception Center — platform phase, Agent 7 (migrations 0380–0381).
 *
 * Three tables. An `exception` is one persisted, de-duplicated finding — its
 * identity is `finding_key` (detector + subject) — whose road
 * (`exception_lifecycle_guard`), history (`exception_history_writer`) and
 * visibility (row-level security: the grant on `exception`, the grant on the
 * object it is about, the branch) are the database's. `services/exceptions.ts`
 * is the only writer; `domain/exceptions.ts` is the same rules without a
 * database. The Exception Center reads business data and never writes it.
 */
import { date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, bigserial } from 'drizzle-orm/pg-core';
import type { EvidenceRow, ExceptionFacts } from '../../domain/exceptions';
import { appUser, branch } from './platform';

export const exception = pgTable(
  'exception',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exceptionNo: text('exception_no').notNull(),
    findingKey: text('finding_key').notNull(),
    detector: text('detector').notNull(),
    subject: text('subject').notNull(),
    domain: text('domain').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    permissionObject: text('permission_object').notNull(),
    branchCode: text('branch_code').references(() => branch.code),
    title: text('title').notNull(),
    explanation: text('explanation').notNull(),
    facts: jsonb('facts').$type<ExceptionFacts>().notNull().default({}),
    evidence: jsonb('evidence').$type<EvidenceRow[]>().notNull().default([]),
    contentHash: text('content_hash').notNull(),
    recordType: text('record_type').notNull(),
    recordId: text('record_id').notNull(),
    recordLabel: text('record_label').notNull(),
    recordHref: text('record_href').notNull(),
    /** The direct action: the screen where it is dealt with. */
    href: text('href').notNull(),
    partyCode: text('party_code'),
    ownerUserId: uuid('owner_user_id').references(() => appUser.id),
    ownerName: text('owner_name'),
    firstDetectedAt: timestamp('first_detected_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => appUser.id),
    acknowledgementNote: text('acknowledgement_note'),
    occurrence: integer('occurrence').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('exception_no_uniq').on(t.exceptionNo),
    uniqueIndex('exception_key_uniq').on(t.findingKey),
    index('exception_domain_idx').on(t.domain, t.status),
    index('exception_object_idx').on(t.permissionObject),
    index('exception_record_idx').on(t.recordType, t.recordId),
    index('exception_seen_idx').on(t.lastSeenAt),
  ],
);

export const exceptionHistory = pgTable(
  'exception_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    exceptionId: uuid('exception_id')
      .notNull()
      .references(() => exception.id),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    fromSeverity: text('from_severity'),
    toSeverity: text('to_severity').notNull(),
    occurrence: integer('occurrence').notNull(),
    actorUserId: uuid('actor_user_id').references(() => appUser.id),
    note: text('note'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('exception_history_exception_idx').on(t.exceptionId, t.id)],
);

export const exceptionSweepRun = pgTable(
  'exception_sweep_run',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    businessDate: date('business_date').notNull(),
    trigger: text('trigger').notNull(),
    triggeredBy: uuid('triggered_by').references(() => appUser.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
    found: integer('found').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    reopened: integer('reopened').notNull().default(0),
    resolved: integer('resolved').notNull().default(0),
    notified: integer('notified').notNull().default(0),
    detectors: jsonb('detectors').$type<unknown[]>().notNull().default([]),
  },
  (t) => [index('exception_sweep_run_finished_idx').on(t.finishedAt)],
);
