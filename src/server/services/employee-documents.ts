/**
 * Employee documents — REQ-HR-001 Stage HR-6 (§11a "Documents").
 *
 * A person's papers: the contract, the national ID, the passport, the
 * residence and work permits, certificates and licences, the signed
 * equipment hand-over (B-HR-21). Each is a row (EDOC-{BRANCH}-{SERIAL}) with
 * its reference, its dates and its scan filed as an attachment, so the file
 * sits with the rest of the company's documents (§21: scanned, versioned,
 * never overwritten). A document is never deleted: it is renewed — the new
 * row supersedes the old — or withdrawn with a reason. The morning sweep
 * raises one about to expire, to the HR managers and the person, once per
 * expiry date.
 *
 * Read by HR under its own grant and branch, and by the person themself
 * (`app_is_employee`) — not by everybody in the branch.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employee, employeeDocument } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { HrValidationError, assertDay } from '../domain/hr';
import { DOCUMENT_TYPES, RequestError, daysLeft, expiryState, isDocumentType, type DocumentType } from '../domain/hr-requests';
import { AdminNotFoundError, optionalText, recordChange, requireText } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as hrSettings from './hr-settings';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'employee_document';
const SEQUENCE_KEY = 'EMPLOYEE_DOCUMENT';

type DocumentRow = typeof employeeDocument.$inferSelect;

async function load(tx: Tx, documentNo: string, options: { lock?: boolean } = {}): Promise<DocumentRow> {
  const query = tx.select().from(employeeDocument).where(eq(employeeDocument.documentNo, documentNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('document', documentNo);
  return row;
}

async function personOf(tx: Tx, employeeId: string) {
  const [row] = await tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, fullNameAr: employee.fullNameAr, branchCode: employee.branchCode, appUserId: employee.appUserId })
    .from(employee)
    .where(eq(employee.id, employeeId))
    .limit(1);
  if (!row) throw new HrValidationError('employee', 'names nobody you may see');
  return row;
}

export interface DocumentInput {
  readonly employeeId: string;
  readonly docType: string;
  readonly title?: string | null;
  readonly referenceNo?: string | null;
  readonly issuedOn?: string | null;
  readonly expiresOn?: string | null;
  readonly note?: string | null;
}

function valuesOf(input: Omit<DocumentInput, 'employeeId'>) {
  if (!isDocumentType(input.docType)) throw new HrValidationError('doc_type', `must be one of ${DOCUMENT_TYPES.join(', ')}`);
  const issuedOn = (input.issuedOn ?? '').trim() ? assertDay(input.issuedOn!.trim(), 'issued_on') : null;
  const expiresOn = (input.expiresOn ?? '').trim() ? assertDay(input.expiresOn!.trim(), 'expires_on') : null;
  if (issuedOn && expiresOn && expiresOn < issuedOn) throw new HrValidationError('expires_on', `cannot be before ${issuedOn}`);
  if (issuedOn && issuedOn > businessToday()) throw new HrValidationError('issued_on', `${issuedOn} has not come yet`);
  return {
    docType: input.docType as DocumentType,
    title: requireText((input.title ?? '').trim() || input.docType.replace(/_/g, ' '), 'title', 200),
    referenceNo: optionalText(input.referenceNo, 120),
    issuedOn,
    expiresOn,
    note: optionalText(input.note, 2000),
  };
}

/** A document on file for a person — its scan is attached to it next. */
export async function create(tx: Tx, ctx: ActorContext, input: DocumentInput, replaces: DocumentRow | null = null): Promise<{ id: string; documentNo: string }> {
  const person = await personOf(tx, input.employeeId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: person.branchCode, objectId: person.employeeNo, requestId: ctx.requestId ?? null });
  const values = valuesOf(input);
  const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode: person.branchCode }, ctx.principal.userId);
  const [made] = await tx
    .insert(employeeDocument)
    .values({ documentNo: allocated.documentNo, employeeId: person.id, branchCode: person.branchCode, ...values, replacesId: replaces?.id ?? null, createdBy: ctx.principal.userId })
    .returning({ id: employeeDocument.id });
  await recordChange(tx, ctx, {
    action: 'employee_document.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode: person.branchCode,
    after: { employeeNo: person.employeeNo, ...values, replaces: replaces?.documentNo ?? null },
  });
  return { id: made!.id, documentNo: allocated.documentNo };
}

/** Its details corrected while it is valid — a typo in the reference, a date misread. */
export async function update(tx: Tx, ctx: ActorContext, documentNo: string, input: Omit<DocumentInput, 'employeeId' | 'docType'>): Promise<void> {
  const row = await load(tx, documentNo, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: documentNo, requestId: ctx.requestId ?? null });
  if (row.status !== 'valid') throw new RequestError(`${documentNo} is ${row.status}; it is kept as it was.`);
  const values = valuesOf({ ...input, docType: row.docType });
  await tx
    .update(employeeDocument)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(employeeDocument.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_document.updated',
    objectType: PERMISSION_OBJECT,
    objectId: documentNo,
    branchCode: row.branchCode,
    before: { title: row.title, referenceNo: row.referenceNo, issuedOn: row.issuedOn, expiresOn: row.expiresOn },
    after: { title: values.title, referenceNo: values.referenceNo, issuedOn: values.issuedOn, expiresOn: values.expiresOn },
  });
}

/** Renewed: a new row for the new paper, the old one superseded — both kept. */
export async function renew(tx: Tx, ctx: ActorContext, documentNo: string, input: Omit<DocumentInput, 'employeeId' | 'docType'>): Promise<{ documentNo: string }> {
  const row = await load(tx, documentNo, { lock: true });
  if (row.status !== 'valid') throw new RequestError(`${documentNo} is ${row.status}; only a valid document is renewed.`);
  const made = await create(tx, ctx, { ...input, employeeId: row.employeeId, docType: row.docType, title: (input.title ?? '').trim() || row.title }, row);
  await tx.update(employeeDocument).set({ status: 'superseded', updatedAt: new Date() }).where(eq(employeeDocument.id, row.id));
  await recordChange(tx, ctx, { action: 'employee_document.superseded', objectType: PERMISSION_OBJECT, objectId: documentNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: 'superseded', by: made.documentNo } });
  return { documentNo: made.documentNo };
}

/** Taken off file with the reason — filed in error, returned to its holder. */
export async function withdraw(tx: Tx, ctx: ActorContext, documentNo: string, reason: string): Promise<void> {
  const row = await load(tx, documentNo, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: documentNo, requestId: ctx.requestId ?? null });
  if (row.status !== 'valid') throw new RequestError(`${documentNo} is ${row.status}; it is kept as it was.`);
  const why = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(employeeDocument).set({ status: 'withdrawn', withdrawnBy: ctx.principal.userId, withdrawnAt: now, withdrawReason: why, updatedAt: now }).where(eq(employeeDocument.id, row.id));
  await recordChange(tx, ctx, { action: 'employee_document.withdrawn', objectType: PERMISSION_OBJECT, objectId: documentNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: 'withdrawn' }, reason: why });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Valid documents expiring within the limit (or already expired) — raised once per document per expiry date. */
export async function raiseExpiring(tx: Tx, actorUserId: string, asOf: string): Promise<{ expiring: number; created: number }> {
  const { document_expiry_warning_days: warnDays } = await hrSettings.parameters(tx);
  const horizon = new Date(Date.parse(`${asOf}T00:00:00Z`) + warnDays * 86_400_000).toISOString().slice(0, 10);
  const rows = await tx
    .select({
      documentNo: employeeDocument.documentNo,
      title: employeeDocument.title,
      expiresOn: employeeDocument.expiresOn,
      branchCode: employeeDocument.branchCode,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      appUserId: employee.appUserId,
    })
    .from(employeeDocument)
    .innerJoin(employee, eq(employee.id, employeeDocument.employeeId))
    .where(and(eq(employeeDocument.status, 'valid'), sql`${employeeDocument.expiresOn} <= ${horizon}::date`, sql`${employee.status} <> 'ended'`));
  let created = 0;
  for (const doc of rows) {
    const left = daysLeft(doc.expiresOn!, asOf);
    const raised = await notifications.raise(
      tx,
      { eventType: 'hr.document_expiring', objectType: PERMISSION_OBJECT, objectId: doc.documentNo, occurrence: doc.expiresOn! },
      { documentNo: doc.documentNo, employeeNo: doc.employeeNo, name: doc.fullNameEn, document: doc.title, expiresOn: doc.expiresOn, daysLeft: left },
      { branchCode: doc.branchCode, actorUserId },
    );
    created += raised.created;
    // The person hears of their own paper too.
    if (doc.appUserId) {
      const id = await notifications.insertNotification(tx, {
        ruleCode: null,
        eventType: 'hr.document_expiring',
        objectType: PERMISSION_OBJECT,
        objectId: doc.documentNo,
        recipientUserId: doc.appUserId,
        subject: left < 0 ? `Your ${doc.title} expired on ${doc.expiresOn}` : `Your ${doc.title} expires on ${doc.expiresOn}`,
        body: 'Bring the renewed one to HR.',
        context: { documentNo: doc.documentNo },
        dedupeKey: `hr.document_expiring:${doc.documentNo}:${doc.expiresOn}:self`,
        branchCode: doc.branchCode,
      });
      if (id !== null) created += 1;
    }
  }
  return { expiring: rows.length, created };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface DocumentListFilter extends RegisterPaging {
  /** 'expiring', 'expired', 'valid', 'superseded', 'withdrawn' or all. */
  readonly view?: string | null;
  readonly docType?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: DocumentListFilter) {
  const today = businessToday();
  const { document_expiry_warning_days: warnDays } = await hrSettings.parameters(tx);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + warnDays * 86_400_000).toISOString().slice(0, 10);
  const view = filter.view ?? '';
  const where = whereOf([
    view === 'expiring' ? sql`d.status = 'valid' and d.expires_on >= ${today}::date and d.expires_on <= ${horizon}::date` : null,
    view === 'expired' ? sql`d.status = 'valid' and d.expires_on < ${today}::date` : null,
    ['valid', 'superseded', 'withdrawn'].includes(view) ? sql`d.status = ${view}` : null,
    filter.docType && isDocumentType(filter.docType) ? sql`d.doc_type = ${filter.docType}` : null,
    searchOf([sql`d.document_no`, sql`d.title`, sql`d.reference_no`, sql`e.employee_no`, sql`e.full_name_en`, sql`e.full_name_ar`], filter.search),
  ]);
  const from = sql`from employee_document d join employee e on e.id = d.employee_id ${where}`;
  const page = await registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select d.id, d.document_no as "documentNo", d.doc_type as "docType", d.title, d.reference_no as "referenceNo", d.status,
                 d.issued_on::text as "issuedOn", d.expires_on::text as "expiresOn",
                 e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", e.full_name_ar as "fullNameAr",
                 (select count(*)::int from attachment a where a.object_type = 'employee_document' and a.object_id = d.id::text) as files
            ${from}
           order by case when d.status = 'valid' and d.expires_on is not null then 0 else 1 end, d.expires_on nulls last, d.created_at desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        documentNo: string;
        docType: DocumentType;
        title: string;
        referenceNo: string | null;
        status: string;
        issuedOn: string | null;
        expiresOn: string | null;
        employeeNo: string;
        fullNameEn: string;
        fullNameAr: string | null;
        files: number;
      }[],
  });
  return { ...page, rows: page.rows.map((r) => ({ ...r, expiry: r.status === 'valid' ? expiryState(r.expiresOn, today, warnDays) : null })), warnDays };
}

/** The document, its person and what it renewed or was renewed by. */
export async function byNo(tx: Tx, documentNo: string) {
  const [found] = await tx
    .select({
      row: employeeDocument,
      createdByName: sql<string | null>`(select u.display_name from app_user u where u.id = "employee_document"."created_by")`,
      withdrawnByName: sql<string | null>`(select u.display_name from app_user u where u.id = "employee_document"."withdrawn_by")`,
      replacesNo: sql<string | null>`(select p.document_no from employee_document p where p.id = "employee_document"."replaces_id")`,
      replacedByNo: sql<string | null>`(select n.document_no from employee_document n where n.replaces_id = "employee_document"."id")`,
    })
    .from(employeeDocument)
    .where(eq(employeeDocument.documentNo, documentNo))
    .limit(1);
  if (!found) return null;
  const person = await personOf(tx, found.row.employeeId);
  const { document_expiry_warning_days: warnDays } = await hrSettings.parameters(tx);
  const today = businessToday();
  // The person's papers of the same type — the renewals in order, this one among them.
  const chain = await tx
    .select({ documentNo: employeeDocument.documentNo, referenceNo: employeeDocument.referenceNo, issuedOn: employeeDocument.issuedOn, expiresOn: employeeDocument.expiresOn, status: employeeDocument.status })
    .from(employeeDocument)
    .where(and(eq(employeeDocument.employeeId, found.row.employeeId), eq(employeeDocument.docType, found.row.docType)))
    .orderBy(desc(employeeDocument.createdAt));
  return {
    ...found,
    person,
    chain,
    expiry: found.row.status === 'valid' ? expiryState(found.row.expiresOn, today, warnDays) : null,
    daysLeft: found.row.expiresOn ? daysLeft(found.row.expiresOn, today) : null,
  };
}

/** A person's documents, the valid ones first — for their record. */
export async function ofEmployee(tx: Tx, employeeId: string) {
  const today = businessToday();
  const { document_expiry_warning_days: warnDays } = await hrSettings.parameters(tx);
  const rows = await tx
    .select({ documentNo: employeeDocument.documentNo, docType: employeeDocument.docType, title: employeeDocument.title, referenceNo: employeeDocument.referenceNo, expiresOn: employeeDocument.expiresOn, status: employeeDocument.status })
    .from(employeeDocument)
    .where(eq(employeeDocument.employeeId, employeeId))
    .orderBy(sql`case when ${employeeDocument.status} = 'valid' then 0 else 1 end`, asc(employeeDocument.docType), desc(employeeDocument.createdAt));
  return rows.map((r) => ({ ...r, expiry: r.status === 'valid' ? expiryState(r.expiresOn, today, warnDays) : null }));
}
