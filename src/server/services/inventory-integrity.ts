/**
 * Inventory integrity — does the ledger say what the documents say?
 *
 * `inventory_movement` is the one truth for stock (§9.9; the header of
 * `db/schema/inventory.ts`). Every screen that shows a quantity sums it. The
 * documents — a Purchase Invoice, a Sales Invoice, a Transfer, a Return, a
 * Reconciliation, an Opening Stock — are the *reasons* rows were written, and
 * each one is written in the same transaction as its rows. So the two cannot
 * drift through the application.
 *
 * They can drift through anything that is not the application: a maintenance
 * script with an incomplete table list, a restore of one table and not another,
 * a hand-run delete. That is what happened on 2026-09-27 — three block-7
 * documents outlived every movement on the box — and it was found by a person
 * whose arithmetic disagreed with a screen. This module is the check that finds
 * it first. It answers three questions about documents, each a query rather
 * than a belief:
 *
 *   1. Is there a stock document with no ledger rows behind it?
 *   2. Is there a ledger row whose document no longer exists?
 *   3. Does every transfer leave one place by exactly what arrives at the other?
 *
 * The fourth question — do the FIFO layers still hold what the movements say
 * is there — is `inventory-reports.integrity`, the §9.9 check that predates
 * this file; it is asked alongside these, not repeated here.
 *
 * Read-only. Safe to run against a live system; it changes nothing.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/** A stock document that should have written movements and has none. */
export interface OrphanDocument {
  readonly documentType: string;
  readonly documentId: string;
  readonly documentNo: string;
  readonly branchCode: string;
}

/** A movement whose source document is gone. */
export interface OrphanMovement {
  readonly movementId: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly kind: string;
  readonly quantity: string;
}

/** A transfer whose issues and receipts do not net to nothing. */
export interface UnbalancedTransfer {
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly documentNo: string | null;
  readonly itemCode: string;
  readonly issued: string;
  readonly received: string;
  /** What the document itself says moved, where it says so. */
  readonly documented: string | null;
}

export interface IntegrityReport {
  readonly documentsWithoutLedger: readonly OrphanDocument[];
  readonly ledgerWithoutDocument: readonly OrphanMovement[];
  readonly unbalancedTransfers: readonly UnbalancedTransfer[];
  /** True when every list above is empty. */
  readonly clean: boolean;
}

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

/**
 * Stock documents whose ledger rows are missing.
 *
 * Only documents that *should* have moved stock: a posted invoice line that
 * names a warehouse, an approved sales return with an accepted quantity, a
 * posted goods return, an approved opening stock, and every transfer and
 * reconciliation — those two have no draft state, so a row is a movement.
 */
export async function documentsWithoutLedger(tx: Tx): Promise<OrphanDocument[]> {
  return rowsOf<OrphanDocument>(
    await tx.execute(sql`
      with missing as (
        select 'stock_transfer' as document_type, t.id::text as document_id,
               t.transfer_no as document_no, t.branch_code
          from stock_transfer t
         where not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'stock_transfer'
                              and m.source_document_id = t.id::text)
        union all
        select 'stock_adjustment', a.id::text, a.adjustment_no, a.branch_code
          from stock_adjustment a
         where not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'stock_adjustment'
                              and m.source_document_id = a.id::text)
        union all
        select 'ap_invoice', i.id::text, i.invoice_no, i.branch_code
          from ap_invoice i
         where i.posted_at is not null
           and exists (select 1 from ap_invoice_line l
                        where l.ap_invoice_id = i.id and l.warehouse_code is not null)
           and not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'ap_invoice'
                              and m.source_document_id = i.id::text)
        union all
        select 'ar_invoice', i.id::text, i.invoice_no, i.branch_code
          from ar_invoice i
         where i.posted_at is not null
           and exists (select 1 from ar_invoice_line l
                        where l.ar_invoice_id = i.id and l.warehouse_code is not null)
           and not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'ar_invoice'
                              and m.source_document_id = i.id::text)
        union all
        select 'sales_return', r.id::text, r.return_no, r.branch_code
          from sales_return r
         where r.status in ('approved', 'closed')
           and exists (select 1 from sales_return_line l
                        where l.sales_return_id = r.id
                          and coalesce(l.accepted_quantity, 0) > 0)
           and not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'sales_return'
                              and m.source_document_id = r.id::text)
        union all
        select 'goods_return', r.id::text, r.return_no, r.branch_code
          from goods_return r
         where r.status in ('posted', 'closed', 'settled')
           and not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'goods_return'
                              and m.source_document_id = r.id::text)
        union all
        select 'opening_stock', o.id::text, o.document_no, o.branch_code
          from opening_stock o
         where o.status = 'approved'
           and not exists (select 1 from inventory_movement m
                            where m.source_document_type = 'opening_stock'
                              and m.source_document_id = o.id::text)
      )
      select document_type as "documentType", document_id as "documentId",
             document_no as "documentNo", branch_code as "branchCode"
        from missing
       order by document_type, document_no
    `),
  );
}

/**
 * Movements that name a document which is not there.
 *
 * Only the document types the system writes are judged; a movement with no
 * source (a bare `inventory.receive` from a script) is not an orphan, it is a
 * movement that never claimed a document.
 */
export async function ledgerWithoutDocument(tx: Tx): Promise<OrphanMovement[]> {
  return rowsOf<OrphanMovement>(
    await tx.execute(sql`
      select m.id as "movementId",
             m.source_document_type as "sourceDocumentType",
             m.source_document_id as "sourceDocumentId",
             m.item_code as "itemCode",
             m.warehouse_code as "warehouseCode",
             m.kind::text as "kind",
             m.quantity::text as "quantity"
        from inventory_movement m
       where m.source_document_id is not null
         and case m.source_document_type
               when 'ap_invoice'        then not exists (select 1 from ap_invoice d where d.id::text = m.source_document_id)
               when 'supplier_shipment' then not exists (select 1 from ap_invoice d where d.id::text = m.source_document_id)
               when 'ar_invoice'        then not exists (select 1 from ar_invoice d where d.id::text = m.source_document_id)
               when 'sales_return'      then not exists (select 1 from sales_return d where d.id::text = m.source_document_id)
               when 'goods_return'      then not exists (select 1 from goods_return d where d.id::text = m.source_document_id)
               when 'stock_transfer'    then not exists (select 1 from stock_transfer d where d.id::text = m.source_document_id)
               when 'stock_adjustment'  then not exists (select 1 from stock_adjustment d where d.id::text = m.source_document_id)
               when 'opening_stock'     then not exists (select 1 from opening_stock d where d.id::text = m.source_document_id)
               else false
             end
       order by m.created_at, m.id
    `),
  );
}

/**
 * Transfers that created or destroyed stock.
 *
 * A move between warehouses is a `transfer_issue` where the goods left and a
 * `transfer_receipt` where they arrived, written together. Per document —
 * and per line, for a shipment, since each stage of Invoice Status Tracking
 * moves the same goods again — the two must sum to zero. A Transfer document
 * also states its quantity, and that must be what left.
 */
export async function unbalancedTransfers(tx: Tx): Promise<UnbalancedTransfer[]> {
  return rowsOf<UnbalancedTransfer>(
    await tx.execute(sql`
      with moved as (
        select m.source_document_type, m.source_document_id, m.item_code,
               coalesce(sum(-m.quantity) filter (where m.kind = 'transfer_issue'), 0)  as issued,
               coalesce(sum(m.quantity)  filter (where m.kind = 'transfer_receipt'), 0) as received
          from inventory_movement m
         where m.kind in ('transfer_issue', 'transfer_receipt')
           and m.source_document_id is not null
         group by m.source_document_type, m.source_document_id, m.item_code
      )
      select mv.source_document_type as "sourceDocumentType",
             mv.source_document_id as "sourceDocumentId",
             t.transfer_no as "documentNo",
             mv.item_code as "itemCode",
             mv.issued::text as "issued",
             mv.received::text as "received",
             t.quantity::text as "documented"
        from moved mv
        left join stock_transfer t
          on mv.source_document_type = 'stock_transfer' and t.id::text = mv.source_document_id
       where mv.issued <> mv.received
          or (t.id is not null and t.quantity <> mv.issued)
       order by mv.source_document_type, mv.source_document_id
    `),
  );
}

/** The three questions, asked together. */
export async function check(tx: Tx): Promise<IntegrityReport> {
  // One after another: they share the caller's connection, and pg queues a
  // second query on a busy client rather than running it alongside.
  const documents = await documentsWithoutLedger(tx);
  const movements = await ledgerWithoutDocument(tx);
  const transfers = await unbalancedTransfers(tx);
  return {
    documentsWithoutLedger: documents,
    ledgerWithoutDocument: movements,
    unbalancedTransfers: transfers,
    clean: documents.length === 0 && movements.length === 0 && transfers.length === 0,
  };
}
