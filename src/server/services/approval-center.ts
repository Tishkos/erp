/**
 * My Approvals — what is waiting on this person, and the decision from the
 * list. Platform phase, Agent 2.
 *
 * **There is no new approval engine here.** Three things are read, and one is
 * done:
 *
 * * the workflow engine's own inbox (`approvals.inbox`) — journals, chart
 *   accounts, supplier bank details — narrowed to the rows the person could
 *   really decide (`domain/approval-center.mayActOnStep`: the step's role or
 *   managed department, and never the person who submitted);
 * * the documents that wait in `submitted` for an `approve` grant (purchase
 *   orders, payment applications, purchase invoices to post), each narrowed by
 *   the same four-eyes rule its own service enforces;
 * * the HR sections' and the Payables departments' own `waitingFor` feeds,
 *   which already say "waiting on this reader".
 *
 * The decision is made by the service that owns the document, called exactly as
 * its own page calls it: `journal.approve` / `reject`, `chart-of-accounts` via
 * `approvals.decide`, `business-partner.approveBankAccount` /
 * `returnBankAccount`. A document type with no entry in `HANDLERS` has no inline
 * decision: its row opens the real document, where its own button lives.
 * Nothing is recorded here, so there is nothing here to fake: the screen says
 * "Saved" only when the owning service returned.
 *
 * Every read runs as the viewer, in their scope: row security and the branch
 * rule apply to every source.
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessPartner, chartOfAccount, journalEntry, partnerBankAccount } from '../db/schema';
import {
  APPROVAL_PAGE_SIZE,
  filterItems,
  mayActOnStep,
  mayApproveSubmitted,
  pageOf,
  sortItems,
  typesOf,
  type ApprovalFilter,
  type ApprovalItem,
  type ApprovalPage,
} from '../domain/approval-center';
import { can, type Principal } from '../domain/permissions';
import * as bankDetails from './business-partner';
import * as accounts from './chart-of-accounts';
import * as employeeAdvances from './employee-advances';
import * as employeeRequests from './employee-requests';
import * as journal from './journal';
import * as leave from './leave';
import * as payroll from './payroll';
import * as performance from './performance';
import * as recruitment from './recruitment';
import * as approvals from './approvals';
import { safeRead } from './safe-read';

export type { ApprovalItem, ApprovalPage };

export interface CenterContext {
  readonly principal: Principal;
  readonly branchCode: string;
  readonly requestId?: string | null;
  readonly clientIp?: string | null;
}

// ---------------------------------------------------------------------------
// The engine's types: how to name one and how to decide it
// ---------------------------------------------------------------------------

interface Resolved {
  readonly no: string;
  readonly href: string | null;
  readonly amount: { readonly value: string; readonly currency: string } | null;
  /** What the owning service is called with. */
  readonly decideId: string;
}

interface WorkflowHandler {
  /** The grant the owning service authorises the decision on. */
  readonly object: string;
  resolve(tx: Tx, documentId: string): Promise<Resolved | null>;
  approve(tx: Tx, ctx: CenterContext, decideId: string): Promise<void>;
  reject(tx: Tx, ctx: CenterContext, decideId: string, reason: string): Promise<void>;
}

const HANDLERS: Readonly<Record<string, WorkflowHandler>> = {
  chart_of_account: {
    object: accounts.PERMISSION_OBJECT,
    async resolve(tx, documentId) {
      const [row] = await tx
        .select({ code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(eq(chartOfAccount.id, documentId))
        .limit(1);
      return row ? { no: `${row.code} — ${row.name}`, href: `/master-data/chart-of-accounts/${encodeURIComponent(row.code)}`, amount: null, decideId: row.code } : null;
    },
    // The inbox's own path since Phase 0: the record framework's action, which runs the account's maker-checker.
    approve: (tx, ctx, decideId) =>
      approvals.decide(tx, ctx.principal, { documentTypeCode: 'chart_of_account', documentId: decideId, decision: 'approve', branchCode: ctx.branchCode }).then(() => undefined),
    reject: (tx, ctx, decideId, reason) =>
      approvals.decide(tx, ctx.principal, { documentTypeCode: 'chart_of_account', documentId: decideId, decision: 'reject', reason, branchCode: ctx.branchCode }).then(() => undefined),
  },
  journal_entry: {
    object: journal.PERMISSION_OBJECT,
    async resolve(tx, documentId) {
      const [row] = await tx
        .select({ no: journalEntry.entryNo, debit: sql<string>`${journalEntry.totalDebitIqd}::text` })
        .from(journalEntry)
        .where(eq(journalEntry.id, documentId))
        .limit(1);
      return row ? { no: row.no, href: `/finance/journals/${encodeURIComponent(row.no)}`, amount: { value: row.debit, currency: 'IQD' }, decideId: documentId } : null;
    },
    approve: (tx, ctx, decideId) => journal.approve(tx, ctx, decideId),
    reject: (tx, ctx, decideId, reason) => journal.reject(tx, ctx, decideId, reason),
  },
  partner_bank_account: {
    object: bankDetails.PERMISSION_OBJECT,
    async resolve(tx, documentId) {
      const [row] = await tx
        .select({
          code: businessPartner.code,
          isSupplier: businessPartner.isSupplier,
          bank: partnerBankAccount.bankName,
        })
        .from(partnerBankAccount)
        .innerJoin(businessPartner, eq(businessPartner.id, partnerBankAccount.partnerId))
        .where(eq(partnerBankAccount.id, documentId))
        .limit(1);
      if (!row) return null;
      const role = row.isSupplier ? 'supplier' : 'customer';
      const list = role === 'supplier' ? '/payables/suppliers' : '/sales/customers';
      return {
        no: `${row.code} · ${row.bank}`,
        href: `${list}/${encodeURIComponent(row.code)}?role=${role}&account=${encodeURIComponent(documentId)}#bank-account`,
        amount: null,
        decideId: documentId,
      };
    },
    approve: (tx, ctx, decideId) => bankDetails.approveBankAccount(tx, ctx, decideId),
    reject: (tx, ctx, decideId, reason) => bankDetails.returnBankAccount(tx, ctx, decideId, reason),
  },
};

/** The document types that can be decided from the list. */
export const INLINE_TYPES: readonly string[] = Object.keys(HANDLERS);

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const iso = (value: unknown): string | null => (value ? new Date(value as string | Date).toISOString() : null);

async function workflowItems(tx: Tx, principal: Principal): Promise<{ items: ApprovalItem[]; unroutable: number }> {
  if (!can(principal, 'view', approvals.PERMISSION_OBJECT)) return { items: [], unroutable: 0 };
  const items: ApprovalItem[] = [];
  let unroutable = 0;
  for (const row of (await approvals.inbox(tx, principal)).slice(0, 200)) {
    const kind = row.approverKind === 'role' || row.approverKind === 'department_manager' ? row.approverKind : null;
    const actionable = mayActOnStep(
      {
        approverKind: kind,
        approverRole: row.approverRole,
        allowSelfApproval: row.allowSelfApproval ?? false,
        submittedBy: row.submittedBy,
        departmentCode: row.departmentCode,
      },
      principal,
    );
    if (!actionable) continue;
    const handler = HANDLERS[row.documentTypeCode];
    // The grant the owning service decides on: a row the button would refuse is not a row to show.
    if (!handler || !can(principal, 'approve', handler.object)) {
      unroutable += handler ? 0 : 1;
      continue;
    }
    const resolved = await handler.resolve(tx, row.documentId);
    if (!resolved) continue;
    items.push({
      id: `workflow:${row.instanceId}`,
      source: 'workflow',
      documentType: row.documentTypeCode,
      documentNo: resolved.no,
      href: resolved.href,
      requester: row.submittedByName,
      since: iso(row.submittedAt),
      amount: resolved.amount,
      stage: kind === 'role' ? `role:${row.approverRole}` : 'department_manager',
      action: 'approve',
      inline: { documentType: row.documentTypeCode, documentId: resolved.decideId },
    });
  }
  return { items, unroutable };
}

type Row = Record<string, unknown>;

async function purchaseOrders(tx: Tx, principal: Principal): Promise<ApprovalItem[]> {
  if (!can(principal, 'approve', 'purchase_order')) return [];
  const rows = (
    await tx.execute(sql`
      select o.id, o.order_no as "no", o.currency, o.created_by as "createdBy", o.updated_at as "since", u.display_name as "requester",
             (select round(sum(l.quantity * l.unit_price), 4)::text from purchase_order_line l where l.purchase_order_id = o.id) as "total"
        from purchase_order o
        left join app_user u on u.id = o.created_by
       where o.status = 'submitted'
       order by o.updated_at
       limit 100`)
  ).rows as Row[];
  return rows
    .filter((row) => mayApproveSubmitted(principal, (row.createdBy as string | null) ?? null, true))
    .map((row) => ({
      id: `purchase_order:${row.id as string}`,
      source: 'purchase_order' as const,
      documentType: 'purchase_order',
      documentNo: row.no as string,
      href: `/payables/purchase-orders/${encodeURIComponent(row.no as string)}`,
      requester: (row.requester as string | null) ?? null,
      since: iso(row.since),
      amount: row.total ? { value: row.total as string, currency: row.currency as string } : null,
      stage: 'submitted',
      action: 'approve' as const,
      inline: null,
    }));
}

async function paymentApplications(tx: Tx, principal: Principal): Promise<ApprovalItem[]> {
  if (!can(principal, 'approve', 'payment_application')) return [];
  const rows = (
    await tx.execute(sql`
      select a.id, a.application_no as "no", a.currency, a.amount_txn::text as "amount", a.created_by as "createdBy",
             a.created_at as "since", u.display_name as "requester"
        from payment_application a
        left join app_user u on u.id = a.created_by
       where a.status = 'draft'
       order by a.created_at
       limit 100`)
  ).rows as Row[];
  return rows
    .filter((row) => mayApproveSubmitted(principal, (row.createdBy as string | null) ?? null, true))
    .map((row) => ({
      id: `payment_application:${row.id as string}`,
      source: 'payment_application' as const,
      documentType: 'payment_application',
      documentNo: row.no as string,
      href: `/payables/payment-applications/${encodeURIComponent(row.no as string)}`,
      requester: (row.requester as string | null) ?? null,
      since: iso(row.since),
      amount: { value: row.amount as string, currency: row.currency as string },
      stage: 'draft',
      action: 'approve' as const,
      inline: null,
    }));
}

async function purchaseInvoices(tx: Tx, principal: Principal): Promise<ApprovalItem[]> {
  // Posting a purchase invoice is its approval: both grants, as `ap-invoice.post` asks.
  if (!can(principal, 'approve', 'ap_invoice') || !can(principal, 'post', 'ap_invoice')) return [];
  // total_iqd is written at posting, so on a submitted invoice it is zero: until then the figure is summed from the
  // lines, exactly as ap-invoice.list does for the register (the amount here must be the register's).
  const rows = (
    await tx.execute(sql`
      select i.id, i.invoice_no as "no", i.updated_at as "since", u.display_name as "requester",
             case when i.total_iqd <> 0 then i.total_iqd::text
                  else coalesce((select sum(l.quantity * l.unit_price - l.discount_iqd) from ap_invoice_line l where l.ap_invoice_id = i.id), 0)::text
             end as "amount"
        from ap_invoice i
        left join app_user u on u.id = coalesce(i.submitted_by, i.created_by)
       where i.status = 'submitted' and i.reversed_at is null
       order by i.updated_at
       limit 100`)
  ).rows as Row[];
  return rows.map((row) => ({
    id: `ap_invoice:${row.id as string}`,
    source: 'ap_invoice' as const,
    documentType: 'ap_invoice',
    documentNo: row.no as string,
    href: `/payables/invoices/${encodeURIComponent(row.no as string)}`,
    requester: (row.requester as string | null) ?? null,
    since: iso(row.since),
    amount: { value: row.amount as string, currency: 'IQD' },
    stage: 'submitted',
    action: 'post' as const,
    inline: null,
  }));
}

/**
 * Service confirmations waiting for the person's department — the Payables
 * departments' inbox (REQ-PAY-001 §21.13), asked the way `dashboard.waitingFor`
 * asks it: a manager of the accounts sees every department's, anyone else their
 * own.
 */
async function serviceReceipts(tx: Tx, principal: Principal): Promise<ApprovalItem[]> {
  if (!can(principal, 'view', 'service_receipt')) return [];
  const isManager = principal.roleCodes.includes('accounting_manager') || principal.isSuperUser;
  const mine = principal.departments.map((d) => d.code);
  if (!isManager && mine.length === 0) return [];
  const rows = (
    await tx.execute(sql`
      select r.id, r.receipt_no as "no", r.service_date::text as "serviceDate"
        from service_receipt r
       where r.status = 'submitted'
         and ${isManager ? sql`true` : sql`r.department_code in (${sql.join(mine.map((code) => sql`${code}`), sql`, `)})`}
       order by r.service_date
       limit 50`)
  ).rows as Row[];
  return rows.map((row) => ({
    id: `service_receipt:${row.id as string}`,
    source: 'service_receipt' as const,
    documentType: 'service_receipt',
    documentNo: row.no as string,
    href: `/payables/service-receipts?q=${encodeURIComponent(row.no as string)}`,
    requester: null,
    since: iso(`${row.serviceDate as string}T00:00:00Z`),
    amount: null,
    stage: 'submitted',
    action: 'confirm' as const,
    inline: null,
  }));
}

async function hrItems(tx: Tx, ctx: CenterContext): Promise<ApprovalItem[]> {
  const reader = { principal: ctx.principal, branchCode: ctx.branchCode };
  const out: ApprovalItem[] = [];
  for (const row of await leave.waitingFor(tx, { principal: ctx.principal, branchCode: ctx.branchCode })) {
    out.push({
      id: `leave:${row.requestNo}`,
      source: 'leave',
      documentType: 'leave_request',
      documentNo: row.requestNo,
      href: `/hr/leave/${encodeURIComponent(row.requestNo)}`,
      requester: row.fullNameEn,
      since: iso(row.submittedAt),
      amount: null,
      stage: 'submitted',
      action: 'decide',
      inline: null,
    });
  }
  for (const row of await payroll.waitingFor(tx, { principal: ctx.principal })) {
    out.push({
      id: `payroll:${row.runNo}`,
      source: 'payroll',
      documentType: 'payroll_run',
      documentNo: row.runNo,
      href: `/hr/payroll/${encodeURIComponent(row.runNo)}`,
      requester: null,
      since: null,
      amount: { value: row.netIqd, currency: 'IQD' },
      stage: row.status,
      action: row.action,
      inline: null,
    });
  }
  for (const row of await employeeAdvances.waitingFor(tx, { principal: ctx.principal })) {
    out.push({
      id: `advance:${row.advanceNo}`,
      source: 'advance',
      documentType: 'employee_advance',
      documentNo: row.advanceNo,
      href: `/hr/advances/${encodeURIComponent(row.advanceNo)}`,
      requester: row.fullNameEn,
      since: null,
      amount: { value: row.amountIqd, currency: 'IQD' },
      stage: 'submitted',
      action: row.action === 'endorse' ? 'endorse' : row.action === 'pay' ? 'pay' : 'approve',
      inline: null,
    });
  }
  for (const row of await performance.waitingFor(tx, reader)) {
    out.push({
      id: `review:${row.reviewNo}`,
      source: 'review',
      documentType: 'performance_review',
      documentNo: row.reviewNo,
      href: `/hr/performance/${encodeURIComponent(row.reviewNo)}`,
      requester: row.fullNameEn,
      since: null,
      amount: null,
      stage: 'submitted',
      action: row.action === 'rate' ? 'rate' : row.action === 'sign_off' ? 'sign_off' : 'read',
      inline: null,
    });
  }
  for (const row of await recruitment.waitingFor(tx, { principal: ctx.principal })) {
    out.push({
      id: `hire:${row.applicantNo}`,
      source: 'hire',
      documentType: 'applicant',
      documentNo: row.applicantNo,
      href: `/hr/recruitment/applicants/${encodeURIComponent(row.applicantNo)}`,
      requester: row.fullNameEn,
      since: null,
      amount: null,
      stage: 'offer',
      action: 'hire',
      inline: null,
    });
  }
  for (const row of await employeeRequests.waitingFor(tx, reader)) {
    out.push({
      id: `request:${row.requestNo}`,
      source: 'request',
      documentType: 'employee_request',
      documentNo: row.requestNo,
      href: `/hr/requests/${encodeURIComponent(row.requestNo)}`,
      requester: row.fullNameEn,
      since: null,
      amount: row.kind === 'expense_claim' ? { value: row.amountIqd, currency: 'IQD' } : null,
      stage: 'submitted',
      action: row.action === 'pay' ? 'reimburse' : row.action === 'issue' ? 'issue' : 'decide',
      inline: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface CenterItems {
  readonly items: readonly ApprovalItem[];
  /** Engine rows the person could decide that have no screen to decide them on here. */
  readonly unroutable: number;
  /** Sources that could not be read this time (named, logged). */
  readonly failed: readonly string[];
}

/** Everything waiting on the person that they could act on, oldest first. */
export async function items(tx: Tx, ctx: CenterContext): Promise<CenterItems> {
  const { principal } = ctx;
  const collected: ApprovalItem[] = [];
  const failed: string[] = [];
  let unroutable = 0;

  const run = async <T>(name: string, read: (sp: Tx) => Promise<T>, take: (value: T) => void) => {
    const result = await safeRead(tx, `approvals.${name}`, read);
    if (result.ok) take(result.value);
    else failed.push(name);
  };

  await run('workflow', (sp) => workflowItems(sp, principal), (value) => {
    collected.push(...value.items);
    unroutable = value.unroutable;
  });
  await run('purchase_order', (sp) => purchaseOrders(sp, principal), (value) => collected.push(...value));
  await run('payment_application', (sp) => paymentApplications(sp, principal), (value) => collected.push(...value));
  await run('ap_invoice', (sp) => purchaseInvoices(sp, principal), (value) => collected.push(...value));
  await run('service_receipt', (sp) => serviceReceipts(sp, principal), (value) => collected.push(...value));
  await run('hr', (sp) => hrItems(sp, ctx), (value) => collected.push(...value));

  return { items: sortItems(collected), unroutable, failed };
}

export interface CenterSummary {
  readonly total: number;
  readonly oldest: string | null;
  readonly inline: number;
  readonly failed: readonly string[];
}

export function summaryOf(found: CenterItems): CenterSummary {
  const dated = found.items.map((item) => item.since).filter((since): since is string => since !== null);
  return {
    total: found.items.length,
    oldest: dated.length > 0 ? [...dated].sort()[0]! : null,
    inline: found.items.filter((item) => item.inline !== null).length,
    failed: found.failed,
  };
}

export interface CenterPage extends ApprovalPage {
  readonly types: readonly string[];
  readonly unroutable: number;
  readonly failed: readonly string[];
  /** Before filtering — the figure the counters show. */
  readonly all: number;
}

export async function list(tx: Tx, ctx: CenterContext, filter: ApprovalFilter = {}): Promise<CenterPage> {
  const found = await items(tx, ctx);
  const filtered = filterItems(found.items, filter);
  return {
    ...pageOf(filtered, { ...filter, pageSize: filter.pageSize ?? APPROVAL_PAGE_SIZE }),
    types: typesOf(found.items),
    unroutable: found.unroutable,
    failed: found.failed,
    all: found.items.length,
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export class ApprovalNotRoutableError extends Error {
  readonly code = 'APPROVAL_NOT_ROUTABLE';
  constructor(documentType: string) {
    super(`A ${documentType.replace(/_/g, ' ')} is decided on its own page; open it from the list.`);
    this.name = 'ApprovalNotRoutableError';
  }
}

export class DecisionReasonMissingError extends Error {
  readonly code = 'DECISION_REASON_REQUIRED';
  constructor() {
    super('Say why it is rejected, so the person who raised it knows what to correct.');
    this.name = 'DecisionReasonMissingError';
  }
}

/**
 * Approve or reject one waiting document through the service that owns it.
 * The service decides whether the person may (role, department, four eyes) and
 * refuses in its own words; nothing is recorded here.
 */
export async function decide(
  tx: Tx,
  ctx: CenterContext,
  input: { readonly documentType: string; readonly documentId: string; readonly decision: 'approve' | 'reject'; readonly reason?: string | null },
): Promise<void> {
  const handler = HANDLERS[input.documentType];
  if (!handler) throw new ApprovalNotRoutableError(input.documentType);
  if (input.decision === 'reject') {
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new DecisionReasonMissingError();
    await handler.reject(tx, ctx, input.documentId, reason);
    return;
  }
  await handler.approve(tx, ctx, input.documentId);
}
