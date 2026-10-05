/**
 * The automation family — platform phase, Agent 10.
 *
 * Three detectors that are not looking for anything of their own. An automation
 * rule raises a finding under one of them (`exceptions.raiseFromAutomation`, when
 * its `create_exception` action runs); what these runners do is keep it TRUE: for
 * every live finding of the detector they ask the service that knows the fact
 * (`automation-events.PRODUCERS` — tasks, shipment tracking, open items) whether it
 * still holds, and report it again if it does. When it no longer holds — the
 * container was received, the invoice paid, the task done — the finding is not
 * reported, and the sweep resolves it by itself like every other.
 *
 * Read-only, like every detector: the stored rows and the producers are selects.
 */
import { sql } from 'drizzle-orm';
import { EXCEPTION_EVENTS, findingFor } from '../../domain/automation-exceptions';
import { isSeverity, type Finding } from '../../domain/exceptions';
import { PRODUCERS } from '../automation-events';
import { rowsOf, type DetectContext, type Runner } from './shared';

interface Stored {
  subject: string;
  severity: string;
  facts: Record<string, unknown>;
  owner_user_id: string | null;
  owner_name: string | null;
}

async function kept(ctx: DetectContext, detector: string): Promise<Finding[]> {
  const eventKey = EXCEPTION_EVENTS[detector];
  const producer = eventKey ? PRODUCERS[eventKey] : undefined;
  if (!eventKey || !producer) return [];
  const stored = rowsOf<Stored>(
    await ctx.tx.execute(sql`
      select subject, severity, facts, owner_user_id::text, owner_name
        from exception
       where detector = ${detector} and status <> 'resolved'`),
  );
  if (stored.length === 0) return [];
  const now = new Map((await producer(ctx.tx, ctx.principal, ctx.today)).map((p) => [p.subjectId, p.payload]));
  const found: Finding[] = [];
  for (const row of stored) {
    const payload = now.get(row.subject);
    if (!payload || !isSeverity(row.severity)) continue;
    const finding = findingFor(eventKey, payload, {
      severity: row.severity,
      ruleNo: String(row.facts.rule ?? ''),
      note: String(row.facts.note ?? ''),
      assignee: row.owner_name ? { userId: row.owner_user_id, name: row.owner_name } : null,
    });
    if (finding) found.push(finding);
  }
  return found;
}

export const containerEta: Runner = (ctx) => kept(ctx, 'logistics.automation_container_eta');
export const taskOverdue: Runner = (ctx) => kept(ctx, 'tasks.automation_task_overdue');
export const invoiceOverdue: Runner = (ctx) => kept(ctx, 'receivables.automation_invoice_overdue');
