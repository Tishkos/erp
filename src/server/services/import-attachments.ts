/**
 * Every file of an import's chain, back on the import's own sections — by
 * direction 2026-10-07:
 *
 *   "every attachment related to an import application comes back to the
 *    attachments field … I attached it in the payment application itself, but
 *    it didn't come back to the import application. It should be dynamic since
 *    it's related — B/L, landed cost and ASYCUDA: all of their attachments come
 *    back" — and, corrected the same day, "they have their own block and their
 *    attachments please — their attachment should come back to their blocks".
 *
 * So each of the import page's paperclips shows its own files PLUS the files
 * of the related records that belong to that block:
 *
 *   header        the import's own (`payable`), its purchase invoices
 *                 (`ap_invoice`), and what fits no section — the goods
 *                 returns that claim against those invoices (`goods_return`)
 *   payments      `payable_payments`; its payment applications (their files
 *                 and their papers, each paper with what it is), the supplier
 *                 advances and supplier payments those applications posted,
 *                 the advances raised on the import, and the payments
 *                 allocated straight to its invoices
 *   customs       `payable_customs`; its PDs (re-registered ones too), the
 *                 ASYCUDA readings that read them (the reading's own report
 *                 names the PD), its customs declarations
 *   shipment      `payable_shipment`; its B/Ls and containers (a container
 *                 receipt keeps no files of its own — its papers are the
 *                 container's)
 *   landed cost   `payable_landed_cost`; the documents its charges came from
 *                 (the freight or clearance invoice, the journal a charge
 *                 names) — a charge carries no file of its own
 *
 * Nothing is copied or stored: the records are found through the foreign
 * keys they already carry and the logistics readers (`shippingForImport`,
 * `customsForImport`), and their files are read now, so a file put on a
 * payment application is on the import the moment it is saved. Each record's
 * files are shown only if `attachments.mayAccessParent` admits it for this
 * viewer — the same check the download route asks again on every fetch. A
 * record is listed once, in the first section that claims it.
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  goodsReturn,
  journalEntry,
  landedCostCharge,
  paymentApplication,
  supplierAdvance,
  supplierPayment,
  supplierPaymentAllocation,
} from '../db/schema';
import type { Principal } from '../domain/permissions';
import type { ProfileKind, ProfileQualifier } from '../domain/profiles';
import * as attachments from './attachments';
import * as logistics from './logistics-views';

export const IMPORT_FILE_SECTIONS = ['header', 'payments', 'customs', 'shipment', 'landed_cost'] as const;
export type ImportFileSection = (typeof IMPORT_FILE_SECTIONS)[number];

/** The object each block's own paperclip files under — the import's id under a name of its own. */
export const SECTION_OBJECT: Readonly<Record<ImportFileSection, string>> = Object.freeze({
  header: 'payable',
  payments: 'payable_payments',
  customs: 'payable_customs',
  shipment: 'payable_shipment',
  landed_cost: 'payable_landed_cost',
});

/** What a source record is — a message key `files_source_<kind>` under `admin.payables`. */
export type ImportFileSourceKind =
  | 'purchase_invoice'
  | 'goods_return'
  | 'payment_application'
  | 'supplier_advance'
  | 'supplier_payment'
  | 'customs_pd'
  | 'asycuda_run'
  | 'customs_declaration'
  | 'bill_of_lading'
  | 'shipment_container'
  | 'charge_invoice'
  | 'charge_journal';

/** Where a source opens: a profile (`profileHref`) or a route of its own. */
export type ImportFileLink =
  | { readonly profile: ProfileKind; readonly key: string; readonly qualifier?: ProfileQualifier }
  | { readonly href: string };

export interface ImportFile {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly version: number;
  /** ISO instant. */
  readonly createdAt: string;
  readonly uploadedBy: string | null;
  /** A payment application's paper: what it is (`sent_to_bank`, `paid`, `rejected_cancelled`, `other`). */
  readonly paperKind: string | null;
}

export interface ImportFileSource {
  readonly section: ImportFileSection;
  readonly kind: ImportFileSourceKind;
  /** The attachment's object type and id — what the file is kept under. */
  readonly objectType: string;
  readonly objectId: string;
  /** The record's number as people say it. */
  readonly no: string;
  readonly link: ImportFileLink | null;
  readonly files: readonly ImportFile[];
}

export type GatheredFiles = Readonly<Record<ImportFileSection, readonly ImportFileSource[]>>;

interface Candidate {
  readonly section: ImportFileSection;
  readonly kind: ImportFileSourceKind;
  readonly objectType: string;
  readonly objectId: string;
  readonly no: string;
  readonly link: ImportFileLink | null;
}

/** The import's related records, by block — found through the keys they carry, never guessed. */
export async function relatedRecords(tx: Tx, payableId: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const push = (candidate: Candidate) => found.push(candidate);

  // ── Header: the purchase invoices, and the goods returns that claim against them.
  const invoices = await tx
    .select({ id: apInvoice.id, invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(eq(apInvoice.payableId, payableId))
    .orderBy(asc(apInvoice.invoiceDate), asc(apInvoice.invoiceNo));
  for (const invoice of invoices) {
    push({ section: 'header', kind: 'purchase_invoice', objectType: 'ap_invoice', objectId: invoice.id, no: invoice.invoiceNo, link: { profile: 'purchase_invoice', key: invoice.invoiceNo } });
  }
  const invoiceIds = invoices.map((invoice) => invoice.id);
  if (invoiceIds.length > 0) {
    const returns = await tx
      .select({ id: goodsReturn.id, returnNo: goodsReturn.returnNo })
      .from(goodsReturn)
      .where(inArray(goodsReturn.apInvoiceId, invoiceIds))
      .orderBy(asc(goodsReturn.returnNo));
    for (const row of returns) {
      push({ section: 'header', kind: 'goods_return', objectType: 'goods_return', objectId: row.id, no: row.returnNo, link: { profile: 'goods_return', key: row.returnNo } });
    }
  }

  // ── Payments: the applications, what their confirmations posted, the advances and direct payments.
  const applications = await tx
    .select({
      id: paymentApplication.id,
      applicationNo: paymentApplication.applicationNo,
      supplierPaymentId: paymentApplication.supplierPaymentId,
      supplierAdvanceId: paymentApplication.supplierAdvanceId,
    })
    .from(paymentApplication)
    .where(eq(paymentApplication.payableId, payableId))
    .orderBy(asc(paymentApplication.createdAt));
  for (const application of applications) {
    push({
      section: 'payments',
      kind: 'payment_application',
      objectType: 'payment_application',
      objectId: application.id,
      no: application.applicationNo,
      link: { profile: 'payment_application', key: application.applicationNo },
    });
  }
  const advanceIds = applications.map((one) => one.supplierAdvanceId).filter((id): id is string => Boolean(id));
  const advances = await tx
    .select({ id: supplierAdvance.id, advanceNo: supplierAdvance.advanceNo })
    .from(supplierAdvance)
    .where(advanceIds.length > 0 ? or(eq(supplierAdvance.payableId, payableId), inArray(supplierAdvance.id, advanceIds)) : eq(supplierAdvance.payableId, payableId))
    .orderBy(asc(supplierAdvance.advanceNo));
  for (const advance of advances) {
    push({ section: 'payments', kind: 'supplier_advance', objectType: 'supplier_advance', objectId: advance.id, no: advance.advanceNo, link: { profile: 'supplier_advance', key: advance.advanceNo } });
  }
  const paymentIds = applications.map((one) => one.supplierPaymentId).filter((id): id is string => Boolean(id));
  const payments =
    paymentIds.length > 0 || invoiceIds.length > 0
      ? await tx
          .selectDistinct({ id: supplierPayment.id, paymentNo: supplierPayment.paymentNo })
          .from(supplierPayment)
          .where(
            or(
              // What a confirmed application posted.
              paymentIds.length > 0 ? inArray(supplierPayment.id, paymentIds) : undefined,
              // Paid straight against the import's invoices on the Supplier Payments screen (`payables.directPayments`).
              invoiceIds.length > 0
                ? inArray(
                    supplierPayment.id,
                    tx
                      .select({ id: supplierPaymentAllocation.supplierPaymentId })
                      .from(supplierPaymentAllocation)
                      .where(and(inArray(supplierPaymentAllocation.apInvoiceId, invoiceIds), isNull(supplierPaymentAllocation.reversedAt))),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(supplierPayment.paymentNo))
      : [];
  for (const payment of payments) {
    push({ section: 'payments', kind: 'supplier_payment', objectType: 'supplier_payment', objectId: payment.id, no: payment.paymentNo, link: { profile: 'supplier_payment', key: payment.paymentNo } });
  }

  // ── PD / ASYCUDA: the PDs and declarations as the container page reads them, and the readings that read those PDs.
  const customs = await logistics.customsForImport(tx, payableId);
  for (const pd of customs.pds) {
    push({
      section: 'customs',
      kind: 'customs_pd',
      objectType: 'customs_pd',
      objectId: pd.id,
      no: pd.pdNo,
      link: { profile: 'pd', key: pd.pdNo, ...(pd.year ? { qualifier: { year: Number(pd.year) } } : {}) },
    });
  }
  const pdIds = customs.pds.map((pd) => pd.id);
  if (pdIds.length > 0) {
    // A reading is not filed under one import: its own report says which PDs it read (`asycuda-runs.runLines`).
    const runs = await tx.execute(sql`
      select r.id::text as id, r.run_no as "runNo"
        from asycuda_run r
       where r.run_no is not null
         and exists (select 1 from jsonb_array_elements(coalesce(r.report->'rows', '[]'::jsonb)) as line
                      where line->>'pdId' in (${sql.join(pdIds.map((id) => sql`${id}`), sql`, `)}))
       order by r.read_at`);
    for (const run of runs.rows as { id: string; runNo: string }[]) {
      push({ section: 'customs', kind: 'asycuda_run', objectType: 'asycuda_run', objectId: run.id, no: run.runNo, link: { profile: 'asycuda_run', key: run.runNo } });
    }
  }
  for (const declaration of customs.declarations) {
    push({
      section: 'customs',
      kind: 'customs_declaration',
      objectType: 'customs_declaration',
      objectId: declaration.id,
      no: declaration.declarationNo,
      link: { href: `/logistics/customs-declarations/${encodeURIComponent(declaration.declarationNo)}` },
    });
  }

  // ── Shipment & containers: the B/Ls and containers, as the PD page reads them.
  const shipping = await logistics.shippingForImport(tx, payableId);
  const bls = new Map<string, string>();
  for (const row of shipping) if (!bls.has(row.blId)) bls.set(row.blId, row.blNo);
  for (const [id, blNo] of bls) {
    push({ section: 'shipment', kind: 'bill_of_lading', objectType: 'bill_of_lading', objectId: id, no: blNo, link: { profile: 'bl', key: blNo } });
  }
  for (const row of shipping) {
    if (!row.id || !row.containerNo) continue;
    push({
      section: 'shipment',
      kind: 'shipment_container',
      objectType: 'shipment_container',
      objectId: row.id,
      no: row.containerNo,
      link: { profile: 'container', key: row.containerNo, qualifier: { id: row.id } },
    });
  }

  // ── Landed cost: the documents its live charges came from (§20.2: charges come from documents).
  const charges = await tx
    .select({ sourceType: landedCostCharge.sourceType, sourceId: landedCostCharge.sourceId })
    .from(landedCostCharge)
    .where(and(eq(landedCostCharge.payableId, payableId), isNull(landedCostCharge.cancelledAt)));
  const lineIds = charges.filter((charge) => charge.sourceType === 'ap_invoice_line').map((charge) => charge.sourceId);
  if (lineIds.length > 0) {
    const chargeInvoices = await tx
      .selectDistinct({ id: apInvoice.id, invoiceNo: apInvoice.invoiceNo })
      .from(apInvoiceLine)
      .innerJoin(apInvoice, eq(apInvoice.id, apInvoiceLine.apInvoiceId))
      .where(inArray(sql`${apInvoiceLine.id}::text`, lineIds))
      .orderBy(asc(apInvoice.invoiceNo));
    for (const invoice of chargeInvoices) {
      push({ section: 'landed_cost', kind: 'charge_invoice', objectType: 'ap_invoice', objectId: invoice.id, no: invoice.invoiceNo, link: { profile: 'purchase_invoice', key: invoice.invoiceNo } });
    }
  }
  // A journal charge's source is "<journal id>/<import id>" — one journal may carry costs of several imports.
  const journalIds = [
    ...new Set(
      charges
        .filter((charge) => charge.sourceType === 'journal_entry')
        .map((charge) => charge.sourceId.split('/')[0]!)
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
    ),
  ];
  if (journalIds.length > 0) {
    const journals = await tx
      .select({ id: journalEntry.id, entryNo: journalEntry.entryNo })
      .from(journalEntry)
      .where(inArray(journalEntry.id, journalIds))
      .orderBy(asc(journalEntry.entryNo));
    for (const journal of journals) {
      push({ section: 'landed_cost', kind: 'charge_journal', objectType: 'journal_entry', objectId: journal.id, no: journal.entryNo, link: { profile: 'journal', key: journal.entryNo } });
    }
  }

  // A record is listed once, in the first block that claims it.
  const seen = new Set<string>();
  return found.filter((candidate) => {
    const key = `${candidate.objectType}|${candidate.objectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The current files of these records — clean, not superseded, not disposed — with their uploaders' names. */
async function filesOf(tx: Tx, records: readonly { objectType: string; objectId: string }[]) {
  if (records.length === 0) return new Map<string, ImportFile[]>();
  const pairs = sql.join(
    records.map((record) => sql`(${record.objectType}::text, ${record.objectId}::text)`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    select a.id::text as id, a.object_type as "objectType", a.object_id as "objectId", a.file_name as "fileName",
           a.content_type as "contentType", a.size_bytes as "sizeBytes", a.version, a.created_at as "createdAt",
           u.display_name as "uploadedBy", p.kind as "paperKind"
      from attachment a
      left join app_user u on u.id = a.uploaded_by
      left join payment_application_paper p on p.attachment_id = a.id
     where (a.object_type, a.object_id) in (${pairs})
       and a.scan_status = 'clean' and a.superseded_by_id is null and a.disposed_at is null
     order by a.created_at, a.id`);
  const byRecord = new Map<string, ImportFile[]>();
  for (const row of result.rows as {
    id: string;
    objectType: string;
    objectId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    version: number;
    createdAt: Date | string;
    uploadedBy: string | null;
    paperKind: string | null;
  }[]) {
    const key = `${row.objectType}|${row.objectId}`;
    const list = byRecord.get(key) ?? [];
    list.push({
      id: row.id,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: Number(row.sizeBytes),
      version: Number(row.version),
      createdAt: new Date(row.createdAt).toISOString(),
      uploadedBy: row.uploadedBy,
      paperKind: row.paperKind,
    });
    byRecord.set(key, list);
  }
  return byRecord;
}

/**
 * The related records' files for each block of the import's page, as this
 * viewer may see them. The blocks' own files are not here — each paperclip
 * already reads its own (`readAttachments`); these are what come back to it.
 * A record with no file is left out.
 */
export async function gather(tx: Tx, principal: Principal, payableId: string): Promise<GatheredFiles> {
  // Who may read which record's files is registered lazily; a cold process would answer "cannot be determined".
  const { registerAllRecords } = await import('../records');
  registerAllRecords();

  const records = await relatedRecords(tx, payableId);
  const files = await filesOf(tx, records);
  const out: Record<ImportFileSection, ImportFileSource[]> = { header: [], payments: [], customs: [], shipment: [], landed_cost: [] };
  for (const record of records) {
    const list = files.get(`${record.objectType}|${record.objectId}`);
    if (!list || list.length === 0) continue;
    // The record's own rule, for this viewer — no answer is no.
    if ((await attachments.mayAccessParent(tx, principal, record.objectType, record.objectId)) !== true) continue;
    out[record.section].push({ ...record, files: list });
  }
  return out;
}

/** How many files a block's gathered sources hold. */
export const countOf = (sources: readonly ImportFileSource[]): number => sources.reduce((sum, source) => sum + source.files.length, 0);
