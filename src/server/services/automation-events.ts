/**
 * The events that become true while nobody is looking — platform phase, Agent 10.
 *
 * A record event (a purchase invoice submitted or posted) is fired by the
 * service that does the work (`automation-dispatch.dispatch`). A SWEEP event is
 * read here, once a business day, from the services that already know the
 * answer — never a loop over arbitrary tables:
 *
 *   task.overdue            `tasks.owedWithDueDate` + `domain/tasks.dueState`
 *   container.eta_exceeded  `logistics-views.shipmentTracking` (open containers, `delayDays`)
 *   ar_invoice.overdue      `open-items.openItems` (customer side, outstanding, past due)
 *
 * A producer returns the payload each subject has right now; `produce` records
 * one event per subject per business day (the outbox's unique key) and only for
 * an event a rule is listening for. `current` answers the same question for one
 * subject: it is what the exception family (`exception-detectors/automation.ts`)
 * re-verifies a raised finding with, so an exception raised by a rule resolves
 * by itself when the lateness is gone.
 *
 * Everything here READS (the exception detectors call it in a transaction the
 * database holds read-only); only `produce` writes, and only the outbox.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import { EVENTS, sweepWindow, type EventKey } from '../domain/automation-events';
import { can, type Principal } from '../domain/permissions';
import { daysUntil, dueState, type TaskStatus } from '../domain/tasks';
import * as authz from './authorization';
import * as dispatcher from './automation-dispatch';
import * as views from './logistics-views';
import * as openItems from './open-items';
import * as tasks from './tasks';

type Payload = Record<string, unknown>;

export interface Produced {
  readonly subjectId: string;
  readonly payload: Payload;
}

export type Producer = (tx: Tx, principal: Principal, today: string) => Promise<Produced[]>;

type Rows<T> = { rows: T[] };

// ---------------------------------------------------------------------------
// task.overdue
// ---------------------------------------------------------------------------

const taskOverdue: Producer = async (tx, _principal, today) => {
  const owed = await tasks.owedWithDueDate(tx);
  const out: Produced[] = [];
  for (const row of owed) {
    if (dueState(row.status as TaskStatus, row.dueDate, today) !== 'overdue') continue;
    const late = -daysUntil(row.dueDate!, today);
    out.push({
      subjectId: row.id,
      payload: {
        subjectId: row.id,
        reference: row.taskNo,
        branchCode: row.branchCode,
        taskTitle: row.title,
        assigneeId: row.assigneeId,
        raisedBy: row.createdBy,
        priority: row.priority,
        departmentCode: row.departmentCode,
        dueDate: row.dueDate,
        daysLate: late,
      },
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// container.eta_exceeded
// ---------------------------------------------------------------------------

const containerEta: Producer = async (tx, _principal, today) => {
  const { rows } = await views.shipmentTracking(tx, { view: 'open', asOf: today });
  const late = rows.filter((row) => row.delayDays !== null && row.delayDays >= 1 && row.eta !== null);
  if (late.length === 0) return [];
  const branches = new Map(
    (
      (await tx.execute(sql`
        select c.id::text, p.branch_code
          from shipment_container c join payable p on p.id = c.payable_id
         where c.id in (${sql.join(late.map((r) => sql`${r.id}::uuid`), sql`, `)})`)) as unknown as Rows<{ id: string; branch_code: string }>
    ).rows.map((r) => [r.id, r.branch_code]),
  );
  return late.map((row) => ({
    subjectId: row.id,
    payload: {
      subjectId: row.id,
      reference: row.containerNo,
      branchCode: branches.get(row.id) ?? null,
      blNo: row.blNo,
      supplierName: row.supplierName,
      importNo: row.payableNo,
      etaDate: row.eta,
      daysLate: row.delayDays,
    },
  }));
};

// ---------------------------------------------------------------------------
// ar_invoice.overdue
// ---------------------------------------------------------------------------

const invoiceOverdue: Producer = async (tx, principal, today) => {
  if (!can(principal, 'view', 'ar_invoice')) return [];
  const items = (await openItems.openItems(tx, principal, 'customer', today, { outstandingOnly: true })).filter(
    (item) => item.documentKind === 'invoice' && item.daysOverdue > 0,
  );
  if (items.length === 0) return [];
  const raisers = new Map(
    (
      (await tx.execute(sql`
        select i.id::text, i.created_by::text as "createdBy", i.department_code as "departmentCode"
          from ar_invoice i
         where i.id in (${sql.join(items.map((r) => sql`${r.invoiceId}::uuid`), sql`, `)})`)) as unknown as Rows<{ id: string; createdBy: string | null; departmentCode: string | null }>
    ).rows.map((r) => [r.id, r]),
  );
  return items.map((item) => ({
    subjectId: item.invoiceId,
    payload: {
      subjectId: item.invoiceId,
      reference: item.invoiceNo,
      branchCode: item.branchCode,
      customerCode: item.partyCode,
      customerName: item.partyName,
      amountIqd: item.outstandingIqd,
      departmentCode: raisers.get(item.invoiceId)?.departmentCode ?? null,
      raisedBy: raisers.get(item.invoiceId)?.createdBy ?? null,
      dueDate: item.dueDate,
      daysLate: item.daysOverdue,
    },
  }));
};

/** The system operator as the producers read: the whole company, whether the operator holds the super-user flag or only the administrator's role. */
export async function operatorPrincipal(tx: Tx, userId: string): Promise<Principal> {
  return { ...(await authz.loadPrincipal(tx, userId)), isSuperUser: true };
}

/** The producers, by event. Every sweep event of the catalogue has one (`wf01-automation.test.ts` holds it). */
export const PRODUCERS: Readonly<Partial<Record<EventKey, Producer>>> = Object.freeze({
  'task.overdue': taskOverdue,
  'container.eta_exceeded': containerEta,
  'ar_invoice.overdue': invoiceOverdue,
});

/** What one subject says right now, or null when the fact is no longer true (or the producer cannot see it). */
export async function current(tx: Tx, principal: Principal, key: EventKey, subjectId: string, today: string = businessToday()): Promise<Payload | null> {
  const producer = PRODUCERS[key];
  if (!producer) return null;
  const found = (await producer(tx, principal, today)).find((p) => p.subjectId === subjectId);
  return found?.payload ?? null;
}

export interface ProduceResult {
  readonly event: EventKey;
  readonly listening: boolean;
  readonly read: number;
  readonly recorded: number;
  /** A payload that did not fit its event: a producer bug, said aloud. */
  readonly problems: string[];
}

/**
 * Records today's sweep events. An event nobody is listening for is not even
 * read. Running it twice in a day records nothing the first did not (the
 * outbox's key is event + record + business day).
 */
export async function produce(tx: Tx, principal: Principal, today: string = businessToday(), only?: readonly EventKey[]): Promise<ProduceResult[]> {
  const results: ProduceResult[] = [];
  for (const key of Object.keys(PRODUCERS) as EventKey[]) {
    if (only && !only.includes(key)) continue;
    if (EVENTS[key].source !== 'sweep') continue;
    if (!(await dispatcher.listening(tx, key))) {
      results.push({ event: key, listening: false, read: 0, recorded: 0, problems: [] });
      continue;
    }
    const found = await PRODUCERS[key]!(tx, principal, today);
    let recorded = 0;
    const problems: string[] = [];
    for (const item of found) {
      const written = await dispatcher.dispatch(tx, key, item.payload, { window: sweepWindow(today) });
      if (written.recorded) recorded += 1;
      if (written.problem) problems.push(`${String(item.payload.reference)}: ${written.problem}`);
    }
    results.push({ event: key, listening: true, read: found.length, recorded, problems });
  }
  return results;
}
