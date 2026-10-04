/**
 * Work detectors — platform phase, Agent 7: overdue and blocked tasks (the
 * Task Center's own feeds) and documents waiting too long for a decision.
 */
import { sql } from 'drizzle-orm';
import { businessDateOf } from '../../domain/business-date';
import { daysBetween } from '../../domain/ageing';
import { EVIDENCE_ROW, THRESHOLDS, severityByDays, shift, type Finding, type Severity } from '../../domain/exceptions';
import * as approvals from '../approvals';
import * as tasks from '../tasks';
import { rowsOf, userNames, type DetectContext } from './shared';

const TASK_FEED_LIMIT = 200;

interface TaskExtra {
  readonly id: string;
  readonly blockedOn: string | null;
  readonly reason: string | null;
}

async function taskExtras(ctx: DetectContext, taskNos: readonly string[]): Promise<Map<string, TaskExtra>> {
  if (taskNos.length === 0) return new Map();
  const rows = rowsOf<{ task_no: string; id: string; blocked_on: string | null; status_note: string | null }>(
    await ctx.tx.execute(sql`
      select task_no, id::text, blocked_at::text as blocked_on, status_note
        from task where task_no in (${sql.join(taskNos.map((n) => sql`${n}`), sql`, `)})`),
  );
  return new Map(rows.map((r) => [r.task_no, { id: r.id, blockedOn: r.blocked_on, reason: r.status_note }]));
}

/** An urgent task is one step more severe than its lateness alone says. */
const byPriority = (severity: Severity, priority: string): Severity => (priority === 'urgent' ? shift(severity, 1) : severity);

/** Tasks past their due date and still owed — `tasks.overdueTasks`, the Task Center's feed for this centre. */
export async function tasksOverdue(ctx: DetectContext): Promise<Finding[]> {
  const { tx, principal, today } = ctx;
  const brief = await tasks.overdueTasks(tx, { principal }, TASK_FEED_LIMIT, today);
  if (brief.length >= TASK_FEED_LIMIT) {
    const [total] = rowsOf<{ n: number }>(
      await tx.execute(sql`select count(*)::int as n from task where status in ('assigned', 'accepted', 'in_progress', 'blocked') and due_date < ${today}::date`),
    );
    if (total && total.n > brief.length) ctx.truncated.set('tasks.overdue', { total: total.n, shown: brief.length });
  }
  const extras = await taskExtras(ctx, brief.map((b) => b.taskNo));
  const findings: Finding[] = [];
  for (const row of brief) {
    const base = severityByDays(row.daysLate, THRESHOLDS.taskOverdue);
    const extra = extras.get(row.taskNo);
    if (base === null || !extra) continue;
    findings.push({
      detector: 'tasks.overdue',
      subject: extra.id,
      severity: byPriority(base, row.priority),
      facts: {
        task: row.taskNo,
        taskTitle: row.title,
        dueDate: row.dueDate,
        days: row.daysLate,
        priority: row.priority,
        assignee: row.assigneeName,
      },
      evidence: [EVIDENCE_ROW({ ref: row.taskNo, href: row.href, date: row.dueDate, note: { code: 'task_overdue', params: { days: row.daysLate } } })],
      record: { type: 'task', id: extra.id, label: row.taskNo, href: row.href },
      action: row.href,
      branchCode: row.branchCode,
      owner: row.assigneeId ? { userId: row.assigneeId, name: row.assigneeName ?? '' } : null,
    });
  }
  return findings;
}

/** Tasks that have sat blocked — `tasks.blockedTasks`. */
export async function tasksBlocked(ctx: DetectContext): Promise<Finding[]> {
  const { tx, principal, today } = ctx;
  const brief = await tasks.blockedTasks(tx, { principal }, TASK_FEED_LIMIT, today);
  if (brief.length >= TASK_FEED_LIMIT) {
    const [total] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n from task where status = 'blocked'`));
    if (total && total.n > brief.length) ctx.truncated.set('tasks.blocked', { total: total.n, shown: brief.length });
  }
  const extras = await taskExtras(ctx, brief.map((b) => b.taskNo));
  const findings: Finding[] = [];
  for (const row of brief) {
    const extra = extras.get(row.taskNo);
    if (!extra || !extra.blockedOn) continue;
    const days = daysBetween(extra.blockedOn.slice(0, 10), today);
    const base = severityByDays(days, THRESHOLDS.taskBlocked);
    if (base === null) continue;
    findings.push({
      detector: 'tasks.blocked',
      subject: extra.id,
      severity: byPriority(base, row.priority),
      facts: { task: row.taskNo, taskTitle: row.title, sinceDate: extra.blockedOn.slice(0, 10), days, priority: row.priority, assignee: row.assigneeName, reason: extra.reason },
      evidence: [EVIDENCE_ROW({ ref: row.taskNo, href: row.href, date: extra.blockedOn.slice(0, 10), note: { code: 'task_blocked', params: { days, reason: extra.reason ?? '' } } })],
      record: { type: 'task', id: extra.id, label: row.taskNo, href: row.href },
      action: row.href,
      branchCode: row.branchCode,
      owner: row.assigneeId ? { userId: row.assigneeId, name: row.assigneeName ?? '' } : null,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A document waiting too long for its decision
// ---------------------------------------------------------------------------

export async function approvalWaiting(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const rows = rowsOf<{
    id: string;
    document_type_code: string;
    document_id: string;
    branch_code: string | null;
    submitted_at: string;
    assigned_to_user_id: string | null;
    submitter: string;
    approver_role: string | null;
  }>(
    await tx.execute(sql`
      select i.id::text, i.document_type_code, i.document_id, i.branch_code, i.submitted_at::text as submitted_at,
             i.assigned_to_user_id::text, u.display_name as submitter, s.approver_role
        from workflow_instance i
        join app_user u on u.id = i.submitted_by
        left join workflow_step s on s.definition_id = i.definition_id and s.sequence = i.current_step
       where not i.is_complete and i.current_step is not null
       order by i.submitted_at
       limit ${THRESHOLDS.findingsPerDetector * 2}`),
  );
  const names = await userNames(tx, rows.map((r) => r.assigned_to_user_id));
  const findings: Finding[] = [];
  for (const row of rows) {
    const submitted = businessDateOf(new Date(row.submitted_at));
    const days = daysBetween(submitted, today);
    const severity = severityByDays(days, THRESHOLDS.approvalWaiting);
    if (severity === null) continue;
    const reference = await approvals.recordReference(tx, row.document_type_code, row.document_id);
    const approver = row.assigned_to_user_id ? (names.get(row.assigned_to_user_id) ?? '') : '';
    findings.push({
      detector: 'approvals.waiting_too_long',
      subject: row.id,
      severity,
      facts: {
        docKind: row.document_type_code,
        document: reference.label,
        submitter: row.submitter,
        approver: approver || row.approver_role || null,
        sinceDate: submitted,
        days,
      },
      evidence: [EVIDENCE_ROW({ ref: reference.label, href: reference.href, date: submitted, note: { code: 'approval_waiting', params: { days } } })],
      record: { type: 'workflow_instance', id: row.id, label: reference.label, href: reference.href ?? '/approvals' },
      action: '/approvals',
      branchCode: row.branch_code,
      owner: row.assigned_to_user_id ? { userId: row.assigned_to_user_id, name: approver } : null,
    });
  }
  return findings;
}
