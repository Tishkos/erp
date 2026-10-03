/**
 * Migration & go-live — REQ-AP-001 Stage 8 (§24.3, §24.4).
 *
 *   * **The sheet** (`QS_DASHBOARD.xlsx`) — a one-time, re-runnable import,
 *     dry run first. The dry run writes nothing but its report: what would be
 *     created, what is already there, the suppliers it cannot match (never
 *     created for it), the bank mapping, the PDs with no import (a holding list
 *     for the customs officer), the SWIFT dates to verify, the containers it
 *     cannot read, every value changed on the way in, and the §20.1
 *     comparison of the sheet's "Clear?" with the rule. Apply refuses a file
 *     that has not been dry-run, creates what is missing, recomputes every
 *     import's stage (which clears the ones the rule clears), and reports the
 *     ERP's totals beside the sheet's (A20).
 *   * **The four-stage shipments** — each `supplier_shipment` becomes (or
 *     joins) an import application with one B/L and one container
 *     `MIGRATED-<invoice no>` carrying the invoice's lines, at the status its
 *     stage maps to. Stock stays where the ledger has it.
 *   * **Sign-off** — the accountant reads the cleared comparison of an applied
 *     run and signs it off; the signature is the run's, audited.
 *
 * Migrated rows carry `source` = 'sheet_import' / 'shipment_migration' and the
 * sheet row they came from. Nothing is deleted; a re-run adds what is missing.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  appUser,
  bank,
  bankCashAccount,
  billOfLading,
  businessPartner,
  customsPd,
  customsPdStatusHistory,
  payable,
  payableOrderLine,
  payableType,
  payablesMigrationRun,
  paymentApplication,
  paymentMethod,
  port,
  shipmentContainer,
  shipmentContainerLine,
  shipmentContainerStatusHistory,
  supplierShipment,
  warehouse,
} from '../db/schema';
import {
  clearingFromSheet,
  containerStatusOf,
  pdStatusOf,
  readSheets,
  supplierKey,
  type BlRow,
  type ImportRow,
  type SheetImport,
} from '../domain/payables-migration';
import { referenceKey, deriveStage, NO_FACTS } from '../domain/payables';
import { spreadEqually } from '../domain/shipments';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { readWorkbook } from '../xlsx-read';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as payables from './payables';
import * as rateService from './exchange-rates';
import { allocateDocumentNumber } from './numbering';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'payables_migration';
export const SHEET_SOURCE = 'sheet_import';
export const SHIPMENT_SOURCE = 'shipment_migration';
/** The sheet keeps every import in US dollars. */
const SHEET_CURRENCY = 'USD';

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const dec = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);
const today = () => businessToday();
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

export class MigrationError extends Error {
  readonly code = 'PAYABLES_MIGRATION';
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface MigrationReport {
  readonly mode: 'dry_run' | 'apply';
  readonly fileName: string;
  readonly runAt: string;
  readonly counts: Record<string, number>;
  readonly totals: {
    readonly sheet: { invoiced: string; paid: string; applied: string };
    readonly erp: { invoiced: string; paid: string; applied: string } | null;
  };
  readonly suppliers: { matched: { name: string; code: string }[]; unmatched: { name: string; references: string[] }[] };
  readonly banks: { sheet: string; bankCode: string | null; bankName: string | null; accountCode: string | null }[];
  readonly ports: { sheet: string; portCode: string | null }[];
  /** `code` names the reason for the screen's translation; `reason` is the same in English for the log. */
  readonly skippedPayments: {
    row: number;
    reference: string;
    amount: string;
    code: SkipCode;
    name: string | null;
    reason: string;
  }[];
  readonly pdHolding: { row: number; pdNo: string; reference: string; status: string }[];
  readonly verifySwift: { row: number; reference: string; amount: string; applicationDate: string | null }[];
  readonly cleared: {
    readonly ruleCleared: number;
    readonly legacyCleared: number;
    readonly pdWrittenOffNotMarked: string[];
    readonly markedNotPdWrittenOff: string[];
    readonly differences: { reference: string; legacy: boolean; rule: boolean; fullyPaid: boolean; allReceived: boolean; pdsWrittenOff: boolean }[];
  };
  readonly containers: { invalid: { blNo: string; numbers: string[] }[]; withoutContainers: string[]; estimatedBls: number };
  readonly warehouses: { sheet: string; erp: string | null }[];
  readonly fixes: { sheet: string; row: number; field: string; original: string; used: string }[];
  readonly existing: Record<string, number>;
  readonly created: Record<string, number> | null;
  readonly shipments: { migrated: number; linked: number; created: number } | null;
}

export type SkipCode = 'no_dashboard_row' | 'supplier_unmatched' | 'no_bank' | 'no_account' | 'no_swift_method';

interface Lookups {
  readonly suppliers: Map<string, { id: string; code: string; name: string }>;
  readonly banks: { sheet: string; bankCode: string | null; bankName: string | null; accountId: string | null; accountCode: string | null }[];
  readonly ports: Map<string, string | null>;
  readonly swiftMethod: string | null;
  readonly warehouses: Map<string, string>;
}

async function lookups(tx: Tx, data: SheetImport): Promise<Lookups> {
  const partners = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.isSupplier, true));
  const suppliers = new Map(partners.map((p) => [supplierKey(p.name), p] as const));

  const bankRows = await tx.select().from(bank).where(eq(bank.active, true));
  const accounts = await tx
    .select({ id: bankCashAccount.id, code: bankCashAccount.code, bankCode: bankCashAccount.bankCode, currency: bankCashAccount.currency })
    .from(bankCashAccount)
    .where(and(eq(bankCashAccount.active, true), eq(bankCashAccount.accountType, 'bank')))
    .orderBy(asc(bankCashAccount.code));
  const initials = (name: string) =>
    name
      .toUpperCase()
      .split(/\s+/)
      .filter((word) => word && !['OF', 'THE', 'AND'].includes(word))
      .map((word) => word[0])
      .join('');
  const banks = [...new Set(data.payments.map((p) => p.bank).filter((b): b is string => Boolean(b)))].map((sheet) => {
    const token = sheet.toUpperCase().replace(/[^A-Z]/g, '');
    const found = bankRows.find(
      (b) =>
        b.name.toUpperCase().replace(/[^A-Z]/g, '').startsWith(token) ||
        initials(b.name) === token ||
        (b.swiftBic ?? '').startsWith(token),
    );
    const account = found ? accounts.find((a) => a.bankCode === found.code && a.currency === SHEET_CURRENCY) : undefined;
    return {
      sheet,
      bankCode: found?.code ?? null,
      bankName: found?.name ?? null,
      accountId: account?.id ?? null,
      accountCode: account?.code ?? null,
    };
  });

  const portRows = await tx.select().from(port);
  const ports = new Map<string, string | null>();
  for (const name of new Set(data.bls.map((bl) => bl.pod).filter((p): p is string => Boolean(p)))) {
    const token = name.toUpperCase().replace(/[^A-Z]/g, '');
    const found = portRows.find(
      (p) =>
        p.name.toUpperCase().replace(/[^A-Z]/g, '').startsWith(token) ||
        (p.locode ?? '').toUpperCase().includes(token.slice(0, 3)),
    );
    ports.set(name, found?.code ?? null);
  }

  const [method] = await tx
    .select({ code: paymentMethod.code })
    .from(paymentMethod)
    .where(and(eq(paymentMethod.active, true), eq(paymentMethod.confirmationKind, 'swift')))
    .orderBy(asc(paymentMethod.code))
    .limit(1);

  const houses = await tx.select({ code: warehouse.code, name: warehouse.name }).from(warehouse);
  const warehouses = new Map<string, string>();
  for (const house of houses) {
    warehouses.set(house.code.toUpperCase(), house.code);
    warehouses.set(house.name.toUpperCase(), house.code);
  }

  return { suppliers, banks, ports, swiftMethod: method?.code ?? null, warehouses };
}

const sum = (values: readonly string[]) => money(values.reduce((acc, value) => acc + dec(value), 0n));

/** The report a dry run gives, and an apply starts from. */
async function report(tx: Tx, data: SheetImport, mode: 'dry_run' | 'apply', fileName: string): Promise<MigrationReport> {
  const look = await lookups(tx, data);
  const keys = new Set(data.imports.map((row) => row.key));
  const supplierOf = (row: ImportRow) => look.suppliers.get(row.supplierKey) ?? null;

  const matched = new Map<string, { name: string; code: string }>();
  const unmatched = new Map<string, Set<string>>();
  for (const row of data.imports) {
    const found = supplierOf(row);
    if (found) matched.set(found.code, { name: found.name, code: found.code });
    else unmatched.set(row.supplierName, (unmatched.get(row.supplierName) ?? new Set()).add(row.reference));
  }

  const importByKey = new Map(data.imports.map((row) => [row.key, row] as const));
  const skippedPayments: MigrationReport['skippedPayments'] = [];
  for (const payment of data.payments) {
    const owner = importByKey.get(payment.key);
    const bankRow = look.banks.find((b) => b.sheet === payment.bank);
    const skip: { code: SkipCode; name: string | null; reason: string } | null = !owner
      ? { code: 'no_dashboard_row', name: null, reason: 'No dashboard row has this PO / invoice number.' }
      : !supplierOf(owner)
        ? { code: 'supplier_unmatched', name: owner.supplierName, reason: `Supplier "${owner.supplierName}" is not matched.` }
        : !payment.bank
          ? { code: 'no_bank', name: null, reason: 'No bank is named.' }
          : !bankRow?.accountId
            ? {
                code: 'no_account',
                name: bankRow?.bankName ?? payment.bank,
                reason: `No active ${SHEET_CURRENCY} account at ${bankRow?.bankName ?? payment.bank}.`,
              }
            : !look.swiftMethod
              ? { code: 'no_swift_method', name: null, reason: 'No SWIFT payment method is set up.' }
              : null;
    if (skip) skippedPayments.push({ row: payment.row, reference: payment.reference, amount: payment.amount, ...skip });
  }

  const pdHolding = data.pds
    .filter((pd) => !pd.key || !keys.has(pd.key) || !supplierOf(importByKey.get(pd.key)!))
    .map((pd) => ({ row: pd.row, pdNo: pd.pdNo, reference: pd.reference, status: pd.statusLabel }));

  const verifySwift = data.payments
    .filter(
      (p) =>
        !p.swiftDate && data.pds.some((pd) => pd.key === p.key && pdStatusOf(pd.statusLabel) === 'totally_written_off'),
    )
    .map((p) => ({ row: p.row, reference: p.reference, amount: p.amount, applicationDate: p.applicationDate }));

  const differences: MigrationReport['cleared']['differences'] = [];
  let ruleCleared = 0;
  const pdWrittenOffNotMarked: string[] = [];
  const markedNotPdWrittenOff: string[] = [];
  for (const row of data.imports) {
    const verdict = clearingFromSheet(
      row,
      data.payments.filter((p) => p.key === row.key),
      data.pds.filter((p) => p.key === row.key),
      data.bls.filter((b) => b.key === row.key),
    );
    if (verdict.cleared) ruleCleared += 1;
    if (verdict.pdsWrittenOff && !row.legacyCleared) pdWrittenOffNotMarked.push(row.reference);
    if (!verdict.pdsWrittenOff && row.legacyCleared) markedNotPdWrittenOff.push(row.reference);
    if (verdict.cleared !== row.legacyCleared) {
      differences.push({ reference: row.reference, legacy: row.legacyCleared, rule: verdict.cleared, ...verdict });
    }
  }

  const existingPayables = await tx
    .select({ key: payable.supplierReferenceKey })
    .from(payable)
    .where(and(eq(payable.payableTypeCode, 'import'), inArray(payable.supplierReferenceKey, [...keys, '#'])));
  const existingPds = await tx
    .select({ pdNo: customsPd.pdNo })
    .from(customsPd)
    .where(inArray(customsPd.pdNo, [...new Set(data.pds.map((pd) => pd.pdNo)), '#']));
  const existingBls = await tx
    .select({ blNo: billOfLading.blNo })
    .from(billOfLading)
    .where(inArray(billOfLading.blNo, [...new Set(data.bls.map((bl) => bl.blNo)), '#']));
  const existingApps = await tx
    .select({ row: paymentApplication.sourceRow })
    .from(paymentApplication)
    .where(eq(paymentApplication.source, SHEET_SOURCE));

  const detailBls = new Set(data.details.map((d) => d.blNo));
  return {
    mode,
    fileName,
    runAt: new Date().toISOString(),
    counts: {
      imports: data.imports.length,
      payments: data.payments.length,
      pds: data.pds.length,
      bls: data.bls.length,
      containers: data.bls.reduce((n, bl) => n + bl.containers.length, 0),
      details: data.details.length,
      orderLines: data.orders.length,
      notes: data.pending.length,
    },
    totals: {
      sheet: {
        invoiced: sum(data.imports.map((r) => r.amount)),
        paid: sum(data.imports.map((r) => r.sheetPaid)),
        applied: sum(data.imports.map((r) => r.sheetApplied)),
      },
      erp: null,
    },
    suppliers: {
      matched: [...matched.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unmatched: [...unmatched.entries()].map(([name, refs]) => ({ name, references: [...refs] })),
    },
    banks: look.banks.map(({ sheet, bankCode, bankName, accountCode }) => ({ sheet, bankCode, bankName, accountCode })),
    ports: [...look.ports.entries()].map(([sheet, portCode]) => ({ sheet, portCode })),
    skippedPayments,
    pdHolding,
    verifySwift,
    cleared: {
      ruleCleared,
      legacyCleared: data.imports.filter((r) => r.legacyCleared).length,
      pdWrittenOffNotMarked,
      markedNotPdWrittenOff,
      differences,
    },
    containers: {
      invalid: data.bls.filter((bl) => bl.invalidContainers.length > 0).map((bl) => ({ blNo: bl.blNo, numbers: bl.invalidContainers })),
      withoutContainers: data.bls.filter((bl) => bl.containers.length === 0).map((bl) => bl.blNo),
      estimatedBls: data.bls.filter((bl) => !detailBls.has(bl.blNo) && bl.containers.length > 0).length,
    },
    warehouses: [...new Set([...data.warehouseNames, ...data.details.map((d) => d.warehouse).filter((w): w is string => Boolean(w))])].map(
      (name) => ({ sheet: name, erp: look.warehouses.get(name.toUpperCase()) ?? null }),
    ),
    fixes: data.fixes,
    existing: {
      payables: existingPayables.length,
      pds: existingPds.length,
      bls: existingBls.length,
      applications: existingApps.length,
    },
    created: null,
    shipments: null,
  };
}

// ---------------------------------------------------------------------------
// Reading and running
// ---------------------------------------------------------------------------

export function readFile(content: Buffer): SheetImport {
  return readSheets(readWorkbook(content));
}

export const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

export async function dryRun(tx: Tx, ctx: ActorContext, input: { fileName: string; content: Buffer }) {
  await authz.authorize(ctx.principal, 'import', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const data = readFile(input.content);
  const result = await report(tx, data, 'dry_run', input.fileName);
  const [run] = await tx
    .insert(payablesMigrationRun)
    .values({
      mode: 'dry_run',
      fileName: input.fileName,
      fileSha256: sha256(input.content),
      report: result,
      runBy: ctx.principal.userId,
    })
    .returning({ id: payablesMigrationRun.id });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payables_migration.dry_run',
    objectType: PERMISSION_OBJECT,
    objectId: run!.id,
    branchCode: ctx.branchCode,
    after: { fileName: input.fileName, counts: result.counts },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { id: run!.id, report: result };
}

export async function apply(tx: Tx, ctx: ActorContext, input: { fileName: string; content: Buffer; runDate?: string }) {
  await authz.authorize(ctx.principal, 'import', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const hash = sha256(input.content);
  const [dry] = await tx
    .select({ id: payablesMigrationRun.id })
    .from(payablesMigrationRun)
    .where(and(eq(payablesMigrationRun.fileSha256, hash), eq(payablesMigrationRun.mode, 'dry_run')))
    .limit(1);
  if (!dry) {
    throw new MigrationError('Run the dry run of this file first and read its report; only a file that has been dry-run is applied (§24.3).');
  }
  const data = readFile(input.content);
  const base = await report(tx, data, 'apply', input.fileName);
  const look = await lookups(tx, data);
  const runDate = input.runDate ?? today();
  const created = await write(tx, ctx, data, look, runDate);
  // §24.4 — the shipments that existed at the cut-over: the first apply is the
  // cut-over, and a later re-run leaves the four-stage shipments of non-import
  // invoices raised since then where they are (D38).
  const [first] = await tx
    .select({ at: payablesMigrationRun.runAt })
    .from(payablesMigrationRun)
    .where(eq(payablesMigrationRun.mode, 'apply'))
    .orderBy(asc(payablesMigrationRun.runAt))
    .limit(1);
  const shipments = await migrateShipments(tx, ctx, first?.at ?? null);

  // Every import the run touched takes the stage its facts give it — the
  // ones §20.1 clears are cleared here, in this transaction.
  for (const id of new Set([...created.touched, ...shipments.touched])) {
    await payables.recomputeStage(tx, id, ctx.principal.userId);
  }

  const erp = await erpTotals(tx, data.imports.map((row) => row.key));
  const result: MigrationReport = {
    ...base,
    totals: { ...base.totals, erp },
    created: created.counts,
    shipments: { migrated: shipments.migrated, linked: shipments.linked, created: shipments.created },
  };
  const [run] = await tx
    .insert(payablesMigrationRun)
    .values({ mode: 'apply', fileName: input.fileName, fileSha256: hash, report: result, runBy: ctx.principal.userId })
    .returning({ id: payablesMigrationRun.id });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payables_migration.applied',
    objectType: PERMISSION_OBJECT,
    objectId: run!.id,
    branchCode: ctx.branchCode,
    after: { fileName: input.fileName, created: created.counts, shipments: result.shipments, totals: result.totals },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { id: run!.id, report: result };
}

/** §20.1 — the accountant signs off the cleared comparison of an applied run. */
export async function signOff(tx: Tx, ctx: ActorContext, runId: string, note: string | null) {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const [run] = await tx.select().from(payablesMigrationRun).where(eq(payablesMigrationRun.id, runId)).limit(1);
  if (!run) throw new MigrationError('No such migration run.');
  if (run.mode !== 'apply') throw new MigrationError('A dry run changes nothing; the applied run is the one signed off.');
  if (run.signedOffAt) throw new MigrationError('This run is already signed off.');
  if (run.runBy === ctx.principal.userId) {
    throw new MigrationError('The person who applied the import does not sign off its comparison (§5.2).');
  }
  await tx
    .update(payablesMigrationRun)
    .set({ signedOffBy: ctx.principal.userId, signedOffAt: new Date(), signOffNote: note?.trim() || null })
    .where(eq(payablesMigrationRun.id, runId));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payables_migration.signed_off',
    objectType: PERMISSION_OBJECT,
    objectId: runId,
    branchCode: ctx.branchCode,
    after: { note: note?.trim() || null },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

export async function runs(tx: Tx) {
  return tx
    .select({
      id: payablesMigrationRun.id,
      mode: payablesMigrationRun.mode,
      fileName: payablesMigrationRun.fileName,
      runAt: payablesMigrationRun.runAt,
      runBy: appUser.displayName,
      runById: payablesMigrationRun.runBy,
      signedOffAt: payablesMigrationRun.signedOffAt,
      signOffNote: payablesMigrationRun.signOffNote,
      report: payablesMigrationRun.report,
    })
    .from(payablesMigrationRun)
    .leftJoin(appUser, eq(appUser.id, payablesMigrationRun.runBy))
    .orderBy(desc(payablesMigrationRun.runAt))
    .limit(20);
}

async function erpTotals(tx: Tx, keys: readonly string[]) {
  const listed = sql.join([...keys, '#'].map((key) => sql`${key}`), sql`, `);
  const result = await tx.execute(sql`
    with imports as (
      select id, amount_txn from payable
       where payable_type_code = 'import' and source = ${SHEET_SOURCE}
         and supplier_reference_key in (${listed})
    )
    select (select coalesce(sum(amount_txn), 0) from imports)::text as invoiced,
           (select coalesce(sum(a.amount_txn), 0) from payment_application a
             where a.payable_id in (select id from imports) and a.status in ('confirmed', 'debited'))::text as paid,
           (select coalesce(sum(a.amount_txn), 0) from payment_application a
             where a.payable_id in (select id from imports) and a.status not in ('rejected', 'cancelled'))::text as applied`);
  const row = result.rows[0] as { invoiced: string; paid: string; applied: string };
  return { invoiced: money(dec(row.invoiced)), paid: money(dec(row.paid)), applied: money(dec(row.applied)) };
}

// ---------------------------------------------------------------------------
// Writing — every insert guarded, so a re-run only adds what is missing
// ---------------------------------------------------------------------------

async function write(tx: Tx, ctx: ActorContext, data: SheetImport, look: Lookups, runDate: string) {
  const counts = { payables: 0, orderLines: 0, applications: 0, pds: 0, bls: 0, containers: 0, containerLines: 0, notes: 0 };
  const touched = new Set<string>();
  const [type] = await tx.select().from(payableType).where(eq(payableType.code, 'import')).limit(1);
  if (!type) throw new MigrationError('The import payable type is missing.');
  const rail = await payables.railFor(tx, 'import');
  const openStage = deriveStage(rail, NO_FACTS);
  const usd = async (amount: bigint) => (await rateService.convertOn(tx, amount, SHEET_CURRENCY, runDate)).amountIqd;

  // ── the imports ──────────────────────────────────────────────────────
  const payableByKey = new Map<string, { id: string; payableNo: string; branchCode: string }>();
  for (const row of data.imports) {
    const supplier = look.suppliers.get(row.supplierKey);
    if (!supplier) continue;
    const [existing] = await tx
      .select({ id: payable.id, payableNo: payable.payableNo, branchCode: payable.branchCode, legacyCleared: payable.legacyCleared })
      .from(payable)
      .where(and(eq(payable.supplierReferenceKey, row.key), eq(payable.supplierId, supplier.id), isNull(payable.cancelledAt)))
      .limit(1);
    if (existing) {
      payableByKey.set(row.key, existing);
      if (existing.legacyCleared === null) {
        await tx.update(payable).set({ legacyCleared: row.legacyCleared }).where(eq(payable.id, existing.id));
      }
      continue;
    }
    const documentDate = row.date ?? runDate;
    const amount = dec(row.amount);
    const allocated = await allocateDocumentNumber(
      tx,
      type.numberSeriesKey,
      { branchCode: ctx.branchCode, year: Number(documentDate.slice(0, 4)) },
      ctx.principal.userId,
    );
    const [made] = await tx
      .insert(payable)
      .values({
        payableNo: allocated.documentNo,
        payableTypeCode: 'import',
        supplierReference: row.reference,
        supplierReferenceKey: row.key,
        supplierId: supplier.id,
        branchCode: ctx.branchCode,
        currency: SHEET_CURRENCY,
        amountTxn: money(amount),
        amountIqd: money(await usd(amount)),
        quantity: row.quantity ? formatQuantity(parseQuantity(row.quantity)) : null,
        documentDate,
        description: `${row.products ?? 'Import'} — migrated from the sheet (dashboard row ${row.row})`,
        paymentTermsText: row.terms,
        stageCode: openStage,
        source: SHEET_SOURCE,
        sourceRow: `dashboard!${row.row}`,
        legacyCleared: row.legacyCleared,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: payable.id });
    const created = { id: made!.id, payableNo: allocated.documentNo, branchCode: ctx.branchCode };
    payableByKey.set(row.key, created);
    counts.payables += 1;

    // §24.3 — the Pending Order lines when the order has them; one summary
    // line otherwise.
    const lines = data.orders.filter((order) => order.key === row.key);
    const orderLines = lines.length
      ? lines.map((order) => ({
          description: [order.model, order.specification].filter(Boolean).join(' — '),
          quantity: order.quantity,
          note: order.remarks,
        }))
      : [{ description: row.products ?? 'Goods', quantity: row.quantity, note: null }];
    for (const [index, line] of orderLines.entries()) {
      await tx.insert(payableOrderLine).values({
        payableId: created.id,
        lineNo: index + 1,
        description: line.description,
        quantity: line.quantity ? formatQuantity(parseQuantity(line.quantity)) : null,
        amountTxn: lines.length ? null : money(amount),
      });
      counts.orderLines += 1;
    }
    await events.record(tx, {
      payableId: created.id,
      eventCode: 'PAYABLE_OPENED',
      summary:
        `Migrated from QS_DASHBOARD.xlsx (dashboard row ${row.row}) — ${row.reference}, ${supplier.name}, ` +
        `${SHEET_CURRENCY} ${money(amount)}${row.legacyCleared ? '; the sheet marked it cleared' : ''}`,
      sourceType: SHEET_SOURCE,
      sourceNo: `dashboard!${row.row}`,
      actorUserId: ctx.principal.userId,
    });
    touched.add(created.id);
  }

  // ── PMT → payment applications ──────────────────────────────────────
  for (const payment of data.payments) {
    const owner = payableByKey.get(payment.key);
    const bankRow = look.banks.find((b) => b.sheet === payment.bank);
    if (!owner || !bankRow?.accountId || !look.swiftMethod) continue;
    const sourceRow = `PMT!${payment.row}`;
    const [already] = await tx
      .select({ id: paymentApplication.id })
      .from(paymentApplication)
      .where(and(eq(paymentApplication.source, SHEET_SOURCE), eq(paymentApplication.sourceRow, sourceRow)))
      .limit(1);
    if (already) continue;
    const status = payment.swiftDate ? 'confirmed' : payment.applicationDate ? 'sent' : 'draft';
    const verify =
      !payment.swiftDate &&
      data.pds.some((pd) => pd.key === payment.key && pdStatusOf(pd.statusLabel) === 'totally_written_off');
    const amount = dec(payment.amount);
    const allocated = await allocateDocumentNumber(
      tx,
      'PAYMENT_APPLICATION',
      { branchCode: owner.branchCode, year: Number((payment.applicationDate ?? payment.swiftDate ?? runDate).slice(0, 4)) },
      ctx.principal.userId,
    );
    const [supplierRow] = await tx.select({ supplierId: payable.supplierId }).from(payable).where(eq(payable.id, owner.id)).limit(1);
    const [made] = await tx
      .insert(paymentApplication)
      .values({
        applicationNo: allocated.documentNo,
        payableId: owner.id,
        branchCode: owner.branchCode,
        supplierId: supplierRow!.supplierId,
        paymentMethodCode: look.swiftMethod,
        bankCashAccountId: bankRow.accountId,
        currency: SHEET_CURRENCY,
        amountTxn: money(amount),
        amountIqd: money(await usd(amount)),
        status,
        applicationDate: status === 'draft' ? null : (payment.applicationDate ?? payment.swiftDate),
        confirmedOn: payment.swiftDate,
        confirmationReference: payment.swiftDate ? `Sheet PMT row ${payment.row}` : null,
        confirmedAt: payment.swiftDate ? new Date() : null,
        note: verify
          ? 'Verify the SWIFT date: the PD is totally written off but the sheet shows no SWIFT date (§24.3).'
          : `Migrated from the sheet (PMT row ${payment.row}).`,
        source: SHEET_SOURCE,
        sourceRow,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: paymentApplication.id });
    counts.applications += 1;
    await events.record(tx, {
      payableId: owner.id,
      eventCode: status === 'confirmed' ? 'SWIFT_CONFIRMED' : status === 'sent' ? 'PAYMENT_APPLIED' : 'PAYMENT_DRAFTED',
      summary:
        `${allocated.documentNo} migrated (PMT row ${payment.row}) — ${payment.bank} ${SHEET_CURRENCY} ${money(amount)}` +
        (payment.applicationDate ? `, applied ${payment.applicationDate}` : '') +
        (payment.swiftDate ? `, SWIFT ${payment.swiftDate}` : '') +
        (verify ? ' — verify the SWIFT date' : ''),
      sourceType: 'payment_application',
      sourceId: made!.id,
      sourceNo: allocated.documentNo,
      actorUserId: ctx.principal.userId,
    });
    touched.add(owner.id);
  }

  // ── PD + Pending → customs PDs (unmatched ones in the holding list) ────
  const notesByPd = new Map<string, string[]>();
  for (const row of data.pending) notesByPd.set(row.pdNo, [...(notesByPd.get(row.pdNo) ?? []), row.notes]);
  const bankBySwift = new Map(
    (await tx.select({ code: bank.code, swift: bank.swiftBic }).from(bank)).filter((b) => b.swift).map((b) => [b.swift!, b.code] as const),
  );
  for (const pd of data.pds) {
    const statusCode = pdStatusOf(pd.statusLabel);
    if (!statusCode || !pd.registrationDate) continue;
    const owner = pd.key ? payableByKey.get(pd.key) : undefined;
    const year = Number(pd.registrationDate.slice(0, 4));
    const [already] = await tx
      .select({ id: customsPd.id })
      .from(customsPd)
      .where(and(eq(customsPd.pdNo, pd.pdNo), sql`${customsPd.registrationYear} = ${year}`))
      .limit(1);
    if (already) continue;
    const expiry = pd.expiryDate && pd.expiryDate >= pd.registrationDate ? pd.expiryDate : addDays(pd.registrationDate, 180);
    const notes = [pd.notes, ...(notesByPd.get(pd.pdNo) ?? [])].filter(Boolean).join(' · ') || null;
    const [made] = await tx
      .insert(customsPd)
      .values({
        pdNo: pd.pdNo,
        payableId: owner?.id ?? null,
        branchCode: owner?.branchCode ?? ctx.branchCode,
        registrationDate: pd.registrationDate,
        expiryDate: expiry,
        bankCode: pd.swift ? (bankBySwift.get(pd.swift) ?? null) : null,
        bankSwift: pd.swift,
        statusCode,
        statusDate: pd.registrationDate,
        lastNote: notes,
        source: SHEET_SOURCE,
        sourceRow: `PD!${pd.row}`,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: customsPd.id });
    await tx.insert(customsPdStatusHistory).values({
      pdId: made!.id,
      statusCode,
      effectiveDate: pd.registrationDate,
      source: 'sheet_import',
      note: `As the sheet records it (PD row ${pd.row}): ${pd.statusLabel}`,
      recordedBy: ctx.principal.userId,
    });
    counts.pds += 1;
    if (notes) counts.notes += 1;
    if (owner) {
      await events.record(tx, {
        payableId: owner.id,
        eventCode: 'PD_SUBMITTED',
        summary: `PD ${pd.pdNo} migrated — registered ${pd.registrationDate}, expires ${expiry}, ${pd.statusLabel}`,
        sourceType: 'customs_pd',
        sourceId: made!.id,
        sourceNo: pd.pdNo,
        actorUserId: ctx.principal.userId,
      });
      if (notes) {
        await events.record(tx, {
          payableId: owner.id,
          eventCode: 'PD_NOTE',
          summary: `PD ${pd.pdNo}: ${notes}`,
          sourceType: 'customs_pd',
          sourceId: made!.id,
          sourceNo: pd.pdNo,
          actorUserId: ctx.principal.userId,
        });
      }
      touched.add(owner.id);
    }
  }

  // ── BL + CTN No. + BL Product Detail → B/Ls, containers, their lines ───
  for (const bl of data.bls) {
    const owner = bl.key ? payableByKey.get(bl.key) : undefined;
    if (!owner) continue;
    const importRow = data.imports.find((row) => row.key === bl.key)!;
    let [blRow] = await tx
      .select({ id: billOfLading.id })
      .from(billOfLading)
      .where(eq(billOfLading.blNo, bl.blNo))
      .limit(1);
    if (!blRow) {
      [blRow] = await tx
        .insert(billOfLading)
        .values({
          payableId: owner.id,
          branchCode: owner.branchCode,
          blNo: bl.blNo,
          blDate: bl.blDate ?? importRow.date ?? bl.eta ?? runDate,
          portOfDischargeCode: bl.pod ? (look.ports.get(bl.pod) ?? null) : null,
          eta: bl.eta,
          source: SHEET_SOURCE,
          sourceRow: `BL!${bl.row}`,
          createdBy: ctx.principal.userId,
        })
        .returning({ id: billOfLading.id });
      counts.bls += 1;
      await events.record(tx, {
        payableId: owner.id,
        eventCode: 'BL_ISSUED',
        summary:
          `B/L ${bl.blNo} migrated (BL row ${bl.row})${bl.blDate ? `, issued ${bl.blDate}` : ''}${bl.eta ? `, ETA ${bl.eta}` : ''}` +
          ` — ${bl.containers.length} container(s), ${bl.shippingStatus ?? 'no status'}`,
        sourceType: 'bill_of_lading',
        sourceId: blRow!.id,
        sourceNo: bl.blNo,
        actorUserId: ctx.principal.userId,
      });
      touched.add(owner.id);
    }
    counts.containers += await containersFor(tx, ctx, data, look, bl, blRow!.id, owner, counts);
  }

  return { counts, touched };
}

async function containersFor(
  tx: Tx,
  ctx: ActorContext,
  data: SheetImport,
  look: Lookups,
  bl: BlRow,
  blId: string,
  owner: { id: string; branchCode: string },
  counts: { containerLines: number },
): Promise<number> {
  const statusCode = containerStatusOf(bl.shippingStatus);
  const details = data.details.filter((d) => d.blNo === bl.blNo);
  const shares = spreadEqually(bl.totalQty ? parseQuantity(bl.totalQty) : 0n, bl.containers.length);
  let made = 0;
  for (const [index, containerNo] of bl.containers.entries()) {
    const [already] = await tx
      .select({ id: shipmentContainer.id })
      .from(shipmentContainer)
      .where(and(eq(shipmentContainer.blId, blId), eq(shipmentContainer.containerNo, containerNo)))
      .limit(1);
    if (already) continue;
    const mine = details.filter((d) => d.containers.includes(containerNo));
    const lines = mine.length
      ? mine.map((d) => {
          const parts = spreadEqually(parseQuantity(d.plannedQty), Math.max(1, d.containers.length));
          const at = Math.max(0, d.containers.indexOf(containerNo));
          const inbound = d.inboundQty
            ? spreadEqually(parseQuantity(d.inboundQty), Math.max(1, d.containers.length))[at]!
            : parts[at]!;
          return {
            description: d.model,
            planned: parts[at]!,
            received: inbound,
            warehouseCode: d.warehouse ? (look.warehouses.get(d.warehouse.toUpperCase()) ?? null) : null,
            estimated: d.containers.length > 1,
          };
        })
      : [
          {
            description: bl.category ?? 'Goods',
            planned: shares[index] ?? 0n,
            received: shares[index] ?? 0n,
            warehouseCode: null as string | null,
            estimated: true,
          },
        ];
    const received = statusCode === 'received';
    const atPortOrLater = ['at_port', 'customs_cleared', 'received'].includes(statusCode);
    const [container] = await tx
      .insert(shipmentContainer)
      .values({
        blId,
        payableId: owner.id,
        branchCode: owner.branchCode,
        containerNo,
        statusCode,
        statusDate: bl.eta ?? bl.blDate,
        eta: bl.eta,
        departedOn: statusCode === 'not_loaded' ? null : bl.blDate,
        arrivedPortOn: atPortOrLater ? (bl.eta ?? null) : null,
        portFileSentOn: bl.portFileSentOn,
        receivedOn: received ? (bl.eta ?? bl.blDate ?? today()) : null,
        linesEstimated: lines.some((line) => line.estimated),
        source: SHEET_SOURCE,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: shipmentContainer.id });
    await tx.insert(shipmentContainerStatusHistory).values({
      containerId: container!.id,
      statusCode,
      effectiveDate: bl.eta ?? bl.blDate ?? today(),
      source: 'sheet_import',
      note: `As the sheet records it (BL row ${bl.row}): ${bl.shippingStatus ?? 'no status'}`,
      recordedBy: ctx.principal.userId,
    });
    for (const [n, line] of lines.entries()) {
      await tx.insert(shipmentContainerLine).values({
        containerId: container!.id,
        lineNo: n + 1,
        description: line.description,
        plannedQty: formatQuantity(line.planned),
        receivedQty: received ? formatQuantity(line.received) : null,
        damagedQty: received ? '0' : null,
        shortQty: received ? '0' : null,
        warehouseCode: line.warehouseCode,
        createdBy: ctx.principal.userId,
      });
      counts.containerLines += 1;
    }
    await events.record(tx, {
      payableId: owner.id,
      eventCode: 'CONTAINER_ADDED',
      summary: `${containerNo} migrated on B/L ${bl.blNo} — ${bl.shippingStatus ?? 'not loaded'}${lines.some((l) => l.estimated) ? ' (lines estimated; the warehouse confirms)' : ''}`,
      sourceType: 'shipment_container',
      sourceId: container!.id,
      sourceNo: containerNo,
      actorUserId: ctx.principal.userId,
    });
    made += 1;
  }
  return made;
}

// ---------------------------------------------------------------------------
// §24.4 — the four-stage shipments become containers
// ---------------------------------------------------------------------------

const STAGE_TO_STATUS: Readonly<Record<string, string>> = {
  in_process: 'not_loaded',
  on_board: 'on_sea',
  on_port: 'at_port',
  in_bounded: 'received',
};

export async function migrateShipments(tx: Tx, ctx: ActorContext, cutOver: Date | null = null) {
  const rows = await tx
    .select({ shipment: supplierShipment, invoice: apInvoice })
    .from(supplierShipment)
    .innerJoin(apInvoice, eq(apInvoice.id, supplierShipment.apInvoiceId))
    .where(cutOver ? lte(supplierShipment.createdAt, cutOver) : undefined);
  let migrated = 0;
  let linked = 0;
  let created = 0;
  const touched = new Set<string>();
  const [type] = await tx.select().from(payableType).where(eq(payableType.code, 'import')).limit(1);
  const rail = await payables.railFor(tx, 'import');
  const openStage = deriveStage(rail, NO_FACTS);

  for (const { shipment, invoice } of rows) {
    const containerNo = `MIGRATED-${invoice.invoiceNo}`;
    const [done] = await tx
      .select({ id: shipmentContainer.id })
      .from(shipmentContainer)
      .where(eq(shipmentContainer.containerNo, containerNo))
      .limit(1);
    if (done) continue;

    // The application: the invoice's own, the sheet's (same supplier and
    // number), or a new one born from the invoice.
    let payableId = invoice.payableId;
    if (!payableId) {
      let key: string | null = null;
      try {
        key = referenceKey(invoice.supplierInvoiceNo ?? invoice.invoiceNo);
      } catch {
        key = null;
      }
      const [matched] = key
        ? await tx
            .select({ id: payable.id })
            .from(payable)
            .where(
              and(
                eq(payable.payableTypeCode, 'import'),
                eq(payable.supplierId, invoice.supplierId),
                eq(payable.supplierReferenceKey, key),
                isNull(payable.cancelledAt),
              ),
            )
            .limit(1)
        : [];
      if (matched) {
        payableId = matched.id;
        linked += 1;
      } else {
        const allocated = await allocateDocumentNumber(
          tx,
          type!.numberSeriesKey,
          { branchCode: invoice.branchCode, year: Number(String(invoice.invoiceDate).slice(0, 4)) },
          ctx.principal.userId,
        );
        const total = dec(invoice.totalIqd ?? '0');
        const [made] = await tx
          .insert(payable)
          .values({
            payableNo: allocated.documentNo,
            payableTypeCode: 'import',
            supplierReference: invoice.supplierInvoiceNo || invoice.invoiceNo,
            supplierReferenceKey: key ?? referenceKey(invoice.invoiceNo),
            supplierId: invoice.supplierId,
            branchCode: invoice.branchCode,
            currency: 'IQD',
            amountTxn: money(total),
            amountIqd: money(total),
            documentDate: String(invoice.invoiceDate),
            description: `Purchase invoice ${invoice.invoiceNo} — migrated from its four-stage shipment (§24.4)`,
            stageCode: openStage,
            source: SHIPMENT_SOURCE,
            sourceRow: `supplier_shipment!${shipment.id}`,
            createdBy: ctx.principal.userId,
          })
          .returning({ id: payable.id });
        payableId = made!.id;
        created += 1;
        await events.record(tx, {
          payableId,
          eventCode: 'PAYABLE_OPENED',
          summary: `Opened from purchase invoice ${invoice.invoiceNo} and its four-stage shipment (§24.4)`,
          sourceType: 'ap_invoice',
          sourceId: invoice.id,
          sourceNo: invoice.invoiceNo,
          actorUserId: ctx.principal.userId,
        });
      }
      await tx.update(apInvoice).set({ payableId, isImport: true, updatedAt: new Date() }).where(eq(apInvoice.id, invoice.id));
    }

    const statusCode = STAGE_TO_STATUS[shipment.status] ?? 'not_loaded';
    const received = statusCode === 'received';
    const on = String(shipment.updatedAt.toISOString()).slice(0, 10);
    const [blRow] = await tx
      .insert(billOfLading)
      .values({
        payableId,
        branchCode: invoice.branchCode,
        blNo: `MIGRATED-${invoice.invoiceNo}`,
        blDate: String(invoice.invoiceDate),
        source: SHIPMENT_SOURCE,
        sourceRow: `supplier_shipment!${shipment.id}`,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: billOfLading.id });
    const [container] = await tx
      .insert(shipmentContainer)
      .values({
        blId: blRow!.id,
        payableId,
        branchCode: invoice.branchCode,
        containerNo,
        statusCode,
        statusDate: on,
        departedOn: statusCode === 'not_loaded' ? null : on,
        arrivedPortOn: statusCode === 'at_port' || received ? on : null,
        receivedOn: received ? on : null,
        warehouseCode: received ? shipment.warehouseCode : null,
        source: SHIPMENT_SOURCE,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: shipmentContainer.id });
    await tx.insert(shipmentContainerStatusHistory).values({
      containerId: container!.id,
      statusCode,
      effectiveDate: on,
      source: 'shipment_migration',
      note: `From the four-stage shipment at ${shipment.status.replace('_', ' ')} (§24.4); the stock stays where the ledger has it.`,
      recordedBy: ctx.principal.userId,
    });
    const lines = await tx
      .select()
      .from(apInvoiceLine)
      .where(and(eq(apInvoiceLine.apInvoiceId, invoice.id), eq(apInvoiceLine.isInventory, true)))
      .orderBy(asc(apInvoiceLine.lineNo));
    for (const [n, line] of lines.entries()) {
      await tx.insert(shipmentContainerLine).values({
        containerId: container!.id,
        lineNo: n + 1,
        itemCode: line.itemCode,
        description: line.description,
        plannedQty: line.quantity,
        uomCode: line.uomCode,
        receivedQty: received ? line.quantity : null,
        damagedQty: received ? '0' : null,
        shortQty: received ? '0' : null,
        warehouseCode: received ? shipment.warehouseCode : null,
        createdBy: ctx.principal.userId,
      });
    }
    await events.record(tx, {
      payableId,
      eventCode: 'CONTAINER_ADDED',
      summary: `${containerNo} carries purchase invoice ${invoice.invoiceNo}'s goods, migrated from the four-stage shipment at ${shipment.status.replace('_', ' ')}`,
      sourceType: 'shipment_container',
      sourceId: container!.id,
      sourceNo: containerNo,
      actorUserId: ctx.principal.userId,
    });
    touched.add(payableId);
    migrated += 1;
  }
  return { migrated, linked, created, touched };
}
