/**
 * The Task Center — platform phase, Agent 3 (migrations 0340–0342).
 *
 * One table. A task is a piece of work one person asks another to do, in a
 * section (a department) and a branch; the rules that matter are the
 * database's: the road it walks and who walks each step (`task_lifecycle_guard`),
 * whom it may be given to (`task_assignment_guard`, `app_task_scope`), who may
 * open it (row-level security, `app_task_visible_to`), and that it is never
 * deleted. `services/tasks.ts` is the only writer; `domain/tasks.ts` is the
 * same rules without a database.
 */
import { sql } from 'drizzle-orm';
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';

export const task = pgTable(
  'task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskNo: text('task_no').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    priority: text('priority').notNull().default('normal'),
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    assignedBy: uuid('assigned_by').references(() => appUser.id),
    assigneeId: uuid('assignee_id').references(() => appUser.id),
    dueDate: date('due_date'),
    relatedType: text('related_type'),
    relatedId: text('related_id'),
    relatedLabel: text('related_label'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    watcherIds: uuid('watcher_ids').array().notNull().default(sql`'{}'`),
    statusNote: text('status_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('task_no_uniq').on(t.taskNo),
    index('task_creator_idx').on(t.createdBy, t.status),
    index('task_department_idx').on(t.departmentCode, t.status),
    index('task_branch_idx').on(t.branchCode, t.status),
  ],
);

export type TaskRow = typeof task.$inferSelect;
