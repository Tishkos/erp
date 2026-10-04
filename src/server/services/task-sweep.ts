/**
 * The Task Center's morning sweep — platform phase, Agent 3.
 *
 * Two things become true while nobody is looking, so they are read once a day
 * and raised through the same filter as every other task notice (only to
 * people who may open the task):
 *
 *   due soon   work still owed whose due date is today or within `DUE_SOON_DAYS`
 *              → the assignee, once when it comes inside the window and once on
 *              the day it is due (the dedupe key carries the due date)
 *   overdue    work still owed whose due date has passed
 *              → the assignee and the assigner, the first morning it is late
 *              and then once a week while it stays late
 *
 * Moving the due date makes a new key, so the new date is reminded in its turn;
 * running the sweep twice in a day raises nothing the first did not. Work
 * handed in, completed, cancelled, refused or still a draft is nobody's to
 * chase by date (`domain/tasks.dueState`).
 */
import type { Tx } from '../db/client';
import { daysUntil, dueState } from '../domain/tasks';
import type { TaskStatus } from '../domain/tasks';
import * as tasks from './tasks';

export interface SweepRun {
  readonly asOf: string;
  readonly dueSoon: number;
  readonly overdue: number;
  readonly created: number;
}

export async function run(tx: Tx, asOf: string): Promise<SweepRun> {
  const owed = await tasks.owedWithDueDate(tx);
  let dueSoon = 0;
  let overdue = 0;
  let created = 0;
  for (const row of owed) {
    const state = dueState(row.status as TaskStatus, row.dueDate, asOf);
    const days = daysUntil(row.dueDate!, asOf);
    if (state === 'today' || state === 'soon') {
      dueSoon += 1;
      created += await tasks.announceFromSweep(tx, row, 'task.due_soon', `${row.dueDate}:${state}`, days);
    } else if (state === 'overdue') {
      overdue += 1;
      const late = -days;
      created += await tasks.announceFromSweep(tx, row, 'task.overdue', `${row.dueDate}:${Math.floor((late - 1) / 7)}`, late);
    }
  }
  return { asOf, dueSoon, overdue, created };
}
