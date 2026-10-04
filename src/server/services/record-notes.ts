/**
 * Notes on any record — one way, kept in the audit trail (2026-10-04).
 *
 * By direction: every record — every invoice from the moment its draft
 * exists — carries a Notes door beside its paperclip and its clock. Notes had
 * been kept three ways (a table for the purchase invoice, an audit event for
 * the PD, an event log for the import application), and each new record was
 * about to grow a fourth. This is the one way from now on:
 *
 *   A note is an append-only audit event `<object>.note_added` on the record,
 *   `after: { note }` — exactly the shape the PD has written since Stage 4
 *   (`customs_pd.note_added`) and the purchase invoice beside its table
 *   (`ap_invoice.note_added`). No table, no migration: the trail is already
 *   append-only by trigger, already branch-scoped by its row policy, already
 *   read back on every record's clock. A note cannot be edited or removed —
 *   §5.4 holds it, not this file.
 *
 * Who may write one follows the PD's rule: the grant that edits the record's
 * drafts (`edit_draft`) on the record's own permission object, in the
 * record's branch — or, for an object no role edits as a draft (a deposit,
 * a transfer, a master record), the grant that raises or configures it. The
 * table of targets below says which, object by object; a module adds its own
 * with `registerNoteTarget`.
 *
 * Two records already had a note of their own with side effects worth
 * keeping, and they keep them: a PD's note also becomes its `last_note` and a
 * `PD_NOTE` on its import; a purchase invoice's also lands in
 * `ap_invoice_note`, which the Overdue list reads. Their targets hand the
 * write to those services, which write the same audit event.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { can, type PermissionVerb, type Principal } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as customs from './customs-pd';
import * as expenses from './expenses';

/** The longest note the door takes — a paragraph, not a document. */
export const NOTE_MAX_LENGTH = 2000;

/** A note refused, in the sentence the page shows. */
export class RecordNoteError extends Error {
  readonly code = 'RECORD_NOTE';
  constructor(message: string) {
    super(message);
    this.name = 'RecordNoteError';
  }
}

/** One note, as the door lists it. */
export interface RecordNote {
  /** The audit event's id. */
  readonly id: string;
  /** The instant it was written, ISO 8601 (UTC). */
  readonly createdAt: string;
  /** Who wrote it — their display name, or null for a user since removed. */
  readonly author: string | null;
  readonly body: string;
}

/** What a note is on: the audit object type and the id its history is kept under. */
export interface NoteRef {
  /** The audit `object_type` the record's history uses — `ap_invoice`, `customs_pd`, `project_certificate`, … */
  readonly object: string;
  /** The audit `object_id` the record's history uses — its uuid, or its number where its history is kept by number. */
  readonly recordId: string;
}

/** Finds the record under the caller's own scope — null when it does not exist or row security hides it. */
export type NoteTargetFinder = (tx: Tx, recordId: string) => Promise<{ readonly branchCode: string | null } | null>;

export interface NoteTarget {
  /** The permission object whose grant a note asks for. */
  readonly permissionObject: string;
  /** The verb asked — `edit_draft` unless no role edits this object as a draft. */
  readonly verb: PermissionVerb;
  readonly find: NoteTargetFinder;
  /**
   * Writes the note instead of the plain audit event, for a record whose
   * note already did more than that. It must write the same
   * `<object>.note_added` event, `after: { note }`, or the door will not
   * list what it wrote.
   */
  readonly write?: (tx: Tx, ctx: ActorContext, recordId: string, body: string) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A record in one table: the column its history is kept under, and the
 * column naming its branch (null for a master record, whose note is written
 * in the writer's branch, as its other events are).
 */
function inTable(table: string, key: string, branch: string | null): NoteTargetFinder {
  const keyIsUuid = key === 'id';
  return async (tx, recordId) => {
    if (keyIsUuid && !UUID.test(recordId)) return null;
    const branchColumn = branch ? sql`${sql.identifier(branch)}::text` : sql`null::text`;
    const result = await tx.execute(
      sql`select ${branchColumn} as branch_code from ${sql.identifier(table)} where ${sql.identifier(key)} = ${recordId} limit 1`,
    );
    const row = result.rows[0] as { branch_code: string | null } | undefined;
    return row ? { branchCode: row.branch_code } : null;
  };
}

/** A project document kept by number, whose branch is its project's. */
function inProjectDocument(table: string, key: string): NoteTargetFinder {
  return async (tx, recordId) => {
    const result = await tx.execute(
      sql`select p.branch_code::text as branch_code
            from ${sql.identifier(table)} d
            join project p on p.code = d.project_code
           where d.${sql.identifier(key)} = ${recordId}
           limit 1`,
    );
    const row = result.rows[0] as { branch_code: string | null } | undefined;
    return row ? { branchCode: row.branch_code } : null;
  };
}

/** The first of several tables to hold the record — one audit object, two tables. */
function inEither(...finders: NoteTargetFinder[]): NoteTargetFinder {
  return async (tx, recordId) => {
    for (const find of finders) {
      const found = await find(tx, recordId);
      if (found) return found;
    }
    return null;
  };
}

const target = (permissionObject: string, verb: PermissionVerb, find: NoteTargetFinder, write?: NoteTarget['write']): NoteTarget =>
  write ? { permissionObject, verb, find, write } : { permissionObject, verb, find };

/**
 * Every record that keeps notes, by the audit object its history is kept
 * under. The key column is the one `RecordHistory` is given for that record.
 */
const TARGETS = new Map<string, NoteTarget>([
  // Purchasing and payables.
  ['ap_invoice', target('ap_invoice', 'view', inTable('ap_invoice', 'id', 'branch_code'), (tx, ctx, id, body) => expenses.addNote(tx, ctx, id, body))],
  ['supplier_payment', target('supplier_payment', 'edit_draft', inTable('supplier_payment', 'id', 'branch_code'))],
  ['supplier_advance', target('supplier_advance', 'edit_draft', inTable('supplier_advance', 'id', 'branch_code'))],
  ['supplier_credit_memo', target('supplier_credit_memo', 'create', inTable('supplier_credit_memo', 'id', 'branch_code'))],
  ['goods_return', target('goods_return', 'edit_draft', inTable('goods_return', 'id', 'branch_code'))],
  ['purchase_order', target('purchase_order', 'edit_draft', inTable('purchase_order', 'id', 'branch_code'))],
  ['goods_receipt', target('goods_receipt', 'edit_draft', inTable('goods_receipt', 'id', 'branch_code'))],
  ['service_receipt', target('service_receipt', 'edit_draft', inTable('service_receipt', 'id', 'branch_code'))],
  ['recurring_contract', target('recurring_contract', 'edit_draft', inTable('recurring_contract', 'id', 'branch_code'))],
  ['payment_application', target('payment_application', 'edit_draft', inTable('payment_application', 'id', 'branch_code'))],
  ['payment_batch', target('payment_batch', 'create', inTable('payment_batch', 'id', 'branch_code'))],
  // Sales and receivables.
  ['ar_invoice', target('ar_invoice', 'edit_draft', inTable('ar_invoice', 'id', 'branch_code'))],
  ['customer_receipt', target('customer_receipt', 'edit_draft', inTable('customer_receipt', 'id', 'branch_code'))],
  ['customer_credit_memo', target('customer_credit_memo', 'edit_draft', inTable('customer_credit_memo', 'id', 'branch_code'))],
  ['sales_return', target('sales_return', 'edit_draft', inTable('sales_return', 'id', 'branch_code'))],
  ['sales_order', target('sales_order', 'edit_draft', inTable('sales_order', 'id', 'branch_code'))],
  ['delivery_note', target('delivery_note', 'edit_draft', inTable('delivery_note', 'id', 'branch_code'))],
  ['ar_write_off', target('ar_write_off', 'edit_draft', inTable('ar_write_off', 'id', 'branch_code'))],
  // Accounting and treasury.
  ['journal_entry', target('journal_entry', 'edit_draft', inTable('journal_entry', 'id', 'branch_code'))],
  ['bank_loan', target('bank_loan', 'edit_draft', inTable('bank_loan', 'id', 'branch_code'))],
  // A deposit is a bank transfer (cash) or an other receipt (bank); each asks the grant its own screen asks.
  ['bank_transfer', target('bank_cash_account', 'create', inTable('bank_transfer', 'id', 'branch_code'))],
  ['other_receipt', target('other_receipt', 'create', inTable('other_receipt', 'id', 'branch_code'))],
  ['bank_reconciliation', target('bank_reconciliation', 'edit_draft', inTable('bank_reconciliation', 'id', 'branch_code'))],
  // REQ-ACC-001 — the statement is the reconciliation's record from its draft; a recurring journal is
  // a journal's; a tax code and a period are master records, written in the writer's branch.
  ['bank_statement', target('bank_statement', 'create', inTable('bank_statement', 'id', 'branch_code'))],
  ['recurring_journal', target('journal_entry', 'edit_draft', inTable('recurring_journal', 'id', 'branch_code'))],
  ['tax_code', target('tax_code', 'configure', inTable('tax_code', 'code', null))],
  ['fiscal_period', target('fiscal_period', 'configure', inTable('fiscal_period', 'id', null))],
  ['cash_advance', target('cash_advance', 'create', inTable('cash_advance', 'id', 'branch_code'))],
  // Logistics and customs.
  ['customs_pd', target('customs_pd', 'edit_draft', inTable('customs_pd', 'id', 'branch_code'), (tx, ctx, id, body) => customs.addNote(tx, ctx, id, body))],
  ['asycuda_run', target('customs_pd', 'edit_draft', inTable('asycuda_run', 'id', null))],
  ['bill_of_lading', target('bill_of_lading', 'edit_draft', inTable('bill_of_lading', 'id', 'branch_code'))],
  ['shipment_container', target('shipment_container', 'edit_draft', inTable('shipment_container', 'id', 'branch_code'))],
  // Inventory. A transfer's events are `warehouse_transfer` whichever table holds it.
  ['warehouse_transfer', target('warehouse_transfer', 'create', inEither(inTable('stock_transfer', 'id', 'branch_code'), inTable('warehouse_transfer', 'id', 'branch_code')))],
  ['stock_reconciliation', target('stock_reconciliation', 'create', inTable('stock_adjustment', 'id', 'branch_code'))],
  ['opening_stock', target('opening_stock', 'edit_draft', inTable('opening_stock', 'id', 'branch_code'))],
  ['stock_count', target('stock_count', 'create', inTable('stock_count', 'id', 'branch_code'))],
  // The Project System — its documents are kept by number.
  ['project', target('project', 'edit_draft', inTable('project', 'code', 'branch_code'))],
  ['project_certificate', target('project', 'edit_draft', inTable('project_certificate', 'certificate_no', 'branch_code'))],
  ['project_budget', target('project', 'edit_draft', inProjectDocument('project_budget_document', 'document_no'))],
  ['project_variation', target('project', 'edit_draft', inProjectDocument('project_variation', 'variation_no'))],
  ['project_material_issue', target('project', 'edit_draft', inTable('project_material_issue', 'document_no', 'branch_code'))],
  // HR — kept by number.
  ['employee', target('employee', 'edit_draft', inTable('employee', 'employee_no', 'branch_code'))],
  ['leave_request', target('leave_request', 'edit_draft', inTable('leave_request', 'request_no', 'branch_code'))],
  ['employee_advance', target('employee_advance', 'edit_draft', inTable('employee_advance', 'advance_no', 'branch_code'))],
  ['payroll_run', target('payroll_run', 'edit_draft', inTable('payroll_run', 'run_no', 'branch_code'))],
  ['performance_review', target('performance_review', 'edit_draft', inTable('performance_review', 'review_no', 'branch_code'))],
  ['employee_request', target('employee_request', 'edit_draft', inTable('employee_request', 'request_no', 'branch_code'))],
  ['employee_document', target('employee_document', 'edit_draft', inTable('employee_document', 'document_no', 'branch_code'))],
  ['vacancy', target('recruitment', 'edit_draft', inTable('vacancy', 'vacancy_no', 'branch_code'))],
  ['applicant', target('recruitment', 'edit_draft', inTable('applicant', 'applicant_no', 'branch_code'))],
  // Master records — a party's or an account's profile. No branch of their own.
  ['business_partner', target('business_partner', 'edit_draft', inTable('business_partner', 'id', null))],
  ['item', target('item', 'configure', inTable('item', 'code', null))],
  ['warehouse', target('warehouse', 'configure', inTable('warehouse', 'code', 'branch_code'))],
  ['bank', target('bank', 'configure', inTable('bank', 'code', null))],
  ['bank_account', target('bank_account', 'configure', inTable('bank_cash_account', 'code', null))],
  ['chart_of_account', target('chart_of_account', 'edit_draft', inTable('chart_of_account', 'id', null))],
]);

/** A module's own record joins the door. Additive: an existing object is never replaced. */
export function registerNoteTarget(object: string, entry: NoteTarget): void {
  if (!TARGETS.has(object)) TARGETS.set(object, entry);
}

/** The audit objects that keep notes. */
export function noteObjects(): readonly string[] {
  return [...TARGETS.keys()];
}

/** The target a note on this object asks for, or null when the object keeps none. */
export function noteTargetOf(object: string): NoteTarget | null {
  return TARGETS.get(object) ?? null;
}

/** May this person add a note on this kind of record? The door shows its box only when so. */
export function mayAddNote(principal: Principal, object: string): boolean {
  const entry = TARGETS.get(object);
  return Boolean(entry && can(principal, entry.verb, entry.permissionObject));
}

/** The action a note on this object is recorded as. */
export const noteAction = (object: string): string => `${object}.note_added`;

/**
 * Adds a note to a record — dated, signed, never edited.
 *
 * Trimmed; refused when it says nothing or runs past `NOTE_MAX_LENGTH`;
 * refused on an object that keeps no notes, on a record the caller cannot
 * see, and without the target's grant in the record's branch (the refusal is
 * written, as every refusal is).
 */
export async function addNote(tx: Tx, ctx: ActorContext, input: NoteRef & { readonly body: string }): Promise<void> {
  const entry = TARGETS.get(input.object);
  if (!entry) throw new RecordNoteError('Notes are not kept on this kind of record.');
  const body = (input.body ?? '').trim();
  if (!body) throw new RecordNoteError('A note says something. Write what is happening with this record.');
  if (body.length > NOTE_MAX_LENGTH) {
    throw new RecordNoteError(`A note is at most ${NOTE_MAX_LENGTH.toLocaleString('en')} characters. Attach a longer text as a file.`);
  }
  const recordId = (input.recordId ?? '').trim();
  const found = recordId ? await entry.find(tx, recordId) : null;
  if (!found) throw new RecordNoteError('No such record — it may be outside your branches.');
  const branchCode = found.branchCode ?? ctx.branchCode;

  await authz.authorize(ctx.principal, entry.verb, entry.permissionObject, {
    branchCode,
    objectId: recordId,
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });

  if (entry.write) {
    await entry.write(tx, ctx, recordId, body);
    return;
  }
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: noteAction(input.object),
    objectType: input.object,
    objectId: recordId,
    branchCode,
    after: { note: body },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/**
 * A record's notes, newest first, with who wrote them.
 *
 * Read from the trail under the caller's own scope (the audit row policy
 * decides which branches' notes they see), so every `<object>.note_added`
 * ever written — the PD's and the purchase invoice's from before this
 * service, too — is listed as it was written.
 */
export async function listNotes(tx: Tx, ref: NoteRef): Promise<RecordNote[]> {
  const result = await tx.execute(sql`
    select e.id::text as id,
           e.occurred_at as occurred_at,
           u.display_name as author,
           e.after_value->>'note' as body
      from audit_event e
      left join app_user u on u.id = e.actor_user_id
     where e.object_type = ${ref.object}
       and e.object_id = ${ref.recordId}
       and e.action = ${noteAction(ref.object)}
       and e.outcome = 'success'
     order by e.occurred_at desc, e.id desc
  `);
  return (result.rows as Array<{ id: string; occurred_at: Date | string; author: string | null; body: string | null }>).map(
    (row) => ({
      id: row.id,
      createdAt: new Date(row.occurred_at).toISOString(),
      author: row.author,
      body: row.body ?? '',
    }),
  );
}
