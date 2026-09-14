/**
 * Warranty — Phase 06.7, §7.4.
 *
 * > *"Warranty starts on the A/R Invoice date. Warranty duration is maintained
 * > in Item Master and the end date is calculated automatically."*
 *
 * Registration is not an action somebody performs. It happens when the A/R
 * Invoice posts, because that is the moment §7.4 names — and because a warranty
 * that had to be registered separately is a warranty that gets forgotten on the
 * busy day and disputed two years later.
 *
 * The units come from the Delivery Note's identified units, which came from the
 * pick. So the serial on a warranty certificate is the serial a picker scanned
 * off a shelf, and §9.9's chain runs receipt → pick → delivery → invoice →
 * warranty without a break.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  arInvoiceLine,
  deliveryNoteLineUnit,
  item,
  warrantyRegistration,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { warrantyFor } from '../domain/warranty';
import type { ActorContext } from './chart-of-accounts';

export const PERMISSION_OBJECT = 'warranty_registration';

/**
 * Registers the warranties an invoice creates.
 *
 * Called from `ar-invoice.post`. Idempotent by construction for serials — the
 * unique index on (item, serial) refuses a second registration of the same unit
 * — which is what makes a retried posting safe.
 */
export async function registerForInvoice(
  tx: Tx,
  ctx: ActorContext,
  arInvoiceId: string,
): Promise<{ registered: number }> {
  const [invoice] = await tx
    .select()
    .from(arInvoice)
    .where(eq(arInvoice.id, arInvoiceId))
    .limit(1);

  if (!invoice) throw new Error(`No A/R invoice with id '${arInvoiceId}'.`);

  const lines = await tx
    .select()
    .from(arInvoiceLine)
    .where(eq(arInvoiceLine.arInvoiceId, arInvoiceId))
    .orderBy(arInvoiceLine.lineNo);

  if (lines.length === 0) return { registered: 0 };

  const items = await tx
    .select({ code: item.code, warrantyMonths: item.warrantyMonths })
    .from(item)
    .where(inArray(item.code, [...new Set(lines.map((line) => line.itemCode))]));

  const monthsByItem = new Map(items.map((row) => [row.code, row.warrantyMonths]));

  let registered = 0;

  for (const line of lines) {
    // §9.3 — warranty fields are optional. An item with no duration produces no
    // record at all, which is the 06.7 gate: `warrantyFor` returns null and
    // there is nothing to insert.
    const warranty = warrantyFor({
      invoiceDate: invoice.invoiceDate,
      warrantyMonths: monthsByItem.get(line.itemCode) ?? null,
    });

    if (!warranty) continue;

    // The units the delivery carried, so a certificate names the serial the
    // picker scanned (§9.9).
    // An invoice raised directly has no delivery behind it — Operations block
    // 5 — so there are no scanned units to name, and the certificate covers
    // the line as a whole, which is the case handled just below.
    const units = line.deliveryNoteLineId
      ? await tx
          .select()
          .from(deliveryNoteLineUnit)
          .where(eq(deliveryNoteLineUnit.deliveryNoteLineId, line.deliveryNoteLineId))
      : [];

    const covered =
      units.length > 0
        ? units.map((unit) => ({
            serialNumber: unit.serialNumber,
            batchNumber: unit.batchNumber,
            quantity: parseQuantity(unit.quantity),
          }))
        : // Nothing identified: one row for the line, because there is nothing
          // finer to point at.
          [{ serialNumber: null, batchNumber: null, quantity: parseQuantity(line.quantity) }];

    for (const unit of covered) {
      await tx.insert(warrantyRegistration).values({
        arInvoiceId,
        arInvoiceLineId: line.id,
        customerId: invoice.customerId,
        branchCode: invoice.branchCode,
        itemCode: line.itemCode,
        serialNumber: unit.serialNumber,
        batchNumber: unit.batchNumber,
        quantity: formatQuantity(unit.quantity),
        warrantyMonths: warranty.months,
        startsOn: warranty.startsOn,
        endsOn: warranty.endsOn,
        createdBy: ctx.principal.userId,
      });
      registered += 1;
    }
  }

  return { registered };
}

export interface WarrantyLookup {
  readonly itemCode: string;
  readonly serialNumber: string | null;
  readonly batchNumber: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly warrantyMonths: number;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly customerCode: string;
  readonly customerName: string;
}

/**
 * §7.4 — the warranty lookup, by serial number.
 *
 * What a person at a counter has is the unit in their hand. So the question the
 * system answers is *"is this covered, and by which invoice"* — not *"which
 * invoice would you like to look inside"*.
 */
export async function lookupBySerial(
  tx: Tx,
  serialNumber: string,
): Promise<WarrantyLookup | null> {
  const result = await tx.execute(sql`
    select w.item_code            as "itemCode",
           w.serial_number        as "serialNumber",
           w.batch_number         as "batchNumber",
           w.starts_on::text      as "startsOn",
           w.ends_on::text        as "endsOn",
           w.warranty_months      as "warrantyMonths",
           i.invoice_no           as "invoiceNo",
           i.invoice_date::text   as "invoiceDate",
           p.code                 as "customerCode",
           p.legal_name           as "customerName"
      from warranty_registration w
      join ar_invoice i       on i.id = w.ar_invoice_id
      join business_partner p on p.id = w.customer_id
     where w.serial_number = ${serialNumber}
     limit 1
  `);

  const rows = (result as unknown as { rows: WarrantyLookup[] }).rows;
  return rows[0] ?? null;
}

/** Every warranty an invoice created — for the invoice's own record page. */
export async function forInvoice(tx: Tx, arInvoiceId: string) {
  return tx
    .select()
    .from(warrantyRegistration)
    .where(eq(warrantyRegistration.arInvoiceId, arInvoiceId))
    .orderBy(warrantyRegistration.itemCode, warrantyRegistration.serialNumber);
}

/**
 * Warranties expiring in a window — the report a service desk actually wants.
 *
 * Bounded by dates rather than by "days from now", because the domain has no
 * clock and a report that silently used the server's today would give a
 * different answer to two people in two timezones (TECHSTACK A10).
 */
export async function expiringBetween(tx: Tx, from: string, to: string) {
  return tx
    .select()
    .from(warrantyRegistration)
    .where(
      and(
        sql`${warrantyRegistration.endsOn} >= ${from}::date`,
        sql`${warrantyRegistration.endsOn} <= ${to}::date`,
      ),
    )
    .orderBy(warrantyRegistration.endsOn);
}
