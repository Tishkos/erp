/**
 * The legacy books import — REQ-LEGACY-001 (2026-10-02).
 *
 * The accountant exports the old system as ten workbooks and uploads them
 * together. A **dry run** reads them, decides everything, writes nothing but
 * its report; **apply** does the same and then, in one transaction:
 *
 *   1. creates the warehouses, items and partners the ERP does not have —
 *      each through the service its screen uses, so the same rules hold
 *      (the partner's code is the old account number, which is how the
 *      accountant knows it);
 *   2. posts the partners' balances as the opening position — one journal
 *      per currency, dated the cut-over, each partner on its control
 *      account, the equity side balancing — under `legacy.opening_balance`;
 *   3. raises one Opening Stock document per warehouse for the positive
 *      quantities, at the latest cost the old books carry, **submitted and
 *      not approved**: the old system's stock figure and the sum of the
 *      latest costs disagree, and which is right is the accountant's
 *      judgement, made on the Opening Stock screen before it posts;
 *   4. keeps every old sale line, purchase line, receipt and payment as
 *      read-only history (`legacy_document`), linked to its partner.
 *
 * Nothing is deleted and a re-run adds only what is missing: the opening
 * journal's source id carries the file set's hash, so the same files post
 * once; the stock documents and the history rows are recognised by their
 * origin. Quantities in the in-transit warehouse and any negative position
 * are not stock — they are listed as "sold, still at sea" for the import
 * applications to tie up (the accountant, 2026-10-02).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessPartner, item as itemTable, journalEntry, legacyDocument, legacyImportRun, openingStock, warehouse } from '../db/schema';
import {
  balanceTotals,
  impliedRate,
  itemCosts,
  nameKey,
  readBooks,
  tbLine,
  type LegacyBooks,
  type LegacyKind,
} from '../domain/legacy-books';
import { NoRateForDateError } from '../domain/exchange-rates';
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity } from '../domain/uom';
import { readWorkbook, XlsxReadError, type SheetRows } from '../xlsx-read';
import { isCompoundFile, readXlsWorkbook } from '../xls-read';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as items from './items';
import * as opening from './opening-stock';
import * as partners from './business-partner';
import * as periods from './periods';
import * as posting from './posting';
import * as rates from './exchange-rates';
import * as warehouses from './warehouses';

export const PERMISSION_OBJECT = 'legacy_import';
export const SOURCE_MODULE = 'legacy';
const EVENT = 'legacy.opening_balance';

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);

export class LegacyImportError extends Error {
  readonly code = 'LEGACY_IMPORT';
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

export interface LegacyFile {
  readonly fileName: string;
  readonly content: Buffer;
}

export interface RunInput {
  readonly files: readonly LegacyFile[];
  /** The day the old books close and the ERP's open — the opening journal's and stock's date. */
  readonly cutOverDate: string;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface LegacyReport {
  readonly mode: 'dry_run' | 'apply';
  readonly runAt: string;
  readonly cutOverDate: string;
  readonly setSha256: string;
  readonly files: readonly { fileName: string; sheets: readonly { sheet: string; kind: LegacyKind; rows: number }[] }[];
  readonly missing: readonly LegacyKind[];
  readonly problems: readonly { fileName: string; sheet: string; row: number; message: string }[];
  /** What stops an apply: no mapping, no rate, a partner whose name disagrees. */
  readonly stops: readonly string[];
  readonly rate: { readonly implied: string | null; readonly erp: string | null };
  readonly partners: {
    readonly create: readonly { code: string; name: string; kind: 'customer' | 'supplier'; phone: string | null }[];
    readonly matched: readonly { code: string; name: string }[];
    readonly conflicts: readonly { code: string; legacyName: string; erpName: string }[];
  };
  readonly balances: {
    readonly lines: readonly { code: string; name: string; kind: 'customer' | 'supplier'; currency: 'IQD' | 'USD'; amount: string }[];
    readonly totals: { customerIqd: string; customerUsd: string; supplierIqd: string; supplierUsd: string };
    readonly tb: { customersIqd: string | null; customersUsd: string | null; suppliersIqd: string | null; suppliersUsd: string | null };
    readonly agrees: boolean;
    readonly journals: readonly { currency: 'IQD' | 'USD'; entryNo: string | null; lines: number; equity: string }[];
  };
  readonly warehouses: { readonly create: readonly string[]; readonly matched: readonly { name: string; code: string }[] };
  readonly items: { readonly create: readonly { name: string; uom: string }[]; readonly matched: readonly { name: string; code: string }[] };
  readonly stock: {
    readonly documents: readonly { warehouse: string; lines: number; units: string; costIqd: string; documentNo: string | null }[];
    readonly noCost: readonly { item: string; warehouse: string; quantity: string }[];
    readonly inTransit: readonly { item: string; warehouse: string; quantity: string }[];
    readonly proposedValueIqd: string;
    readonly tbValueIqd: string | null;
  };
  readonly archive: {
    readonly sales: number;
    readonly purchases: number;
    readonly receipts: number;
    readonly payments: number;
    readonly unmatchedNames: readonly string[];
    readonly unmatchedCodes: readonly string[];
    readonly written: number | null;
  };
  readonly tb: readonly { caption: string; iqd: string | null; usd: string | null; final: string | null }[];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * What "the same set" means: the cells, not the bytes. An export saved
 * twice carries a new timestamp in its properties and the same figures; the
 * dry run the accountant read must still count for the apply she then runs.
 */
export function setHash(books: readonly { fileName: string; workbook: ReadonlyMap<string, SheetRows> }[]): string {
  const hash = createHash('sha256');
  for (const file of [...books].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    hash.update(file.fileName).update('\0');
    for (const [sheet, rows] of [...file.workbook.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      hash.update(sheet).update('\0').update(JSON.stringify(rows)).update('\0');
    }
  }
  return hash.digest('hex');
}

function openWorkbook(file: LegacyFile): ReadonlyMap<string, SheetRows> {
  if (isCompoundFile(file.content)) return readXlsWorkbook(file.content);
  try {
    return readWorkbook(file.content);
  } catch (error) {
    if (error instanceof XlsxReadError) throw new LegacyImportError(`${file.fileName}: ${error.message}`);
    throw error;
  }
}

export function readFiles(files: readonly LegacyFile[]): { books: LegacyBooks; setSha256: string } {
  if (files.length === 0) throw new LegacyImportError('No files were uploaded. Choose the workbooks the old system exported.');
  const opened = files.map((file) => ({ fileName: file.fileName, workbook: openWorkbook(file) }));
  return { books: readBooks(opened), setSha256: setHash(opened) };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

interface PartnerDecision {
  readonly code: string;
  readonly name: string;
  readonly kind: 'customer' | 'supplier';
  readonly phone: string | null;
  readonly existingId: string | null;
  readonly conflict: string | null;
}

interface BalanceLine {
  readonly code: string;
  readonly name: string;
  readonly kind: 'customer' | 'supplier';
  readonly currency: 'IQD' | 'USD';
  readonly amount: bigint;
}

interface StockDocument {
  readonly warehouse: string;
  readonly lines: { item: string; quantity: bigint; unitCostIqd: bigint; uom: string }[];
}

interface Plan {
  readonly books: LegacyBooks;
  readonly partners: readonly PartnerDecision[];
  readonly balanceLines: readonly BalanceLine[];
  readonly warehouseDecisions: readonly { name: string; code: string | null }[];
  readonly itemDecisions: readonly { name: string; code: string | null; uom: string }[];
  readonly stockDocuments: readonly StockDocument[];
  readonly noCost: readonly { item: string; warehouse: string; quantity: bigint }[];
  readonly inTransit: readonly { item: string; warehouse: string; quantity: bigint }[];
  readonly legacyRate: bigint | null;
  readonly stops: string[];
  readonly report: LegacyReport;
}

const IN_TRANSIT = /قيد الشحن|transit|at sea/i;

async function decide(tx: Tx, ctx: ActorContext, books: LegacyBooks, input: RunInput, setSha256: string, mode: 'dry_run' | 'apply'): Promise<Plan> {
  const stops: string[] = [];
  const present = new Set(books.files.flatMap((f) => f.sheets.map((s) => s.kind)));
  const missing = (['customers', 'balances', 'warehouses', 'sales', 'receipts', 'payments', 'accounts', 'suppliers', 'purchases', 'materials'] as const).filter((k) => !present.has(k));
  for (const kind of ['customers', 'balances', 'warehouses'] as const) {
    if (!present.has(kind)) stops.push(`The ${kind} workbook is missing; the import needs it.`);
  }

  // Partners: one per old account number; a supplier who is also a customer is both.
  const byCode = new Map<string, { name: string; phone: string | null; customer: boolean; supplier: boolean; balanceIqd: bigint; balanceUsd: bigint }>();
  for (const p of books.partners) {
    const current = byCode.get(p.code);
    byCode.set(p.code, {
      name: current?.name ?? p.name,
      phone: current?.phone ?? p.phone,
      customer: (current?.customer ?? false) || p.kind === 'customer',
      supplier: (current?.supplier ?? false) || p.kind === 'supplier',
      balanceIqd: p.kind === 'supplier' ? p.balanceIqd : (current?.balanceIqd ?? p.balanceIqd),
      balanceUsd: p.kind === 'supplier' ? p.balanceUsd : (current?.balanceUsd ?? p.balanceUsd),
    });
  }
  const existing = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner);
  const existingByCode = new Map(existing.map((e) => [e.code.toUpperCase(), e]));
  const partnerDecisions: PartnerDecision[] = [];
  for (const [code, p] of byCode) {
    const found = existingByCode.get(code.toUpperCase());
    const kind = p.supplier && !p.customer ? 'supplier' : 'customer';
    const conflict = found && nameKey(found.name) !== nameKey(p.name) ? found.name : null;
    partnerDecisions.push({ code, name: p.name, kind, phone: p.phone, existingId: found?.id ?? null, conflict });
    if (conflict) stops.push(`Account ${code} is "${p.name}" in the old books and "${conflict}" in the ERP; rename one before importing.`);
  }

  // Balances: customers from the balances workbook, suppliers from their own file.
  const balanceLines: BalanceLine[] = [];
  const kinds = new Map(partnerDecisions.map((d) => [d.code, d.kind] as const));
  const names = new Map(partnerDecisions.map((d) => [d.code, d.name] as const));
  for (const b of books.balances) {
    if (b.balance === 0n) continue;
    const kind = kinds.get(b.code);
    if (!kind) {
      stops.push(`Balance row ${b.row} names account ${b.code}, which is in no partner file.`);
      continue;
    }
    if (kind === 'supplier') continue;
    balanceLines.push({ code: b.code, name: names.get(b.code) ?? b.name, kind, currency: b.currency, amount: b.balance });
  }
  for (const [code, p] of byCode) {
    if (!p.supplier || p.customer) continue;
    if (p.balanceIqd !== 0n) balanceLines.push({ code, name: p.name, kind: 'supplier', currency: 'IQD', amount: p.balanceIqd });
    if (p.balanceUsd !== 0n) balanceLines.push({ code, name: p.name, kind: 'supplier', currency: 'USD', amount: p.balanceUsd });
  }
  const totals = { customerIqd: 0n, customerUsd: 0n, supplierIqd: 0n, supplierUsd: 0n };
  for (const line of balanceLines) {
    const key = `${line.kind}${line.currency === 'IQD' ? 'Iqd' : 'Usd'}` as keyof typeof totals;
    totals[key] += line.amount;
  }
  void balanceTotals;
  const tbCustomers = tbLine(books, 'customers');
  const tbSuppliers = tbLine(books, 'suppliers');
  const agrees =
    (tbCustomers?.iqd ?? null) === null
      ? false
      : tbCustomers!.iqd === totals.customerIqd &&
        (tbCustomers!.usd ?? 0n) === totals.customerUsd &&
        (tbSuppliers?.iqd ?? 0n) === totals.supplierIqd;

  // The dollar balances post in dinars — the ledger is kept in IQD and every
  // account carries one currency (§2.3) — at the rate the old books carried
  // them at, which their trial balance implies (final = IQD + USD × rate).
  // The ERP's own rate on the cut-over day is shown beside it: when the two
  // agree, the USD reading of each statement is the old figure to the cent.
  let erpRate: string | null = null;
  const usdLines = balanceLines.filter((l) => l.currency === 'USD');
  const implied = impliedRate(books);
  let legacyRate: bigint | null = implied;
  try {
    const resolved = await rates.rateOn(tx, 'USD', input.cutOverDate);
    erpRate = toDecimalString(resolved.iqdPerUnit, 8n);
    if (legacyRate === null) legacyRate = resolved.iqdPerUnit / 10n ** 4n;
  } catch {
    if (usdLines.length > 0 && legacyRate === null) {
      stops.push(`No USD rate: the old trial balance does not imply one and none is in force on ${input.cutOverDate} (Finance → Exchange Rates).`);
    }
  }

  // The mapping the opening journal posts through, and whether the journal
  // would post: the engine's own plan is asked, which checks the mapping,
  // the accounts' currency, their postability — without writing. The partner
  // dimension is left off here because the partners may not exist yet; it
  // is checked by the write itself.
  const rules = (await tx.execute(sql`select line_role from posting_rule where event_type = ${EVENT} and is_active`)).rows as { line_role: string }[];
  for (const role of ['customer_receivable', 'supplier_payable', 'opening_balance']) {
    if (!rules.some((r) => r.line_role === role)) stops.push(`Posting Mappings has no account for "${role}" on "Legacy books — opening balances" (Finance → Posting Mappings).`);
  }
  try {
    await periods.authorisePosting(tx, ctx, { postingDate: input.cutOverDate, documentType: EVENT, allowOverride: false });
  } catch (error) {
    stops.push(`The cut-over date ${input.cutOverDate} cannot be posted to: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stops.some((s) => s.startsWith('Posting Mappings'))) {
    for (const currency of ['IQD', 'USD'] as const) {
      const lines = balanceLines.filter((l) => l.currency === currency);
      if (lines.length === 0) continue;
      try {
        await posting.plan(tx, ctx, {
          eventType: EVENT,
          source: { module: SOURCE_MODULE, documentId: `plan-${currency}`, event: 'dry_run' },
          branchCode: ctx.branchCode,
          documentDate: input.cutOverDate,
          postingDate: input.cutOverDate,
          lines: journalLines(lines, currency, legacyRate ?? 0n, { withPartner: false }),
        });
      } catch (error) {
        if (!(error instanceof NoRateForDateError)) {
          stops.push(`The ${currency} opening journal would not post: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // Warehouses and items, by name.
  const existingWarehouses = await tx.select({ code: warehouse.code, name: warehouse.name }).from(warehouse);
  const warehouseByName = new Map(existingWarehouses.map((w) => [nameKey(w.name), w.code]));
  const warehouseNames = [...new Set(books.positions.map((p) => p.warehouse))];
  const warehouseDecisions = warehouseNames.map((name) => ({ name, code: warehouseByName.get(nameKey(name)) ?? null }));

  const existingItems = await tx.select({ code: itemTable.code, name: itemTable.name }).from(itemTable);
  const itemByName = new Map(existingItems.map((i) => [nameKey(i.name), i.code]));
  const costs = itemCosts(books);
  const itemNames = [...new Set(books.positions.map((p) => p.item))];
  const itemDecisions = itemNames.map((name) => ({ name, code: itemByName.get(nameKey(name)) ?? null, uom: costs.get(nameKey(name))?.uom ?? 'EA' }));

  // Stock: positive positions outside the in-transit warehouse, one document per warehouse.
  const stockByWarehouse = new Map<string, StockDocument>();
  const noCost: { item: string; warehouse: string; quantity: bigint }[] = [];
  const inTransit: { item: string; warehouse: string; quantity: bigint }[] = [];
  for (const position of books.positions) {
    if (position.quantity === 0n) continue;
    if (position.quantity < 0n || IN_TRANSIT.test(position.warehouse)) {
      inTransit.push({ item: position.item, warehouse: position.warehouse, quantity: position.quantity });
      continue;
    }
    const cost = costs.get(nameKey(position.item));
    if (cost?.unitCost === null || cost?.unitCost === undefined) noCost.push({ item: position.item, warehouse: position.warehouse, quantity: position.quantity });
    const doc = stockByWarehouse.get(position.warehouse) ?? { warehouse: position.warehouse, lines: [] };
    doc.lines.push({ item: position.item, quantity: position.quantity, unitCostIqd: cost?.unitCost ?? 0n, uom: cost?.uom ?? 'EA' });
    stockByWarehouse.set(position.warehouse, doc);
  }
  const stockDocuments = [...stockByWarehouse.values()];
  // A warehouse with nothing to open (the in-transit one, or one that is empty) is not created.
  const opened = new Set(stockDocuments.map((d) => d.warehouse));
  const warehousesToCreate = warehouseDecisions.filter((w) => w.code || opened.has(w.name));
  const costOf = (quantity: bigint, unitCost: bigint) => (quantity * unitCost) / 10n ** 6n;
  const proposedValue = stockDocuments.reduce((n, d) => n + d.lines.reduce((m, l) => m + costOf(l.quantity, l.unitCostIqd), 0n), 0n);

  // The history: who each old line belongs to.
  const partnerByName = new Map(partnerDecisions.map((d) => [nameKey(d.name), d.code]));
  const unmatchedNames = new Set<string>();
  for (const s of books.sales) if (s.customerName && !partnerByName.has(nameKey(s.customerName))) unmatchedNames.add(s.customerName);
  for (const p of books.purchases) if (p.supplierName && !partnerByName.has(nameKey(p.supplierName))) unmatchedNames.add(p.supplierName);
  const unmatchedCodes = new Set<string>();
  for (const v of books.vouchers) if (v.code && !kinds.has(v.code)) unmatchedCodes.add(v.code);

  const report: LegacyReport = {
    mode,
    runAt: new Date().toISOString(),
    cutOverDate: input.cutOverDate,
    setSha256,
    files: books.files,
    missing,
    problems: books.problems,
    stops,
    rate: { implied: legacyRate === null ? null : money(legacyRate), erp: erpRate },
    partners: {
      create: partnerDecisions.filter((d) => !d.existingId).map((d) => ({ code: d.code, name: d.name, kind: d.kind, phone: d.phone })),
      matched: partnerDecisions.filter((d) => d.existingId && !d.conflict).map((d) => ({ code: d.code, name: d.name })),
      conflicts: partnerDecisions.filter((d) => d.conflict).map((d) => ({ code: d.code, legacyName: d.name, erpName: d.conflict! })),
    },
    balances: {
      lines: balanceLines.map((l) => ({ code: l.code, name: l.name, kind: l.kind, currency: l.currency, amount: money(l.amount) })),
      totals: { customerIqd: money(totals.customerIqd), customerUsd: money(totals.customerUsd), supplierIqd: money(totals.supplierIqd), supplierUsd: money(totals.supplierUsd) },
      tb: {
        customersIqd: tbCustomers?.iqd === null || tbCustomers?.iqd === undefined ? null : money(tbCustomers.iqd),
        customersUsd: tbCustomers?.usd === null || tbCustomers?.usd === undefined ? null : money(tbCustomers.usd),
        suppliersIqd: tbSuppliers?.iqd === null || tbSuppliers?.iqd === undefined ? null : money(tbSuppliers.iqd),
        suppliersUsd: tbSuppliers?.usd === null || tbSuppliers?.usd === undefined ? null : money(tbSuppliers.usd),
      },
      agrees,
      journals: (['IQD', 'USD'] as const)
        .filter((currency) => balanceLines.some((l) => l.currency === currency))
        .map((currency) => {
          const lines = balanceLines.filter((l) => l.currency === currency);
          const net = lines.reduce((n, l) => n + l.amount, 0n);
          return { currency, entryNo: null, lines: lines.length + (net === 0n ? 0 : 1), equity: money(toIqd(net, currency, legacyRate ?? 0n)) };
        }),
    },
    warehouses: {
      create: warehousesToCreate.filter((w) => !w.code).map((w) => w.name),
      matched: warehousesToCreate.filter((w) => w.code).map((w) => ({ name: w.name, code: w.code! })),
    },
    items: {
      create: itemDecisions.filter((i) => !i.code).map((i) => ({ name: i.name, uom: i.uom })),
      matched: itemDecisions.filter((i) => i.code).map((i) => ({ name: i.name, code: i.code! })),
    },
    stock: {
      documents: stockDocuments.map((d) => ({
        warehouse: d.warehouse,
        lines: d.lines.length,
        units: formatQuantity(d.lines.reduce((n, l) => n + l.quantity, 0n)),
        costIqd: money(d.lines.reduce((n, l) => n + costOf(l.quantity, l.unitCostIqd), 0n)),
        documentNo: null,
      })),
      noCost: noCost.map((n) => ({ item: n.item, warehouse: n.warehouse, quantity: formatQuantity(n.quantity) })),
      inTransit: inTransit.map((n) => ({ item: n.item, warehouse: n.warehouse, quantity: formatQuantity(n.quantity) })),
      proposedValueIqd: money(proposedValue),
      tbValueIqd: tbLine(books, 'stock')?.iqd === null || tbLine(books, 'stock')?.iqd === undefined ? null : money(tbLine(books, 'stock')!.iqd!),
    },
    archive: {
      sales: books.sales.length,
      purchases: books.purchases.length,
      receipts: books.vouchers.filter((v) => v.kind === 'receipt').length,
      payments: books.vouchers.filter((v) => v.kind === 'payment').length,
      unmatchedNames: [...unmatchedNames].sort(),
      unmatchedCodes: [...unmatchedCodes].sort(),
      written: null,
    },
    tb: books.accounts.map((a) => ({ caption: a.caption, iqd: a.iqd === null ? null : money(a.iqd), usd: a.usd === null ? null : money(a.usd), final: a.final === null ? null : money(a.final) })),
  };

  return { books, partners: partnerDecisions, balanceLines, warehouseDecisions: warehousesToCreate, itemDecisions, stockDocuments, noCost, inTransit, legacyRate, stops, report };
}

/** A balance in dinars: as it is, or the dollars at the old books' rate (scaled MONEY_SCALE), half up. */
function toIqd(amount: bigint, currency: 'IQD' | 'USD', rate: bigint): bigint {
  return currency === 'IQD' ? amount : divideHalfUp(amount * rate, 10n ** MONEY_SCALE);
}

/** The posting lines of one currency's opening journal, in dinars: each partner, then the equity side. */
function journalLines(lines: readonly BalanceLine[], currency: 'IQD' | 'USD', rate: bigint, options: { withPartner: boolean }) {
  let net = 0n;
  const requested = lines.map((l) => {
    const iqd = toIqd(l.amount, currency, rate);
    net += iqd;
    const amount = money(iqd < 0n ? -iqd : iqd);
    const side = iqd > 0n ? 'debit' : 'credit';
    return {
      role: l.kind === 'customer' ? 'customer_receivable' : 'supplier_payable',
      [side]: amount,
      ...(options.withPartner ? { dimensions: { business_partner: l.code } } : {}),
      description:
        currency === 'USD'
          ? `Opening balance ${l.code} ${l.name} — USD ${money(l.amount)} at ${money(rate)}`
          : `Opening balance ${l.code} ${l.name}`,
    };
  });
  if (net === 0n) return requested;
  return [
    ...requested,
    {
      role: 'opening_balance',
      [net > 0n ? 'credit' : 'debit']: money(net < 0n ? -net : net),
      description: currency === 'USD' ? `Opening balances from the old books — dollar accounts at ${money(rate)}` : 'Opening balances from the old books',
    },
  ];
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function recordRun(tx: Tx, ctx: ActorContext, input: RunInput, setSha256: string, report: LegacyReport): Promise<string> {
  const [row] = await tx
    .insert(legacyImportRun)
    .values({
      mode: report.mode,
      fileNames: input.files.map((f) => f.fileName),
      setSha256,
      cutOverDate: input.cutOverDate,
      report,
      runBy: ctx.principal.userId,
    })
    .returning({ id: legacyImportRun.id });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `legacy_import.${report.mode}`,
    objectType: 'legacy_import_run',
    objectId: row!.id,
    branchCode: ctx.branchCode,
    outcome: 'success',
    after: { files: input.files.map((f) => f.fileName), cutOverDate: input.cutOverDate, stops: report.stops.length, setSha256 },
    requestId: ctx.requestId ?? null,
  });
  return row!.id;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new LegacyImportError('The cut-over date must be a day, written YYYY-MM-DD.');
  }
}

export async function dryRun(tx: Tx, ctx: ActorContext, input: RunInput): Promise<LegacyReport> {
  await authz.authorize(ctx.principal, 'import', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  assertDate(input.cutOverDate);
  const { books, setSha256 } = readFiles(input.files);
  const plan = await decide(tx, ctx, books, input, setSha256, 'dry_run');
  await recordRun(tx, ctx, input, setSha256, plan.report);
  return plan.report;
}

export async function apply(tx: Tx, ctx: ActorContext, input: RunInput): Promise<LegacyReport> {
  await authz.authorize(ctx.principal, 'import', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  assertDate(input.cutOverDate);
  const { books, setSha256 } = readFiles(input.files);

  // Apply follows a dry run of the same files: the accountant has read what
  // will happen before it happens.
  const [rehearsed] = await tx
    .select({ id: legacyImportRun.id })
    .from(legacyImportRun)
    .where(and(eq(legacyImportRun.setSha256, setSha256), eq(legacyImportRun.mode, 'dry_run')))
    .limit(1);
  if (!rehearsed) throw new LegacyImportError('These files have not been dry-run. Run the dry run first and read its report.');

  const plan = await decide(tx, ctx, books, input, setSha256, 'apply');
  if (plan.stops.length > 0) {
    throw new LegacyImportError(`The import cannot be applied yet: ${plan.stops[0]}${plan.stops.length > 1 ? ` (and ${plan.stops.length - 1} more — see the dry run)` : ''}`);
  }

  // 1. Warehouses, items, partners — through their own services.
  const warehouseCodes = new Map<string, string>();
  for (const w of plan.warehouseDecisions) {
    if (w.code) {
      warehouseCodes.set(w.name, w.code);
      continue;
    }
    const created = await warehouses.create(tx, ctx, { name: w.name });
    warehouseCodes.set(w.name, created.code);
  }
  const itemCodes = new Map<string, string>();
  for (const i of plan.itemDecisions) {
    if (i.code) {
      itemCodes.set(i.name, i.code);
      continue;
    }
    const created = await items.create(tx, ctx, { name: i.name, isStock: true, baseUomCode: i.uom, tracking: 'batch' });
    itemCodes.set(i.name, created.code);
  }
  const partnerIds = new Map<string, string>();
  let partnersCreated = 0;
  for (const p of plan.partners) {
    if (p.existingId) {
      partnerIds.set(p.code, p.existingId);
      continue;
    }
    const created = await partners.createPartner(tx, ctx, {
      code: p.code,
      legalName: p.name,
      isCustomer: p.kind === 'customer',
      isSupplier: p.kind === 'supplier',
      status: 'active',
      phone: p.phone,
      confirmedNotDuplicate: true,
    });
    partnerIds.set(p.code, created.id);
    partnersCreated += 1;
  }

  // 2. The opening position, one journal per currency.
  const journals: { currency: 'IQD' | 'USD'; entryNo: string | null; lines: number; equity: string }[] = [];
  for (const currency of ['IQD', 'USD'] as const) {
    const lines = plan.balanceLines.filter((l) => l.currency === currency);
    if (lines.length === 0) continue;
    const rate = plan.legacyRate ?? 0n;
    const net = lines.reduce((n, l) => n + toIqd(l.amount, currency, rate), 0n);
    const requested = journalLines(lines, currency, rate, { withPartner: true });
    const result = await posting.post(tx, ctx, {
      eventType: EVENT,
      source: { module: SOURCE_MODULE, documentId: `opening-${currency}-${setSha256.slice(0, 12)}`, event: 'applied' },
      branchCode: ctx.branchCode,
      documentDate: input.cutOverDate,
      postingDate: input.cutOverDate,
      description:
        currency === 'USD'
          ? `Legacy books — opening balances of the dollar accounts at ${money(rate)}, cut-over ${input.cutOverDate}`
          : `Legacy books — opening balances, cut-over ${input.cutOverDate}`,
      lines: requested,
    });
    journals.push({ currency, entryNo: result.entryNo, lines: requested.length, equity: money(net) });
  }

  // 3. Opening stock, raised for the accountant to cost and approve.
  const documents: { warehouse: string; lines: number; units: string; costIqd: string; documentNo: string | null }[] = [];
  for (const doc of plan.stockDocuments) {
    const warehouseCode = warehouseCodes.get(doc.warehouse)!;
    const description = `Legacy books ${setSha256.slice(0, 12)} — ${doc.warehouse}`;
    const [already] = await tx
      .select({ documentNo: openingStock.documentNo })
      .from(openingStock)
      .where(and(eq(openingStock.warehouseCode, warehouseCode), eq(openingStock.description, description)))
      .limit(1);
    const units = formatQuantity(doc.lines.reduce((n, l) => n + l.quantity, 0n));
    const costIqd = money(doc.lines.reduce((n, l) => n + (l.quantity * l.unitCostIqd) / 10n ** 6n, 0n));
    if (already) {
      documents.push({ warehouse: doc.warehouse, lines: doc.lines.length, units, costIqd, documentNo: already.documentNo });
      continue;
    }
    const raised = await opening.raise(tx, ctx, {
      branchCode: ctx.branchCode,
      warehouseCode,
      documentDate: input.cutOverDate,
      description,
      lines: doc.lines.map((l) => ({
        itemCode: itemCodes.get(l.item)!,
        quantity: l.quantity,
        uomCode: l.uom,
        unitCostIqd: l.unitCostIqd,
        costLayerDate: input.cutOverDate,
      })),
    });
    documents.push({ warehouse: doc.warehouse, lines: doc.lines.length, units, costIqd, documentNo: raised.documentNo });
  }

  // 4. The history.
  const runReport: LegacyReport = {
    ...plan.report,
    balances: { ...plan.report.balances, journals },
    stock: { ...plan.report.stock, documents },
  };
  const runId = await recordRun(tx, ctx, input, setSha256, runReport);
  const partnerByName = new Map(plan.partners.map((d) => [nameKey(d.name), d.code]));
  const fileOf = (kind: LegacyKind) => books.files.find((f) => f.sheets.some((s) => s.kind === kind))?.fileName ?? kind;
  const rows: (typeof legacyDocument.$inferInsert)[] = [];
  const lineCounters = new Map<string, number>();
  const nextLine = (key: string) => {
    const n = (lineCounters.get(key) ?? 0) + 1;
    lineCounters.set(key, n);
    return n;
  };
  const q = (v: bigint | null) => (v === null ? null : formatQuantity(v));
  const m = (v: bigint | null) => (v === null ? null : money(v));
  for (const s of books.sales) {
    const code = partnerByName.get(nameKey(s.customerName)) ?? null;
    rows.push({
      kind: 'sale', legacyNo: s.listNo || `row-${s.row}`, lineNo: nextLine(`sale:${s.listNo}`), legacyAccountNo: code,
      partyName: s.customerName || '—', partnerId: code ? (partnerIds.get(code) ?? null) : null, documentDate: null,
      itemName: s.item || null, quantity: q(s.quantity), unit: s.unit || null, unitCostIqd: m(s.unitCost), unitPriceIqd: m(s.unitPrice),
      amount: m(s.total), currency: 'IQD', operation: null, sourceFile: fileOf('sales'), sourceRow: s.row, importRunId: runId,
    });
  }
  for (const p of books.purchases) {
    const code = partnerByName.get(nameKey(p.supplierName)) ?? null;
    rows.push({
      kind: 'purchase', legacyNo: p.listNo || `row-${p.row}`, lineNo: nextLine(`purchase:${p.listNo}`), legacyAccountNo: code,
      partyName: p.supplierName || '—', partnerId: code ? (partnerIds.get(code) ?? null) : null, documentDate: p.date,
      itemName: p.item || null, quantity: q(p.quantity), unit: p.unit || null, unitCostIqd: m(p.unitPrice), unitPriceIqd: null,
      amount: m(p.total), currency: 'IQD', operation: null, sourceFile: fileOf('purchases'), sourceRow: p.row, importRunId: runId,
    });
  }
  for (const v of books.vouchers) {
    rows.push({
      kind: v.kind, legacyNo: v.voucherNo || `row-${v.row}`, lineNo: 1, legacyAccountNo: v.code || null,
      partyName: v.name || '—', partnerId: v.code ? (partnerIds.get(v.code) ?? null) : null, documentDate: v.date,
      itemName: null, quantity: null, unit: null, unitCostIqd: null, unitPriceIqd: null,
      amount: m(v.amount), currency: v.currency, operation: v.operation || null, sourceFile: fileOf(v.kind === 'receipt' ? 'receipts' : 'payments'), sourceRow: v.row, importRunId: runId,
    });
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const inserted = await tx.insert(legacyDocument).values(rows.slice(i, i + 500)).onConflictDoNothing().returning({ id: legacyDocument.id });
    written += inserted.length;
  }

  const final: LegacyReport = { ...runReport, archive: { ...runReport.archive, written } };
  await tx.update(legacyImportRun).set({ report: final }).where(eq(legacyImportRun.id, runId));
  void partnersCreated;
  return final;
}

/** The runs so far, newest first. */
export async function runs(tx: Tx) {
  return tx
    .select({
      id: legacyImportRun.id,
      mode: legacyImportRun.mode,
      fileNames: legacyImportRun.fileNames,
      cutOverDate: legacyImportRun.cutOverDate,
      report: legacyImportRun.report,
      runAt: legacyImportRun.runAt,
      runBy: sql<string | null>`(select display_name from app_user u where u.id = ${legacyImportRun.runBy})`,
    })
    .from(legacyImportRun)
    .orderBy(desc(legacyImportRun.runAt))
    .limit(20);
}

/** A partner's old documents — what the partner page shows under its registers. */
export async function historyOf(tx: Tx, partnerId: string, limit = 200) {
  return tx
    .select({
      id: legacyDocument.id,
      kind: legacyDocument.kind,
      legacyNo: legacyDocument.legacyNo,
      lineNo: legacyDocument.lineNo,
      documentDate: legacyDocument.documentDate,
      itemName: legacyDocument.itemName,
      quantity: legacyDocument.quantity,
      unit: legacyDocument.unit,
      unitPriceIqd: legacyDocument.unitPriceIqd,
      amount: legacyDocument.amount,
      currency: legacyDocument.currency,
      operation: legacyDocument.operation,
    })
    .from(legacyDocument)
    .where(eq(legacyDocument.partnerId, partnerId))
    .orderBy(desc(legacyDocument.documentDate), desc(legacyDocument.legacyNo), legacyDocument.lineNo)
    .limit(limit);
}

/** Opening journals this module has posted — so a re-import after a reversal is seen. */
export async function openingJournals(tx: Tx) {
  return tx
    .select({ entryNo: journalEntry.entryNo, status: journalEntry.status, sourceDocId: journalEntry.sourceDocId, postingDate: journalEntry.postingDate })
    .from(journalEntry)
    .where(eq(journalEntry.sourceModule, SOURCE_MODULE))
    .orderBy(desc(journalEntry.postingDate));
}

export { parseDecimal };
