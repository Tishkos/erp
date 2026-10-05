/**
 * Workflow automation — platform phase, Agent 10 (migrations 0400–0402).
 *
 * `automation_rule` is one rule, built from a template and born OFF; its
 * definition lives in `automation_rule_version` (append-only: a change is a new
 * version, and a run names the one it used). `automation_event` is the outbox a
 * business transaction records into and the runner consumes in order;
 * `automation_run` is the append-only log of what each rule did with each event.
 * `services/automation.ts` is the only writer of the rule and its versions,
 * `services/automation-runner.ts` of the events' processing and the runs, and
 * `automation_record_event` (a definer function) of a new event. The database
 * holds the closed vocabulary itself (`automation_rule_version_guard`).
 */
import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Action, Condition, Outcome } from '../../domain/automation';
import { appUser } from './platform';

export const automationSetting = pgTable('automation_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: uuid('updated_by').references(() => appUser.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const automationRule = pgTable(
  'automation_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleNo: text('rule_no').notNull(),
    eventKey: text('event_key').notNull(),
    templateCode: text('template_code').notNull(),
    name: text('name').notNull(),
    currentVersion: integer('current_version').notNull().default(1),
    /** Whose permissions the rule runs with: whoever last saved or enabled it. */
    ownerUserId: uuid('owner_user_id').notNull().references(() => appUser.id),
    enabled: boolean('enabled').notNull().default(false),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    enabledBy: uuid('enabled_by').references(() => appUser.id),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedReason: text('paused_reason'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastOutcome: text('last_outcome').$type<Outcome>(),
    createdBy: uuid('created_by').notNull().references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('automation_rule_no_uniq').on(t.ruleNo), index('automation_rule_owner_idx').on(t.ownerUserId)],
);

export const automationRuleVersion = pgTable(
  'automation_rule_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id').notNull().references(() => automationRule.id),
    version: integer('version').notNull(),
    eventKey: text('event_key').notNull(),
    name: text('name').notNull(),
    templateCode: text('template_code').notNull(),
    params: jsonb('params').$type<Record<string, string | number | boolean>>().notNull(),
    conditions: jsonb('conditions').$type<Condition[]>().notNull(),
    actions: jsonb('actions').$type<Action[]>().notNull(),
    changedBy: uuid('changed_by').notNull().references(() => appUser.id),
    changeNote: text('change_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('automation_rule_version_uniq').on(t.ruleId, t.version)],
);

export const automationEvent = pgTable(
  'automation_event',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    eventKey: text('event_key').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectKey: text('subject_key').notNull(),
    windowKey: text('window_key').notNull(),
    episodeKey: text('episode_key').notNull(),
    branchCode: text('branch_code'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    lastError: text('last_error'),
    rulesSeen: integer('rules_seen').notNull().default(0),
    rulesMatched: integer('rules_matched').notNull().default(0),
  },
  (t) => [uniqueIndex('automation_event_once').on(t.eventKey, t.subjectKey, t.windowKey)],
);

export const automationRun = pgTable(
  'automation_run',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ruleId: uuid('rule_id').notNull().references(() => automationRule.id),
    ruleVersion: integer('rule_version').notNull(),
    eventId: bigint('event_id', { mode: 'bigint' }).notNull().references(() => automationEvent.id),
    eventKey: text('event_key').notNull(),
    subjectKey: text('subject_key').notNull(),
    windowKey: text('window_key').notNull(),
    episodeKey: text('episode_key').notNull(),
    runKey: text('run_key').notNull(),
    attempt: integer('attempt').notNull().default(1),
    ownerUserId: uuid('owner_user_id').notNull().references(() => appUser.id),
    outcome: text('outcome').$type<Outcome>().notNull(),
    reason: text('reason').notNull(),
    planned: jsonb('planned').$type<unknown[]>().notNull().default([]),
    results: jsonb('results').$type<unknown[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('automation_run_attempt_uniq').on(t.eventId, t.ruleId, t.attempt)],
);

/** What automation made (migration 0402): the loop guard's memory. Append-only; written by the runner with the run it belongs to. */
export const automationMade = pgTable(
  'automation_made',
  {
    recordType: text('record_type').notNull(),
    recordId: text('record_id').notNull(),
    recordLabel: text('record_label').notNull(),
    ruleId: uuid('rule_id').notNull().references(() => automationRule.id),
    runId: bigint('run_id', { mode: 'bigint' }).notNull().references(() => automationRun.id),
    depth: integer('depth').notNull(),
    madeAt: timestamp('made_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.recordType, t.recordId] }), index('automation_made_rule_idx').on(t.ruleId, t.madeAt)],
);
