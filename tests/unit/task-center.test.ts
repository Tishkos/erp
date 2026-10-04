/**
 * Task Center — the rules, the catalogue and the migrations hold together,
 * with no database (platform phase, Agent 3).
 *
 * The road is one table (`domain/tasks.ts` TRANSITIONS); migration 0340's
 * trigger holds the same pairs at the database and this reads the migration
 * as text and fails when the two disagree. Who may take each step, the due
 * date's states, the notices and who gets them, and the messages the screens
 * ask for in both languages are held here; the scope of assignment, the row
 * policy and the triggers' refusals are `tests/integration/task-center.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  NOTICE_FOR_ACTION,
  OWED,
  SCOPE_VIAS,
  TASK_ACTIONS,
  TASK_NOTIFICATION_KINDS,
  TASK_STATUSES,
  TASK_STATUS_TONE,
  TRANSITIONS,
  TaskError,
  actionsFor,
  allowedPairs,
  assertDescription,
  assertDueDate,
  assertPriority,
  assertTitle,
  assertTransition,
  daysUntil,
  dueState,
  isFinal,
  mayTake,
  noticeText,
  normaliseTags,
  progressOf,
  reasonFor,
  recipientsOf,
  waitingOn,
  type TaskAction,
  type TaskStanding,
  type TaskStatus,
} from '@/server/domain/tasks';
import { STATUS_CODES, chipOf } from '@/server/domain/search';
import * as documentTypes from '@/server/search/entities/documents';
import * as filesType from '@/server/search/entities/files';
import * as logisticsTypes from '@/server/search/entities/logistics';
import * as masterTypes from '@/server/search/entities/masters';
import { task as searchType } from '@/server/search/entities/tasks';

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const CORE = read('src/server/db/migrations/0340_task_core.sql');
const standing = (status: TaskStatus, who: Partial<Omit<TaskStanding, 'status'>> = {}): TaskStanding => ({
  status,
  isAssignee: false,
  isAssigner: false,
  isCreator: false,
  isAdmin: false,
  ...who,
});

describe('TC1 · the road', () => {
  it('is the road the database trigger holds, pair for pair', () => {
    const guard = CORE.slice(CORE.indexOf('allowed pairs (from, to)'));
    const fromMigration = [...guard.slice(0, guard.indexOf(';')).matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const fromDomain = allowedPairs().map(([from, to]) => `${from}>${to}`).sort();
    expect(fromMigration.length).toBeGreaterThan(15);
    expect(fromDomain).toEqual(fromMigration);
  });

  it('leaves a completed or cancelled task where it is', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(isFinal(status)).toBe(true);
      expect(allowedPairs().filter(([from]) => from === status)).toEqual([]);
      for (const action of TASK_ACTIONS) expect(() => assertTransition('TASK-1', status, action)).toThrow(TaskError);
    }
  });

  it('never goes back to draft, and reaches every status from a draft', () => {
    expect(allowedPairs().some(([, to]) => to === 'draft')).toBe(false);
    const seen = new Set<TaskStatus>(['draft']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [from, to] of allowedPairs()) {
        if (seen.has(from) && !seen.has(to)) {
          seen.add(to);
          grew = true;
        }
      }
    }
    expect([...seen].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it('refuses a step off the road in a sentence that names the task and the status', () => {
    expect(assertTransition('TASK-007', 'draft', 'assign')).toBe('assigned');
    expect(() => assertTransition('TASK-007', 'draft', 'start')).toThrow(/TASK-007 is draft; it cannot be started/);
    expect(() => assertTransition('TASK-007', 'assigned', 'complete')).toThrow(/cannot be completed/);
    expect(() => assertTransition('TASK-007', 'in_progress', 'accept')).toThrow(/cannot be accepted/);
    expect(assertTransition('TASK-007', 'submitted', 'return')).toBe('in_progress');
    expect(assertTransition('TASK-007', 'rejected', 'reassign')).toBe('assigned');
  });

  it('puts the reason where the road asks for one', () => {
    const required = TASK_ACTIONS.filter((a) => TRANSITIONS[a].reason === 'required').sort();
    expect(required).toEqual(['block', 'cancel', 'reassign', 'reject', 'return']);
    for (const action of required) {
      expect(() => reasonFor(action, '')).toThrow(/Say why/);
      expect(() => reasonFor(action, '   ')).toThrow(TaskError);
      expect(reasonFor(action, '  waiting for the customs paper ')).toBe('waiting for the customs paper');
    }
    expect(reasonFor('accept', '')).toBeNull();
    expect(reasonFor('complete', ' well done ')).toBe('well done');
    expect(() => reasonFor('block', 'x'.repeat(1001))).toThrow(/1000 characters/);
  });
});

describe('TC2 · who takes each step', () => {
  it('gives the assignee the working steps and the assigner the review', () => {
    expect(actionsFor(standing('assigned', { isAssignee: true }))).toEqual(['accept', 'reject']);
    expect(actionsFor(standing('accepted', { isAssignee: true }))).toEqual(['start']);
    expect(actionsFor(standing('in_progress', { isAssignee: true }))).toEqual(['block', 'submit']);
    expect(actionsFor(standing('blocked', { isAssignee: true }))).toEqual(['resume']);
    expect(actionsFor(standing('submitted', { isAssignee: true }))).toEqual([]);
    expect(actionsFor(standing('submitted', { isAssigner: true }))).toEqual(['complete', 'return', 'cancel']);
    expect(actionsFor(standing('rejected', { isAssigner: true }))).toEqual(['reassign', 'cancel']);
    expect(actionsFor(standing('in_progress', { isAssigner: true }))).toEqual(['reassign', 'cancel']);
  });

  it('lets the creator assign a draft and cancel it, and nobody else touch it', () => {
    expect(actionsFor(standing('draft', { isCreator: true }))).toEqual(['assign', 'cancel']);
    expect(actionsFor(standing('draft', { isAssignee: true }))).toEqual([]);
    expect(actionsFor(standing('draft'))).toEqual([]);
  });

  it('lets an administrator stand in for the assigner, never for the assignee', () => {
    expect(actionsFor(standing('submitted', { isAdmin: true }))).toEqual(['complete', 'return', 'cancel']);
    expect(actionsFor(standing('assigned', { isAdmin: true }))).toEqual(['reassign', 'cancel']);
    for (const action of ['accept', 'reject', 'start', 'block', 'resume', 'submit'] as TaskAction[]) {
      expect(mayTake(action, standing(TRANSITIONS[action].from[0]!, { isAdmin: true }))).toBe(false);
    }
  });

  it('offers a bystander nothing, and a final task nothing to anyone', () => {
    for (const status of TASK_STATUSES) expect(actionsFor(standing(status))).toEqual([]);
    for (const status of ['completed', 'cancelled'] as const) {
      expect(actionsFor(standing(status, { isAssignee: true, isAssigner: true, isCreator: true, isAdmin: true }))).toEqual([]);
    }
  });

  it('lets one person who is all three parties take both sides of their own task', () => {
    const all = { isAssignee: true, isAssigner: true, isCreator: true };
    expect(actionsFor(standing('submitted', all))).toEqual(['complete', 'return', 'cancel']);
    expect(actionsFor(standing('assigned', all))).toEqual(['accept', 'reject', 'reassign', 'cancel']);
  });

  it('names who the next step waits on', () => {
    expect(waitingOn('draft')).toBe('creator');
    expect(waitingOn('assigned')).toBe('assignee');
    expect(waitingOn('blocked')).toBe('assignee');
    expect(waitingOn('submitted')).toBe('assigner');
    expect(waitingOn('rejected')).toBe('assigner');
    expect(waitingOn('completed')).toBeNull();
    expect(waitingOn('cancelled')).toBeNull();
  });

  it('reads progress as the stage of the road, never a measure of the work', () => {
    expect(progressOf('draft')).toBe(0);
    expect(progressOf('assigned')).toBeLessThan(progressOf('accepted'));
    expect(progressOf('accepted')).toBeLessThan(progressOf('in_progress'));
    expect(progressOf('blocked')).toBe(progressOf('in_progress'));
    expect(progressOf('in_progress')).toBeLessThan(progressOf('submitted'));
    expect(progressOf('submitted')).toBeLessThan(progressOf('completed'));
    expect(progressOf('completed')).toBe(100);
    expect(progressOf('cancelled')).toBe(0);
  });
});

describe('TC3 · the deadline', () => {
  it('counts whole days between two business dates', () => {
    expect(daysUntil('2026-10-07', '2026-10-04')).toBe(3);
    expect(daysUntil('2026-10-04', '2026-10-04')).toBe(0);
    expect(daysUntil('2026-10-01', '2026-10-04')).toBe(-3);
    expect(daysUntil('2027-03-01', '2027-02-28')).toBe(1);
    expect(daysUntil('2028-03-01', '2028-02-28')).toBe(2);
  });

  it('is only ever late for work still owed', () => {
    expect([...OWED].sort()).toEqual(['accepted', 'assigned', 'blocked', 'in_progress']);
    const today = '2026-10-04';
    for (const status of TASK_STATUSES) {
      const state = dueState(status, '2026-10-01', today);
      expect(state).toBe(OWED.includes(status) ? 'overdue' : 'none');
    }
    expect(dueState('in_progress', null, today)).toBe('none');
  });

  it('calls a deadline today, soon (up to three days) or later', () => {
    const today = '2026-10-04';
    expect(dueState('assigned', '2026-10-03', today)).toBe('overdue');
    expect(dueState('assigned', '2026-10-04', today)).toBe('today');
    expect(dueState('assigned', '2026-10-05', today)).toBe('soon');
    expect(dueState('assigned', '2026-10-07', today)).toBe('soon');
    expect(dueState('assigned', '2026-10-08', today)).toBe('later');
    expect(dueState('assigned', '2026-10-08', today, 5)).toBe('soon');
  });

  it('accepts today or later, a real calendar day, and nothing else', () => {
    expect(assertDueDate('', '2026-10-04')).toBeNull();
    expect(assertDueDate(null, '2026-10-04')).toBeNull();
    expect(assertDueDate('2026-10-04', '2026-10-04')).toBe('2026-10-04');
    expect(assertDueDate(' 2026-12-31 ', '2026-10-04')).toBe('2026-12-31');
    expect(assertDueDate('2028-02-29', '2026-10-04')).toBe('2028-02-29');
    expect(() => assertDueDate('2026-10-03', '2026-10-04')).toThrow(/already passed/);
    expect(() => assertDueDate('2026-02-30', '2026-10-04')).toThrow(/not a date/);
    expect(() => assertDueDate('2027-02-29', '2026-10-04')).toThrow(/not a date/);
    expect(() => assertDueDate('04/10/2026', '2026-10-04')).toThrow(/YYYY-MM-DD/);
  });
});

describe('TC4 · what a person types', () => {
  it('keeps a title to one tidy line of 3 to 200 characters', () => {
    expect(assertTitle('  Reconcile   the   Erbil\n bank ')).toBe('Reconcile the Erbil bank');
    expect(() => assertTitle('ab')).toThrow(/at least 3/);
    expect(() => assertTitle('   ')).toThrow(TaskError);
    expect(() => assertTitle('x'.repeat(201))).toThrow(/at most 200/);
    expect(assertTitle('x'.repeat(200))).toHaveLength(200);
  });

  it('keeps a description as written, trimmed, up to 4000 characters, and empty as none', () => {
    expect(assertDescription('  \r\n ')).toBeNull();
    expect(assertDescription(null)).toBeNull();
    expect(assertDescription('First line\r\n\r\nSecond')).toBe('First line\n\nSecond');
    expect(() => assertDescription('x'.repeat(4001))).toThrow(/at most 4000/);
  });

  it('defaults the priority to normal and knows only the four', () => {
    expect(assertPriority('')).toBe('normal');
    expect(assertPriority(undefined)).toBe('normal');
    expect(assertPriority('urgent')).toBe('urgent');
    expect(() => assertPriority('whenever')).toThrow(/one of low, normal, high, urgent/);
  });

  it('splits tags on commas, semicolons, new lines and the Arabic comma, without repeats', () => {
    expect(normaliseTags('audit, Audit ,  year end;q4\nرواتب،رواتب')).toEqual(['audit', 'year end', 'q4', 'رواتب']);
    expect(normaliseTags(['a', ' ', 'A', 'b'])).toEqual(['a', 'b']);
    expect(normaliseTags(null)).toEqual([]);
    expect(() => normaliseTags('1,2,3,4,5,6,7,8,9')).toThrow(/at most 8 tags/);
    expect(() => normaliseTags('x'.repeat(31))).toThrow(/at most 30/);
  });
});

describe('TC5 · notices go to the people the step concerns', () => {
  const people = { creator: 'creator', assigner: 'assigner', assignee: 'assignee', watchers: ['w1', 'w2'] };

  it('tells the assignee of the work, and the watchers', () => {
    expect(recipientsOf('task.assigned', people).sort()).toEqual(['assignee', 'w1', 'w2']);
    expect(recipientsOf('task.completed', people).sort()).toEqual(['assignee', 'w1', 'w2']);
    expect(recipientsOf('task.cancelled', people).sort()).toEqual(['assignee', 'w1', 'w2']);
    expect(recipientsOf('task.updated', people).sort()).toEqual(['assignee', 'w1', 'w2']);
    expect(recipientsOf('task.returned', people)).toEqual(['assignee']);
    expect(recipientsOf('task.due_soon', people)).toEqual(['assignee']);
  });

  it('tells the assigner, the raiser and the watchers what the assignee did', () => {
    for (const kind of ['task.accepted', 'task.rejected', 'task.started', 'task.blocked', 'task.resumed', 'task.submitted'] as const) {
      expect(recipientsOf(kind, people).sort()).toEqual(['assigner', 'creator', 'w1', 'w2']);
    }
  });

  it('tells a late task to the person who owes it and the one who asked', () => {
    expect(recipientsOf('task.overdue', people).sort()).toEqual(['assignee', 'assigner']);
  });

  it('adds the person a task was taken from, once, and never twice for one person on two parts', () => {
    expect(recipientsOf('task.reassigned', people, 'before').sort()).toEqual(['assignee', 'before', 'w1', 'w2']);
    expect(recipientsOf('task.accepted', { ...people, assigner: 'same', creator: 'same', watchers: [] })).toEqual(['same']);
    expect(recipientsOf('task.assigned', { ...people, assignee: null, watchers: [] })).toEqual([]);
  });

  it('has a notice for every step, and one block of fourteen kinds', () => {
    expect(TASK_NOTIFICATION_KINDS).toHaveLength(14);
    expect(new Set(TASK_NOTIFICATION_KINDS).size).toBe(14);
    for (const action of TASK_ACTIONS) expect(TASK_NOTIFICATION_KINDS).toContain(NOTICE_FOR_ACTION[action]);
    expect(TASK_NOTIFICATION_KINDS).toEqual(expect.arrayContaining(['task.updated', 'task.due_soon', 'task.overdue']));
    for (const kind of TASK_NOTIFICATION_KINDS) {
      const text = noticeText(kind, { taskNo: 'TASK-012', title: 'Close the books', actor: 'Layla', assignee: 'Omar', reason: 'waiting', dueDate: '2026-10-09', days: 2 });
      expect(text.subject).toContain('TASK-012');
      expect(text.body.length).toBeGreaterThan(0);
      expect(`${text.subject}${text.body}`).not.toMatch(/undefined|null|\[object/);
    }
    expect(noticeText('task.due_soon', { taskNo: 'T-1', title: 'x', days: 0 }).subject).toMatch(/today/);
    expect(noticeText('task.due_soon', { taskNo: 'T-1', title: 'x', days: 1 }).subject).toMatch(/tomorrow/);
    expect(noticeText('task.overdue', { taskNo: 'T-1', title: 'x', days: 1 }).subject).toBe('T-1 is 1 day overdue');
    expect(noticeText('task.overdue', { taskNo: 'T-1', title: 'x', days: 3 }).subject).toBe('T-1 is 3 days overdue');
  });

  it('is emitted only through the notification service, in one exported block', () => {
    const service = read('src/server/services/notifications.ts');
    expect(service.match(/TASK_EVENT_TYPES/g)).toHaveLength(1);
    expect(service).toContain('TASK_NOTICE_TARGET');
    const tasks = read('src/server/services/tasks.ts');
    expect(tasks).toContain('notifications.insertNotification');
    expect(tasks).not.toMatch(/insert\(notification\b/);
    const sweep = read('src/server/services/task-sweep.ts');
    expect(sweep).not.toMatch(/insert\(notification\b/);
  });
});

describe('TC6 · the names a person is shown', () => {
  it('gives every status a chip tone the application already draws', () => {
    expect(Object.keys(TASK_STATUS_TONE).sort()).toEqual([...TASK_STATUSES].sort());
    const css = read('src/app/globals.css');
    for (const tone of new Set(Object.values(TASK_STATUS_TONE))) expect(css, `status--${tone}`).toContain(`.status--${tone}`);
  });

  it('names the four ways an assignee can be in scope', () => {
    expect([...SCOPE_VIAS]).toEqual(['self', 'report', 'department', 'organisation']);
    for (const via of SCOPE_VIAS) expect(CORE + read('src/server/db/migrations/0341_task_scope.sql')).toContain(`'${via}'`);
  });

  it('has the same task messages in both languages, every one filled', () => {
    const en = JSON.parse(read('messages/en.json'));
    const ar = JSON.parse(read('messages/ar.json'));
    const enKeys = Object.keys(en.admin.tasks).sort();
    expect(Object.keys(ar.admin.tasks).sort()).toEqual(enKeys);
    for (const [locale, messages] of [['en', en], ['ar', ar]] as const) {
      for (const [key, value] of Object.entries(messages.admin.tasks)) expect(String(value).trim(), `${locale} admin.tasks.${key}`).not.toBe('');
      expect(Object.keys(messages.audit_action.task).sort(), `${locale} audit_action.task`).toEqual(Object.keys(en.audit_action.task).sort());
      expect(messages.print.titles.task, `${locale} print.titles.task`).toBeTruthy();
      expect(messages.search.types.task, `${locale} search.types.task`).toBeTruthy();
    }
  });

  it('has every message the screens and the print model ask for', () => {
    const en = JSON.parse(read('messages/en.json')).admin.tasks as Record<string, string>;
    const sources = ['src/app/(app)/tasks/page.tsx', 'src/app/(app)/tasks/[taskNo]/page.tsx', 'src/server/print/task-documents.ts'];
    const asked = new Set<string>();
    for (const file of sources) {
      const text = read(file);
      for (const m of text.matchAll(/\bx\('([a-z_]+)'/g)) asked.add(m[1]!);
    }
    for (const key of asked) expect(en[key], `admin.tasks.${key}`).toBeDefined();
    for (const status of TASK_STATUSES) expect(en[`status_${status}`], `status_${status}`).toBeDefined();
    for (const action of TASK_ACTIONS) expect(en[`action_${action}`], `action_${action}`).toBeDefined();
    for (const action of ['reject', 'block', 'return', 'cancel']) expect(en[`reason_${action}`], `reason_${action}`).toBeDefined();
    for (const via of SCOPE_VIAS) expect(en[`via_${via}`], `via_${via}`).toBeDefined();
    for (const step of ['created', 'assigned', 'accepted', 'started', 'blocked', 'submitted', 'completed', 'cancelled']) expect(en[`timeline_${step}`], `timeline_${step}`).toBeDefined();
    for (const bucket of ['all', 'open', 'today', 'soon', 'overdue', 'blocked', 'review', 'completed']) expect(en[`bucket_${bucket}`], `bucket_${bucket}`).toBeDefined();
    for (const priority of ['low', 'normal', 'high', 'urgent']) expect(en[`priority_${priority}`], `priority_${priority}`).toBeDefined();
  });

  it('shows a task in Global Search with every status labelled', () => {
    for (const status of TASK_STATUSES) {
      expect(STATUS_CODES, status).toContain(status);
      expect(chipOf(status)).toBeTruthy();
    }
    for (const locale of ['en', 'ar']) {
      const messages = JSON.parse(read(`messages/${locale}.json`));
      for (const status of TASK_STATUSES) expect(messages.search.status[status], `${locale} search.status.${status}`).toBeTruthy();
    }
  });
});

describe('TC7 · the catalogue and the migrations', () => {
  const dialect = new PgDialect();
  const text = (expression: SQL) => dialect.sqlToQuery(expression).sql.trim();

  it('searches a task by a plain number column the table has an index on', () => {
    expect(searchType.key).toBe('task');
    expect(searchType.grant).toEqual({ object: 'task' });
    expect(searchType.series).toEqual(['TASK']);
    expect(text(searchType.number)).toBe('t.task_no');
    expect(CORE.replace(/\s+/g, ' ')).toContain('CREATE UNIQUE INDEX "task_no_uniq" ON "task" ("task_no")');
    expect(text(searchType.recent!)).toBe('t.created_at');
    expect(CORE.replace(/\s+/g, ' ')).toMatch(/CREATE INDEX "task_recent_idx" ON "task" \("created_at" DESC NULLS LAST\)/);
  });

  it('has a search priority of its own, apart from the search suite’s TASK-100 stand-in (50)', () => {
    const others = [documentTypes, filesType, logisticsTypes, masterTypes]
      .flatMap((module) => Object.values(module))
      .filter((value): value is { kind: string; priority: number } => typeof value === 'object' && value !== null && 'priority' in value)
      .map((type) => type.priority);
    expect(others.length).toBeGreaterThan(20);
    expect(others).not.toContain(searchType.priority);
    expect(searchType.priority).not.toBe(50);
  });

  it('numbers tasks from the TASK series, never deleted, never changed in place by the application role', () => {
    expect(CORE).toContain("VALUES ('TASK', 'TASK', '{PREFIX}-{SERIAL}', 3");
    expect(CORE).toMatch(/BEFORE DELETE ON "task"/);
    expect(CORE).not.toMatch(/GRANT[^;]*DELETE[^;]*ON "task"/i);
    const scope = read('src/server/db/migrations/0341_task_scope.sql');
    expect(scope).toMatch(/CREATE TRIGGER "task_lifecycle_guard"\s+BEFORE INSERT OR UPDATE ON "task"/);
  });

  it('forces row-level security and scopes the policy by the visibility function', () => {
    const scope = read('src/server/db/migrations/0341_task_scope.sql');
    expect(scope).toMatch(/ALTER TABLE "task" ENABLE ROW LEVEL SECURITY/);
    expect(scope).toMatch(/ALTER TABLE "task" FORCE ROW LEVEL SECURITY/);
    expect(scope).toMatch(/CREATE POLICY task_scope ON "task"/);
    expect(scope).toContain('app_task_visible_to');
    expect(scope).toContain('app_task_scope');
    expect(scope).toMatch(/CREATE TRIGGER "task_assignment_guard"\s+BEFORE INSERT OR UPDATE ON "task"/);
  });

  it('appends its migrations after the journal, in order, with times past the platform block before it', () => {
    const journal = JSON.parse(read('src/server/db/migrations/meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
    const mine = journal.entries.filter((e) => /^034[0-4]_/.test(e.tag));
    expect(mine.map((e) => e.tag)).toEqual(['0340_task_core', '0341_task_scope', '0342_task_grants', '0343_task_team', '0344_task_system_session']);
    expect(mine.map((e) => e.when)).toEqual([1795900000150, 1795900000151, 1795900000152, 1795900000153, 1795900000154]);
    // The history has lineage repairs out of order; what is held is that ours come after everything else, strictly.
    const others = journal.entries.filter((e) => !mine.includes(e)).map((e) => e.when);
    expect(Math.min(...mine.map((e) => e.when))).toBeGreaterThan(Math.max(...others));
    expect(new Set(journal.entries.map((e) => e.when)).size).toBe(journal.entries.length);
    for (const entry of mine) expect(existsSync(join(ROOT, `src/server/db/migrations/${entry.tag}.sql`))).toBe(true);
  });

  it('is in both reset lists, so a format or a test run leaves no orphan', () => {
    expect(read('tests/integration/setup.ts')).toMatch(/\btask\b/);
    expect(read('scripts/ops/format-live-database.sh')).toMatch(/\btask\b/);
  });

  it('adds one crontab line for the sweep, through run-job.sh', () => {
    const lines = read('scripts/ops/crontab.erp').split('\n').filter((l) => l.includes('task-sweep') && !l.trim().startsWith('#'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('$RUN task-sweep');
    expect(existsSync(join(ROOT, 'scripts/ops/task-sweep.ts'))).toBe(true);
  });

  it('serves the screens it declares', () => {
    expect(existsSync(join(ROOT, 'src/app/(app)/tasks/page.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, 'src/app/(app)/tasks/[taskNo]/page.tsx'))).toBe(true);
    const record = read('src/app/(app)/tasks/[taskNo]/page.tsx');
    for (const door of ['<ExportIcon', '<RecordAttachmentsDoor', '<RecordNotesDoor', '<HistoryButton']) expect(record, door).toContain(door);
    expect(record.indexOf('<ExportIcon')).toBeLessThan(record.indexOf('<RecordAttachmentsDoor'));
    expect(record.indexOf('<RecordAttachmentsDoor')).toBeLessThan(record.indexOf('<RecordNotesDoor'));
    expect(record.indexOf('<RecordNotesDoor')).toBeLessThan(record.indexOf('<HistoryButton'));
  });
});
