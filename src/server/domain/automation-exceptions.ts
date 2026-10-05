/**
 * The finding an automation rule raises in the Exception Center — platform phase, Agent 10.
 *
 * A `create_exception` action does not invent a second place for problems: it
 * raises one finding under one of three detectors of the `automation` family
 * (`EVENTS[key].exceptionDetector`), which the Exception Center lists, sorts,
 * acknowledges and resolves like every other. What the finding says is built
 * here from the event's payload, so the action that raises it and the detector
 * that keeps it true (`services/exception-detectors/automation.ts`) say the
 * same thing in the same words.
 *
 * Pure.
 */
import { EVIDENCE_ROW, type ExceptionFacts, type Finding, type Severity } from './exceptions';
import { EVENTS, type EventKey } from './automation-events';

export interface RaisedBy {
  readonly severity: Severity;
  /** The rule's number: `AUT-001`. */
  readonly ruleNo: string;
  readonly note: string;
  /** For a task: who it is with (the finding's owner). */
  readonly assignee?: { readonly userId: string | null; readonly name: string } | null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const days = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const enc = encodeURIComponent;

/** The detector a sweep event's exception is raised under. */
export function detectorFor(key: EventKey): string | null {
  return EVENTS[key].exceptionDetector ?? null;
}

/** The events that can raise one, by detector. */
export const EXCEPTION_EVENTS: Readonly<Record<string, EventKey>> = Object.freeze(
  Object.fromEntries((Object.values(EVENTS) as { key: EventKey; exceptionDetector?: string }[]).filter((e) => e.exceptionDetector).map((e) => [e.exceptionDetector!, e.key])),
) as Readonly<Record<string, EventKey>>;

/** The finding for one subject of a sweep event; null for an event that raises none. */
export function findingFor(key: EventKey, payload: Readonly<Record<string, unknown>>, by: RaisedBy): Finding | null {
  const detector = detectorFor(key);
  if (!detector) return null;
  const subject = text(payload.subjectId);
  const reference = text(payload.reference);
  const branchCode = text(payload.branchCode) || null;
  const late = days(payload.daysLate);
  const recordHref = EVENTS[key].href(payload);

  if (key === 'container.eta_exceeded') {
    return {
      detector,
      subject,
      severity: by.severity,
      facts: {
        container: reference,
        bl: text(payload.blNo),
        supplier: text(payload.supplierName),
        importNo: text(payload.importNo),
        etaDate: text(payload.etaDate),
        days: late,
        rule: by.ruleNo,
        note: by.note,
      } satisfies ExceptionFacts,
      evidence: [EVIDENCE_ROW({ ref: reference, href: recordHref, date: text(payload.etaDate) || null, note: { code: 'container_eta_passed', params: { days: late } } })],
      record: { type: 'shipment_container', id: subject, label: reference, href: recordHref },
      action: `/logistics/shipment-tracking?q=${enc(reference)}`,
      branchCode,
    };
  }
  if (key === 'task.overdue') {
    const assignee = by.assignee ?? null;
    return {
      detector,
      subject,
      severity: by.severity,
      facts: {
        task: reference,
        taskTitle: text(payload.taskTitle),
        assignee: assignee?.name ?? '',
        priority: text(payload.priority),
        dueDate: text(payload.dueDate),
        days: late,
        rule: by.ruleNo,
        note: by.note,
      } satisfies ExceptionFacts,
      evidence: [EVIDENCE_ROW({ ref: reference, href: recordHref, date: text(payload.dueDate) || null, note: { code: 'task_overdue', params: { days: late } } })],
      record: { type: 'task', id: subject, label: reference, href: recordHref },
      action: recordHref,
      branchCode,
      owner: assignee,
    };
  }
  if (key === 'ar_invoice.overdue') {
    return {
      detector,
      subject,
      severity: by.severity,
      facts: {
        invoice: reference,
        customer: text(payload.customerName),
        customerCode: text(payload.customerCode),
        amountIqd: text(payload.amountIqd),
        dueDate: text(payload.dueDate),
        days: late,
        rule: by.ruleNo,
        note: by.note,
      } satisfies ExceptionFacts,
      evidence: [EVIDENCE_ROW({ ref: reference, href: recordHref, date: text(payload.dueDate) || null, amount: text(payload.amountIqd) || null, note: { code: 'overdue_days', params: { days: late } } })],
      record: { type: 'ar_invoice', id: subject, label: reference, href: recordHref },
      action: recordHref,
      branchCode,
      partyCode: text(payload.customerCode) || null,
    };
  }
  return null;
}
