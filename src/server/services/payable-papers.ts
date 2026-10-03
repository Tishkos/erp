/**
 * Everything on paper that belongs to one import — REQ-AP-001 §21.3.
 *
 * By direction (2026-10-03): "gets attachment from all payment application bl
 * everything that related to this application this is very important".
 *
 * An import's paperwork does not live in one place and should not have to.
 * The supplier's invoice is attached to the invoice, the customs letter to the
 * declaration, the bank's advice to the payment application, the bill of
 * lading to the shipment — each where the person working on it put it, which
 * is right. What was missing is the one list: open the import and see every
 * piece of paper it has, whichever document it hangs from.
 *
 * Read-only and derived. Nothing is copied, nothing is moved: an attachment
 * belongs to the document it was put on, and this says which document that
 * was. Delete nothing here — a file is removed where it lives or not at all.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  attachment,
  billOfLading,
  customsPd,
  paymentApplication,
  shipmentContainer,
} from '../db/schema';

export interface PayablePaper {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  /** The document it hangs from, as a person would name it. */
  readonly source: string;
  readonly sourceNo: string;
  /** Where to open that document. Null when it has no page of its own. */
  readonly href: string | null;
}

/** One kind of document that can carry paper for an import. */
interface Source {
  readonly objectType: string;
  readonly label: string;
  /** The documents of this kind belonging to the payable, by id. */
  readonly find: (tx: Tx, payableId: string) => Promise<{ readonly id: string; readonly no: string }[]>;
  readonly href: (no: string) => string | null;
}

const SOURCES: readonly Source[] = [
  {
    objectType: 'ap_invoice',
    label: 'invoice',
    find: async (tx, payableId) =>
      (
        await tx
          .select({ id: apInvoice.id, no: apInvoice.invoiceNo })
          .from(apInvoice)
          .where(eq(apInvoice.payableId, payableId))
      ).map((row) => ({ id: row.id, no: row.no })),
    href: (no) => `/payables/invoices/${encodeURIComponent(no)}`,
  },
  {
    objectType: 'customs_pd',
    label: 'declaration',
    find: async (tx, payableId) =>
      (
        await tx
          .select({ id: customsPd.id, no: customsPd.pdNo })
          .from(customsPd)
          .where(eq(customsPd.payableId, payableId))
      ).map((row) => ({ id: row.id, no: row.no })),
    href: (no) => `/payables/pd/${encodeURIComponent(no)}`,
  },
  {
    objectType: 'payment_application',
    label: 'payment application',
    find: async (tx, payableId) =>
      (
        await tx
          .select({ id: paymentApplication.id, no: paymentApplication.applicationNo })
          .from(paymentApplication)
          .where(eq(paymentApplication.payableId, payableId))
      ).map((row) => ({ id: row.id, no: row.no })),
    href: (no) => `/payables/payment-applications/${encodeURIComponent(no)}`,
  },
  {
    objectType: 'bill_of_lading',
    label: 'bill of lading',
    find: async (tx, payableId) =>
      (
        await tx
          .select({ id: billOfLading.id, no: billOfLading.blNo })
          .from(billOfLading)
          .where(eq(billOfLading.payableId, payableId))
      ).map((row) => ({ id: row.id, no: row.no })),
    href: () => null,
  },
  {
    objectType: 'shipment_container',
    label: 'container',
    find: async (tx, payableId) =>
      (
        await tx
          .select({ id: shipmentContainer.id, no: shipmentContainer.containerNo })
          .from(shipmentContainer)
          .where(eq(shipmentContainer.payableId, payableId))
      ).map((row) => ({ id: row.id, no: row.no })),
    href: () => `/payables/containers`,
  },
];

/**
 * Every current attachment belonging to this import, newest first.
 *
 * "Current" is the live version of each file: an attachment that has been
 * superseded is history, and the list is what the import has now.
 */
export async function papersFor(tx: Tx, payableId: string): Promise<readonly PayablePaper[]> {
  const papers: PayablePaper[] = [];

  for (const source of SOURCES) {
    const documents = await source.find(tx, payableId).catch(() => []);
    if (documents.length === 0) continue;
    const byId = new Map(documents.map((document) => [document.id, document.no]));

    const rows = await tx
      .select({
        id: attachment.id,
        objectId: attachment.objectId,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        createdAt: attachment.createdAt,
      })
      .from(attachment)
      .where(
        and(
          eq(attachment.objectType, source.objectType),
          inArray(attachment.objectId, [...byId.keys()]),
          // The live version only: a superseded file is history.
          // Nothing is deleted in this system; a file is superseded by its
          // next version, and the live one is the one nothing supersedes.
          sql`not exists (select 1 from attachment newer where newer.supersedes_id = ${attachment.id})`,
        ),
      )
      .orderBy(desc(attachment.createdAt));

    for (const row of rows) {
      const no = byId.get(row.objectId) ?? '';
      papers.push({
        id: row.id,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
        source: source.label,
        sourceNo: no,
        href: source.href(no),
      });
    }
  }

  return papers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
