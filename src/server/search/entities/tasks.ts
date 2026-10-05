/**
 * Tasks — the Task Center's record in Global Search (platform phase, Agent 3).
 *
 * Priority 42, after the documents (50 is the slot the search suite's TASK-100
 * stand-in registers, and every type has a priority of its own). A task is
 * found by its number (`TASK-100`, `100`), by its title, and by the name of the
 * person it is assigned to. The table's row policy (`app_task_visible_to`,
 * migration 0341) decides which tasks exist for the asker — a draft is its
 * creator's alone, the rest are their parties', their watchers' and their
 * leaders' — and the grant is `view` on `task`, the object the Tasks screen is
 * gated by.
 */
import { sql } from 'drizzle-orm';
import { profileHref } from '../../domain/profiles';
import type { SearchTableType } from '../types';

export const task: SearchTableType = {
  kind: 'table',
  key: 'task',
  priority: 42,
  grant: { object: 'task' },
  route: '/tasks',
  table: 'task',
  id: sql`t.id`,
  attachmentType: 'task',
  series: ['TASK'],
  number: sql`t.task_no`,
  text: [sql`t.title`],
  recent: sql`t.created_at`,
  joins: sql`left join app_user a on a.id = t.assignee_id`,
  title: sql`t.title`,
  status: sql`t.status`,
  date: sql`t.due_date`,
  party: sql`a.display_name`,
  href: (row) => profileHref('task', row.number),
};
