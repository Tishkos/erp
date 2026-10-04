/**
 * My Approvals — the rules, pure. Platform phase, Agent 2.
 *
 * The approval center is a *list of what is waiting on this person*, drawn
 * from the places the system already holds a waiting decision: the workflow
 * engine's instances, the documents that wait in `submitted` for an `approve`
 * grant, and the HR sections' own `waitingFor` feeds. It is not an approval
 * engine and decides nothing — every decision is made by the service that owns
 * the document, with its own four-eyes rule. This file holds only the two
 * things the list itself needs to be honest:
 *
 * * **Actionable, not merely addressed.** The engine's inbox lists everything
 *   routed to a person or to a role they hold, including what they raised
 *   themselves — which then refuses them. `mayActOnStep` asks the same
 *   questions `workflow.assertCanApprove` asks (the role or the managed
 *   department, and not the person who submitted), so a row on the list is a
 *   row the button will honour.
 * * **A shape every source fits**, so the register can be one table with one
 *   filter row whatever the document is.
 *
 * No database, no clock.
 */
import type { Principal } from './permissions';

export const APPROVAL_SOURCES = [
  'workflow',
  'purchase_order',
  'payment_application',
  'ap_invoice',
  'service_receipt',
  'leave',
  'payroll',
  'advance',
  'review',
  'hire',
  'request',
] as const;
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

/** What the viewer is being asked to do (`admin.approvals.action_<x>`). */
export type ApprovalAction =
  | 'approve'
  | 'post'
  | 'confirm'
  | 'endorse'
  | 'decide'
  | 'pay'
  | 'rate'
  | 'sign_off'
  | 'read'
  | 'issue'
  | 'hire'
  | 'reimburse';

export interface ApprovalItem {
  /** Unique across sources. */
  readonly id: string;
  readonly source: ApprovalSource;
  /** `admin.approvals.type_<documentType>` names it. */
  readonly documentType: string;
  /** The number a person knows the document by. */
  readonly documentNo: string;
  /** The real document. Null only when the viewer has no screen for it. */
  readonly href: string | null;
  readonly requester: string | null;
  /** ISO instant — when it began waiting (or was raised). */
  readonly since: string | null;
  readonly amount: { readonly value: string; readonly currency: string } | null;
  /** Where in its route it stands: `admin.approvals.stage_<x>`. */
  readonly stage: string;
  readonly action: ApprovalAction;
  /**
   * Inline decision, when the owning service can be called from the list: the
   * workflow engine's types. Empty = open the document and decide there.
   */
  readonly inline: { readonly documentType: string; readonly documentId: string } | null;
}

// ── Actionability of a workflow step ────────────────────────────────────────

export interface StepFacts {
  readonly approverKind: 'role' | 'department_manager' | null;
  readonly approverRole: string | null;
  readonly allowSelfApproval: boolean;
  readonly submittedBy: string;
  readonly departmentCode: string | null;
}

/**
 * Whether the person could decide this step right now — `assertCanApprove`'s
 * own test: a department-manager step needs the manager of the document's
 * department; a role step needs the role; and unless the step allows it the
 * person who submitted cannot decide, whoever they are (a super user included).
 */
export function mayActOnStep(step: StepFacts, principal: Principal): boolean {
  if (!principal.isActive) return false;
  if (step.approverKind === null) return false;
  if (!step.allowSelfApproval && step.submittedBy === principal.userId) return false;
  if (step.approverKind === 'department_manager') {
    return step.departmentCode !== null && principal.departments.some((d) => d.code === step.departmentCode && d.isManager);
  }
  return step.approverRole !== null && principal.roleCodes.includes(step.approverRole);
}

/**
 * A document waiting in `submitted` for an `approve` grant: the viewer must
 * hold the verb and must not be the person who raised it — except the single
 * super user, who approves alone by standing direction (2026-10-03).
 */
export function mayApproveSubmitted(
  principal: Principal,
  raisedBy: string | null,
  verbHeld: boolean,
): boolean {
  if (!principal.isActive || !verbHeld) return false;
  return raisedBy === null || raisedBy !== principal.userId || principal.isSuperUser;
}

// ── The list ────────────────────────────────────────────────────────────────

export interface ApprovalFilter {
  readonly q?: string;
  readonly documentType?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export const APPROVAL_PAGE_SIZE = 25;

const haystack = (item: ApprovalItem): string =>
  [item.documentNo, item.documentType, item.requester ?? '', item.stage, item.action].join(' ').toLowerCase();

/** Oldest first — an approval that has waited nine days matters more than one raised this morning. */
export function sortItems(items: readonly ApprovalItem[]): ApprovalItem[] {
  return [...items].sort((a, b) => {
    const x = a.since ?? '9999';
    const y = b.since ?? '9999';
    return x === y ? (a.id < b.id ? -1 : 1) : x < y ? -1 : 1;
  });
}

export function filterItems(items: readonly ApprovalItem[], filter: ApprovalFilter): ApprovalItem[] {
  const needle = (filter.q ?? '').trim().toLowerCase();
  return items.filter(
    (item) =>
      (!filter.documentType || item.documentType === filter.documentType) && (needle === '' || haystack(item).includes(needle)),
  );
}

export interface ApprovalPage {
  readonly rows: readonly ApprovalItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export function pageOf(items: readonly ApprovalItem[], filter: ApprovalFilter): ApprovalPage {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? APPROVAL_PAGE_SIZE));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(filter.page ?? 1) || 1), pages);
  return { rows: items.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages };
}

/** The distinct document types on a list, in the order first met — the filter's options. */
export function typesOf(items: readonly ApprovalItem[]): string[] {
  return [...new Set(items.map((item) => item.documentType))];
}
