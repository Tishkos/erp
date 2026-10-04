/**
 * Purchasing's answer to "where did the stock go?" — IMPROVEMENT-002.
 *
 * Goods sent back to the supplier left at what the invoice paid for them; the
 * freight and duty that landed them did not go back with them unless the
 * supplier pays that too. So the landed cost of returned units is:
 *
 *   * `purchase_variance` (the Purchase Invoice mapping) when the return does
 *     not say the supplier reimburses it — the default, because recoverability
 *     is never assumed;
 *   * `return_clearing` (the Purchase Return mapping) when it does, where the
 *     supplier's credit for it is awaited.
 *
 * The dimensions are the return's own journal's (branch, supplier, warehouse)
 * with the department and business line of the original invoice's journal
 * where it carried them, so an expense account that asks for a department is
 * answered the way the purchase was.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  DepartureError,
  journalLineOf,
  mappedAccount,
  type DepartedMovement,
  type DepartureDestination,
  type DepartureHandler,
} from '../services/inventory-departures';

const rows = <T>(result: { rows: unknown[] }) => result.rows as T[];

interface ReturnRow {
  returnNo: string;
  reimburses: boolean;
  journalEntryId: string | null;
  invoiceJournalId: string | null;
}

async function returnOf(tx: Tx, movement: DepartedMovement): Promise<ReturnRow | null> {
  if (movement.sourceDocumentType !== 'goods_return' || !movement.sourceDocumentId) return null;
  const [row] = rows<ReturnRow>(
    await tx.execute(sql`
      select r.return_no as "returnNo", r.reimburses_landed_cost as reimburses,
             r.journal_entry_id as "journalEntryId", i.journal_entry_id as "invoiceJournalId"
        from goods_return r
        left join ap_invoice i on i.id = r.ap_invoice_id
       where r.id::text = ${movement.sourceDocumentId}`),
  );
  return row ?? null;
}

async function destination(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  const document = await returnOf(tx, movement);
  const reimburses = document?.reimburses ?? false;
  const role = reimburses ? 'return_clearing' : 'purchase_variance';
  const event = reimburses ? 'purchasing.supplier_credit_memo' : 'purchasing.ap_invoice';
  const accountId = await mappedAccount(tx, event, role, {
    branchCode: movement.branchCode,
    warehouseCode: movement.warehouseCode,
  });
  if (!accountId) {
    throw new DepartureError(
      `${document ? `Goods Return ${document.returnNo}` : `The return of ${movement.movementDate}`} sent ` +
        `${movement.itemCode} back${reimburses ? ' with its landed cost reimbursed' : ''}, so its landed cost goes to ` +
        `'${role}' (${event}), and no account is mapped for it. Map it in Posting Mappings, then lock.`,
    );
  }

  // The return's own journal: the direct route's one entry, or the movement's.
  const journalId = document?.journalEntryId ?? movement.journalEntryId;
  const own = journalId ? await journalLineOf(tx, journalId, 'inventory', { warehouseCode: movement.warehouseCode }) : null;
  const dimensions: Record<string, string | null> = {
    ...(own?.dimensions ?? {}),
    branch: movement.branchCode,
    warehouse: movement.warehouseCode,
  };
  if (document?.invoiceJournalId) {
    const [attributed] = rows<{ department: string | null; businessLine: string | null }>(
      await tx.execute(sql`
        select department_code as department, business_line_code as "businessLine"
          from journal_line
         where journal_entry_id = ${document.invoiceJournalId}
           and (department_code is not null or business_line_code is not null)
         order by line_no limit 1`),
    );
    if (attributed?.department && !dimensions.department) dimensions.department = attributed.department;
    if (attributed?.businessLine && !dimensions.business_line) dimensions.business_line = attributed.businessLine;
  }
  return { role, accountId, dimensions };
}

async function label(tx: Tx, movement: DepartedMovement): Promise<string | null> {
  const document = await returnOf(tx, movement);
  return document ? `Goods Return ${document.returnNo}` : null;
}

export const PURCHASING_DEPARTURES: Readonly<Record<string, DepartureHandler>> = Object.freeze({
  goods_return: { destination, label },
});
