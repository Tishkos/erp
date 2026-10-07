/**
 * A purchase invoice's or an import application's due date as a query reads
 * it: the date once somebody set it on purpose, otherwise none (2026-10-07, by
 * direction: "don't show the due date until we get the SWIFT"). The rule in
 * words is `domain/balance-due.ts`; these are the same rule for SQL, so a
 * register, the Home lists and the ageing say what the record says.
 *
 * No imports from other services: anything may use these without a cycle.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/** An invoice's due date: `due_date` once `due_date_set_at` is stamped, otherwise null. */
export function knownInvoiceDueSql(dueDate: AnyColumn | SQL, setAt: AnyColumn | SQL): SQL<string | null> {
  return sql<string | null>`(case when ${setAt} is not null then ${dueDate} end)::text`;
}

/**
 * An import application's due date: with live invoices, its own date once one
 * of them was set on purpose (`ap-invoice.setDueDate` moves the import's date
 * with the invoice's); with none, the date typed on the import, if any.
 */
export function knownPayableDueSql(payableId: AnyColumn | SQL, dueDate: AnyColumn | SQL): SQL<string | null> {
  return sql<string | null>`(case
    when not exists (select 1 from ap_invoice di where di.payable_id = ${payableId} and di.status::text <> 'reversed')
      or exists (select 1 from ap_invoice di where di.payable_id = ${payableId} and di.status::text <> 'reversed' and di.due_date_set_at is not null)
    then ${dueDate} end)::text`;
}

/** True while an import has live invoices and none has its due date yet: the date waits for the SWIFT. */
export function payableDueWaitsSql(payableId: AnyColumn | SQL): SQL<boolean> {
  return sql<boolean>`(exists (select 1 from ap_invoice di where di.payable_id = ${payableId} and di.status::text <> 'reversed')
    and not exists (select 1 from ap_invoice di where di.payable_id = ${payableId} and di.status::text <> 'reversed' and di.due_date_set_at is not null))`;
}
