/**
 * The import application as a document — by direction, 2026-10-03: "print
 * button two for import application please".
 *
 * Every other record in Payables can be handed to somebody: the purchase
 * invoice, the B/L, the ASYCUDA reading. The import application is the one that
 * ties them together — the supplier, what was agreed and in what currency, the
 * rate its dinars were worked out at, the goods ordered, and the invoices
 * raised against it — and it could not be printed at all.
 *
 * One model for the PDF, the workbook and the Word file, read through the
 * reader's own row security like every other builder here.
 */
import { formatBusinessDate } from '@/i18n/config';
import { divideHalfUp, MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { parseQuantity, QUANTITY_FACTOR } from '../domain/uom';
import * as payables from '../services/payables';
import type { BuildContext, Built } from './documents';

export async function importApplication(ctx: BuildContext, payableNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await payables.view(tx, payableNo).catch(() => null);
  if (!found) return null;

  const { payable: row, type, lines, invoices, supplier } = found;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`payables.${key}`, values);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');

  /*
   * The rate the dinars were actually worked out at — what was agreed divided
   * by what it came to, which is the same figure the screen shows. Not stored
   * as a rate anywhere, and it does not need to be: the two amounts are facts
   * and the rate is what they imply.
   */
  const agreed = parseDecimal(row.amountTxn, MONEY_SCALE);
  const inDinars = parseDecimal(row.amountIqd, MONEY_SCALE);
  const rate =
    row.currency !== 'IQD' && agreed > 0n
      ? toDecimalString(divideHalfUp(inDinars * 10_000n, agreed), MONEY_SCALE)
      : null;

  const amount =
    row.currency === 'IQD'
      ? `${row.amountIqd} IQD`
      : `${row.amountTxn} ${row.currency} · ${row.amountIqd} IQD`;

  return {
    model: {
      kind: 'document',
      title: m.print('titles.import_application'),
      number: row.payableNo,
      status: type.name,
      posted: Boolean(row.closedAt),
      orientation: 'portrait',
      fields: [
        { label: t('col_no'), value: row.payableNo, ltr: true },
        { label: t('supplier'), value: supplier?.name ?? '—' },
        { label: t('reference'), value: row.supplierReference ?? '—', ltr: true },
        { label: t('col_amount'), value: amount, ltr: true },
        ...(rate ? [{ label: t('rate_applied'), value: `1 ${row.currency} = ${rate} IQD`, ltr: true }] : []),
        { label: t('document_date'), value: day(row.documentDate), ltr: true },
        { label: t('col_branch'), value: row.branchCode, ltr: true },
        { label: t('description'), value: row.description ?? '—' },
      ],
      filters: [],
      tables: [
        {
          title: t('tab_order'),
          columns: [
            { key: 'line', label: '#', kind: 'code' },
            { key: 'item', label: t('col_item'), kind: 'code' },
            { key: 'description', label: t('col_description'), kind: 'text', weight: 2 },
            { key: 'quantity', label: t('col_qty'), kind: 'quantity' },
            { key: 'price', label: t('col_unit_price'), kind: 'money' },
            { key: 'amount', label: t('col_amount'), kind: 'money' },
          ],
          rows: lines.map((line) => ({
            cells: {
              line: String(line.lineNo),
              item: line.itemCode ?? '—',
              description: line.description,
              quantity: line.quantity ?? '0',
              price: line.unitPrice ?? '0',
              // Quantities are held at six places and money at four — the
              // invoice record's own arithmetic, not a second one.
              amount: toDecimalString(
                (parseQuantity(line.quantity ?? '0') *
                  parseDecimal(line.unitPrice ?? '0', MONEY_SCALE)) /
                  QUANTITY_FACTOR,
                MONEY_SCALE,
              ),
            },
          })),
          empty: t('no_lines'),
        },
        {
          title: t('tab_invoices'),
          columns: [
            { key: 'invoiceNo', label: t('col_invoice_no'), kind: 'code' },
            { key: 'supplierNo', label: t('col_supplier_invoice_no'), kind: 'code' },
            { key: 'date', label: t('col_date'), kind: 'text' },
            { key: 'total', label: t('col_total_iqd'), kind: 'money' },
            { key: 'settled', label: t('col_settled_iqd'), kind: 'money' },
            { key: 'status', label: t('col_status'), kind: 'text' },
          ],
          rows: invoices.map((invoice) => ({
            cells: {
              invoiceNo: invoice.invoiceNo,
              supplierNo: invoice.supplierInvoiceNo,
              date: day(invoice.invoiceDate),
              total: invoice.totalIqd,
              settled: invoice.settledAmountIqd,
              status: invoice.status,
            },
          })),
          empty: t('no_invoices'),
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: row.payableNo,
      sheetName: row.payableNo,
    },
    branchCode: row.branchCode,
    objectId: row.id,
  };
}
