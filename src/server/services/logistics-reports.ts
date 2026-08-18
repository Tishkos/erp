/**
 * Logistics reports — Phase 10.9, §11.5 and Appendix D.
 *
 * §11.5: *"Open Jobs; Client Import File Status; Job Revenue; Direct Cost; Gross
 * Margin; Carrier Payables; Client Balances; Delivery Exceptions; Job Documents;
 * Money Transfer and Logistics Cross-Reference."*
 * Appendix D filters: *"Client, job, carrier, route, date."*
 *
 * ── Why nothing here reads a stored total ───────────────────────────────────
 * Every figure is computed from the documents. A cached margin would be a second
 * source of truth, and the first time it disagreed with the G/L the report would
 * be the thing people believed. 10.9's gate is that "job margin in reports equals
 * the G/L result for the same jobs", and the cheapest way to keep that true is to
 * have only one number.
 *
 * ── Data scope ─────────────────────────────────────────────────────────────
 * None of these functions filters by branch, deliberately. Every logistics table
 * carries row-level security keyed on `app_current_branch()`, so a query issued
 * on a scoped connection cannot see another branch's rows however it is written.
 * A hand-written branch filter here would be a second, weaker copy of that rule —
 * and one somebody could forget on the eleventh report.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  logisticsClientImportFile,
  logisticsClientImportFileReference,
  logisticsCarrier,
  logisticsClaim,
  logisticsClientCharge,
  logisticsClientFunding,
  logisticsDeliveryEvidence,
  logisticsJob,
  logisticsJobCost,
  logisticsJobLeg,
  logisticsJobSettlement,
} from '../db/schema';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { carrierPerformance, jobMargin } from '../domain/logistics';

const amount = (value: string | null) => parseDecimal(value ?? '0', MONEY_SCALE);
const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);

export interface ReportFilters {
  readonly clientId?: string;
  readonly jobId?: string;
  readonly carrierCode?: string;
  readonly routeCode?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
}

/** Appendix D's five filters, as one predicate over the job. */
function jobFilter(filters: ReportFilters) {
  const clauses = [
    filters.clientId ? eq(logisticsJob.clientId, filters.clientId) : undefined,
    filters.jobId ? eq(logisticsJob.id, filters.jobId) : undefined,
    filters.routeCode ? eq(logisticsJob.routeCode, filters.routeCode) : undefined,
    filters.fromDate ? sql`${logisticsJob.jobDate} >= ${filters.fromDate}` : undefined,
    filters.toDate ? sql`${logisticsJob.jobDate} <= ${filters.toDate}` : undefined,
    filters.carrierCode
      ? sql`exists (select 1 from logistics_job_leg l
                     where l.job_id = ${logisticsJob.id} and l.carrier_code = ${filters.carrierCode})`
      : undefined,
  ].filter(Boolean);

  return clauses.length > 0 ? and(...(clauses as never[])) : undefined;
}

// ---------------------------------------------------------------------------
// Open Jobs
// ---------------------------------------------------------------------------

export async function openJobs(tx: Tx, filters: ReportFilters = {}) {
  return tx
    .select({
      jobId: logisticsJob.id,
      jobNo: logisticsJob.jobNo,
      status: logisticsJob.status,
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      serviceTypeCode: logisticsJob.serviceTypeCode,
      routeCode: logisticsJob.routeCode,
      jobDate: logisticsJob.jobDate,
      promisedDeliveryDate: logisticsJob.promisedDeliveryDate,
      deliveredOn: logisticsJob.deliveredOn,
      branchCode: logisticsJob.branchCode,
      openLegs: sql<number>`(select count(*)::int from logistics_job_leg l
                              where l.job_id = ${logisticsJob.id}
                                and l.status not in ('completed','cancelled'))`,
    })
    .from(logisticsJob)
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsJob.clientId))
    .where(
      and(
        sql`${logisticsJob.status} not in ('closed','cancelled')`,
        jobFilter(filters) ?? sql`true`,
      ),
    )
    .orderBy(logisticsJob.jobDate, logisticsJob.jobNo);
}

// ---------------------------------------------------------------------------
// Client Import File Status
// ---------------------------------------------------------------------------

export async function importFileStatus(tx: Tx, filters: ReportFilters = {}) {
  return tx
    .select({
      importFileId: logisticsClientImportFile.id,
      fileNo: logisticsClientImportFile.fileNo,
      status: logisticsClientImportFile.status,
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      openedOn: logisticsClientImportFile.openedOn,
      closedOn: logisticsClientImportFile.closedOn,
      originCountry: logisticsClientImportFile.originCountry,
      branchCode: logisticsClientImportFile.branchCode,
      /** How many documents in each module cite this file (§11's cross-reference). */
      logisticsDocuments: sql<number>`(select count(*)::int from logistics_client_import_file_reference r
                                        where r.import_file_id = ${logisticsClientImportFile.id}
                                          and r.module = 'logistics')`,
      otherModuleDocuments: sql<number>`(select count(*)::int from logistics_client_import_file_reference r
                                          where r.import_file_id = ${logisticsClientImportFile.id}
                                            and r.module <> 'logistics')`,
    })
    .from(logisticsClientImportFile)
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsClientImportFile.clientId))
    .where(filters.clientId ? eq(logisticsClientImportFile.clientId, filters.clientId) : sql`true`)
    .orderBy(logisticsClientImportFile.openedOn, logisticsClientImportFile.fileNo);
}

// ---------------------------------------------------------------------------
// Job Revenue, Direct Cost and Gross Margin
// ---------------------------------------------------------------------------

export interface MarginRow {
  readonly jobId: string;
  readonly jobNo: string;
  readonly clientCode: string;
  readonly status: string;
  readonly routeCode: string | null;
  readonly revenueIqd: string;
  readonly directCostIqd: string;
  readonly marginIqd: string;
  readonly marginBasisPoints: number | null;
}

/**
 * §11.3's margin, job by job — posted documents only.
 *
 * Revenue is what the settlement recognised, not what was charged: §11.4
 * recognises on service completion, so an agreed charge that has not been
 * settled is not revenue yet. Cost is the posted direct cost. Both figures are
 * exactly what the G/L holds for the job, which is what makes 10.9's gate
 * checkable rather than merely plausible.
 */
export async function grossMargin(tx: Tx, filters: ReportFilters = {}): Promise<MarginRow[]> {
  const rows = await tx
    .select({
      jobId: logisticsJob.id,
      jobNo: logisticsJob.jobNo,
      clientCode: businessPartner.code,
      status: logisticsJob.status,
      routeCode: logisticsJob.routeCode,
      revenue: sql<string>`(select coalesce(sum(s.recognised_amount), 0)::text
                              from logistics_job_settlement s
                             where s.job_id = ${logisticsJob.id} and s.status = 'posted')`,
      directCost: sql<string>`(select coalesce(sum(c.amount), 0)::text
                                 from logistics_job_cost c
                                where c.job_id = ${logisticsJob.id} and c.status = 'posted')`,
    })
    .from(logisticsJob)
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsJob.clientId))
    .where(jobFilter(filters) ?? sql`true`)
    .orderBy(logisticsJob.jobDate, logisticsJob.jobNo);

  return rows.map((row) => {
    const margin = jobMargin({
      serviceChargeIqd: amount(row.revenue),
      directCostIqd: amount(row.directCost),
    });

    return {
      jobId: row.jobId,
      jobNo: row.jobNo,
      clientCode: row.clientCode,
      status: row.status,
      routeCode: row.routeCode,
      revenueIqd: money(margin.serviceChargeIqd),
      directCostIqd: money(margin.directCostIqd),
      marginIqd: money(margin.marginIqd),
      marginBasisPoints: margin.marginBasisPoints,
    };
  });
}

/** Direct Cost, itemised — §11.5 and Appendix D's "Direct Costs". */
export async function directCosts(tx: Tx, filters: ReportFilters = {}) {
  return tx
    .select({
      costNo: logisticsJobCost.costNo,
      jobNo: logisticsJob.jobNo,
      status: logisticsJobCost.status,
      costDate: logisticsJobCost.costDate,
      costType: logisticsJobCost.costType,
      description: logisticsJobCost.description,
      amount: logisticsJobCost.amount,
      currencyCode: logisticsJobCost.currencyCode,
      settlementMode: logisticsJobCost.settlementMode,
      supplierCode: businessPartner.code,
      legNo: logisticsJobLeg.legNo,
      carrierCode: logisticsJobLeg.carrierCode,
      journalEntryId: logisticsJobCost.journalEntryId,
    })
    .from(logisticsJobCost)
    .innerJoin(logisticsJob, eq(logisticsJob.id, logisticsJobCost.jobId))
    .leftJoin(businessPartner, eq(businessPartner.id, logisticsJobCost.supplierId))
    .leftJoin(logisticsJobLeg, eq(logisticsJobLeg.id, logisticsJobCost.legId))
    .where(jobFilter(filters) ?? sql`true`)
    .orderBy(logisticsJobCost.costDate, logisticsJobCost.costNo);
}

/** Job Revenue — what each settlement recognised, and against what. */
export async function jobRevenue(tx: Tx, filters: ReportFilters = {}) {
  return tx
    .select({
      settlementNo: logisticsJobSettlement.settlementNo,
      jobNo: logisticsJob.jobNo,
      clientCode: businessPartner.code,
      status: logisticsJobSettlement.status,
      settlementDate: logisticsJobSettlement.settlementDate,
      recognisedAmount: logisticsJobSettlement.recognisedAmount,
      fromClearingAmount: logisticsJobSettlement.fromClearingAmount,
      fromReceivableAmount: logisticsJobSettlement.fromReceivableAmount,
      currencyCode: logisticsJobSettlement.currencyCode,
      journalEntryId: logisticsJobSettlement.journalEntryId,
    })
    .from(logisticsJobSettlement)
    .innerJoin(logisticsJob, eq(logisticsJob.id, logisticsJobSettlement.jobId))
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsJob.clientId))
    .where(jobFilter(filters) ?? sql`true`)
    .orderBy(logisticsJobSettlement.settlementDate, logisticsJobSettlement.settlementNo);
}

// ---------------------------------------------------------------------------
// Carrier Payables and carrier performance
// ---------------------------------------------------------------------------

/**
 * What each carrier is owed on logistics jobs — §11.5's Carrier Payables.
 *
 * Only costs settled to A/P appear: a cost paid straight from the bank was never
 * a payable. The figures reconcile to the A/P subledger by construction rather
 * than by agreement — each posted cost credits the `supplier_payable` role with
 * the carrier's Business Partner on the line, and Phase 02's subledger writes
 * itself from those journal lines.
 */
export async function carrierPayables(tx: Tx, filters: ReportFilters = {}) {
  return tx
    .select({
      carrierCode: logisticsCarrier.code,
      carrierName: logisticsCarrier.name,
      supplierCode: businessPartner.code,
      postedPayableIqd: sql<string>`coalesce(sum(${logisticsJobCost.amount})
        filter (where ${logisticsJobCost.status} = 'posted'), 0)::text`,
      draftIqd: sql<string>`coalesce(sum(${logisticsJobCost.amount})
        filter (where ${logisticsJobCost.status} = 'draft'), 0)::text`,
      costCount: sql<number>`count(*)::int`,
    })
    .from(logisticsJobCost)
    .innerJoin(logisticsJob, eq(logisticsJob.id, logisticsJobCost.jobId))
    .innerJoin(logisticsJobLeg, eq(logisticsJobLeg.id, logisticsJobCost.legId))
    .innerJoin(logisticsCarrier, eq(logisticsCarrier.code, logisticsJobLeg.carrierCode))
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsCarrier.businessPartnerId))
    .where(
      and(
        eq(logisticsJobCost.settlementMode, 'supplier_payable'),
        jobFilter(filters) ?? sql`true`,
      ),
    )
    .groupBy(logisticsCarrier.code, logisticsCarrier.name, businessPartner.code)
    .orderBy(logisticsCarrier.code);
}

/** 10.3 — "carrier performance data is captured for the required report". */
export async function carrierPerformanceReport(tx: Tx, filters: ReportFilters = {}) {
  const legs = await tx
    .select({
      carrierCode: logisticsJobLeg.carrierCode,
      plannedArrival: logisticsJobLeg.plannedArrival,
      actualArrival: logisticsJobLeg.actualArrival,
    })
    .from(logisticsJobLeg)
    .innerJoin(logisticsJob, eq(logisticsJob.id, logisticsJobLeg.jobId))
    .where(jobFilter(filters) ?? sql`true`);

  const byCarrier = new Map<string, { plannedArrival: string | null; actualArrival: string | null }[]>();
  for (const leg of legs) {
    const bucket = byCarrier.get(leg.carrierCode) ?? [];
    bucket.push({ plannedArrival: leg.plannedArrival, actualArrival: leg.actualArrival });
    byCarrier.set(leg.carrierCode, bucket);
  }

  return [...byCarrier.entries()]
    .map(([carrierCode, carrierLegs]) => ({
      carrierCode,
      ...carrierPerformance(carrierLegs),
    }))
    .sort((a, b) => a.carrierCode.localeCompare(b.carrierCode));
}

// ---------------------------------------------------------------------------
// Client Balances
// ---------------------------------------------------------------------------

/**
 * §11.5's Client Balances — **logistics only**.
 *
 * 10.4's gate: "client logistics balances are reported separately from money
 * transfer client balances". This function reads `logistics_client_funding` and
 * `logistics_job_settlement` and nothing else; there is no parameter that could
 * widen it to another service, and no column anywhere in Phase 10 that holds a
 * money transfer figure.
 */
export async function clientBalances(tx: Tx, filters: ReportFilters = {}) {
  return tx
    .select({
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      jobNo: logisticsJob.jobNo,
      jobId: logisticsJob.id,
      status: logisticsJob.status,
      fundedIqd: sql<string>`(select coalesce(sum(f.amount), 0)::text
                                from logistics_client_funding f
                               where f.job_id = ${logisticsJob.id} and f.status = 'posted')`,
      recognisedIqd: sql<string>`(select coalesce(sum(s.recognised_amount), 0)::text
                                    from logistics_job_settlement s
                                   where s.job_id = ${logisticsJob.id} and s.status = 'posted')`,
      unbilledChargeIqd: sql<string>`(select coalesce(sum(c.amount), 0)::text
                                        from logistics_client_charge c
                                       where c.job_id = ${logisticsJob.id}
                                         and c.settlement_id is null)`,
    })
    .from(logisticsJob)
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsJob.clientId))
    .where(jobFilter(filters) ?? sql`true`)
    .orderBy(businessPartner.code, logisticsJob.jobNo);
}

// ---------------------------------------------------------------------------
// Delivery Exceptions and Job Documents
// ---------------------------------------------------------------------------

/** §11.5's Delivery Exceptions: open claims and legs that arrived late. */
export async function deliveryExceptions(tx: Tx, filters: ReportFilters = {}) {
  const claims = await tx
    .select({
      kind: sql<string>`'claim'`,
      reference: logisticsClaim.claimNo,
      jobNo: logisticsJob.jobNo,
      carrierCode: logisticsJobLeg.carrierCode,
      claimType: logisticsClaim.claimType,
      status: logisticsClaim.status,
      raisedOn: logisticsClaim.raisedOn,
      estimatedAmount: logisticsClaim.estimatedAmount,
      detail: logisticsClaim.description,
    })
    .from(logisticsClaim)
    .innerJoin(logisticsJob, eq(logisticsJob.id, logisticsClaim.jobId))
    .leftJoin(logisticsJobLeg, eq(logisticsJobLeg.id, logisticsClaim.legId))
    .where(jobFilter(filters) ?? sql`true`)
    .orderBy(logisticsClaim.raisedOn);

  const lateLegs = await tx
    .select({
      kind: sql<string>`'late_leg'`,
      reference: sql<string>`${logisticsJob.jobNo} || ' leg ' || ${logisticsJobLeg.legNo}`,
      jobNo: logisticsJob.jobNo,
      carrierCode: logisticsJobLeg.carrierCode,
      plannedArrival: logisticsJobLeg.plannedArrival,
      actualArrival: logisticsJobLeg.actualArrival,
      status: logisticsJobLeg.status,
    })
    .from(logisticsJobLeg)
    .innerJoin(logisticsJob, eq(logisticsJob.id, logisticsJobLeg.jobId))
    .where(
      and(
        sql`${logisticsJobLeg.plannedArrival} is not null`,
        sql`${logisticsJobLeg.actualArrival} is not null`,
        sql`${logisticsJobLeg.actualArrival} > ${logisticsJobLeg.plannedArrival}`,
        jobFilter(filters) ?? sql`true`,
      ),
    );

  return { claims, lateLegs };
}

/** §11.5's Job Documents: the evidence and shipping papers a job holds. */
export async function jobDocuments(tx: Tx, jobId: string) {
  const evidence = await tx
    .select({
      evidenceType: logisticsDeliveryEvidence.evidenceType,
      attachmentId: logisticsDeliveryEvidence.attachmentId,
      receivedOn: logisticsDeliveryEvidence.receivedOn,
      recordedAt: logisticsDeliveryEvidence.recordedAt,
    })
    .from(logisticsDeliveryEvidence)
    .where(eq(logisticsDeliveryEvidence.jobId, jobId))
    .orderBy(logisticsDeliveryEvidence.evidenceType);

  const transport = await tx
    .select({
      legNo: logisticsJobLeg.legNo,
      carrierCode: logisticsJobLeg.carrierCode,
      transportDocumentNo: logisticsJobLeg.transportDocumentNo,
      status: logisticsJobLeg.status,
    })
    .from(logisticsJobLeg)
    .where(eq(logisticsJobLeg.jobId, jobId))
    .orderBy(logisticsJobLeg.legNo);

  return { evidence, transport };
}

// ---------------------------------------------------------------------------
// Money Transfer and Logistics Cross-Reference — §11.5
// ---------------------------------------------------------------------------

/**
 * One service's figures for the documents it owns on an import file.
 *
 * A module registers a provider; the report calls each one and keeps the answers
 * apart. There is no field on this type, or on the report below, that holds a
 * combined figure — so §11's *"without combining their accounting results"* is
 * a property of the return type rather than a discipline the report author has
 * to remember.
 */
export interface CrossReferenceSide {
  readonly module: string;
  readonly documents: readonly {
    readonly documentType: string;
    readonly documentId: string;
    readonly documentNo: string;
  }[];
  /**
   * Whatever that module reports for those documents, as labelled decimal
   * strings. Null when the module has not been built yet — reported as absent
   * rather than as zero, because zero is a claim and absent is the truth.
   */
  readonly figures: Readonly<Record<string, string>> | null;
}

export type CrossReferenceFigureProvider = (
  tx: Tx,
  documents: readonly { documentType: string; documentId: string; documentNo: string }[],
) => Promise<Record<string, string>>;

const figureProviders = new Map<string, CrossReferenceFigureProvider>();

/**
 * Lets a module supply its own figures for the cross-reference report.
 *
 * Phase 09 calls this at start-up with `'money_transfer'`. Until it does, the
 * transfer side of the report lists the documents and reports its figures as
 * null — which is the honest answer, and keeps 10.1's gate ("the report shows
 * both without netting them") meaningful rather than vacuous.
 */
export function registerCrossReferenceFigures(
  module: string,
  provider: CrossReferenceFigureProvider,
): void {
  figureProviders.set(module, provider);
}

export function clearCrossReferenceFigures(): void {
  figureProviders.clear();
  registerCrossReferenceFigures('logistics', logisticsFigures);
}

/** Logistics' own side: revenue, direct cost, margin and client funding held. */
const logisticsFigures: CrossReferenceFigureProvider = async (tx, documents) => {
  const jobIds = documents
    .filter((d) => d.documentType === 'logistics_job')
    .map((d) => d.documentId);

  if (jobIds.length === 0) {
    return { revenueIqd: '0.0000', directCostIqd: '0.0000', marginIqd: '0.0000', fundedIqd: '0.0000' };
  }

  const [revenue] = await tx
    .select({
      total: sql<string>`coalesce(sum(${logisticsJobSettlement.recognisedAmount}), 0)::text`,
    })
    .from(logisticsJobSettlement)
    .where(
      and(
        inArray(logisticsJobSettlement.jobId, jobIds),
        eq(logisticsJobSettlement.status, 'posted'),
      ),
    );

  const [cost] = await tx
    .select({ total: sql<string>`coalesce(sum(${logisticsJobCost.amount}), 0)::text` })
    .from(logisticsJobCost)
    .where(and(inArray(logisticsJobCost.jobId, jobIds), eq(logisticsJobCost.status, 'posted')));

  const [funded] = await tx
    .select({ total: sql<string>`coalesce(sum(${logisticsClientFunding.amount}), 0)::text` })
    .from(logisticsClientFunding)
    .where(
      and(
        inArray(logisticsClientFunding.jobId, jobIds),
        eq(logisticsClientFunding.status, 'posted'),
      ),
    );

  const margin = jobMargin({
    serviceChargeIqd: amount(revenue!.total),
    directCostIqd: amount(cost!.total),
  });

  return {
    revenueIqd: money(margin.serviceChargeIqd),
    directCostIqd: money(margin.directCostIqd),
    marginIqd: money(margin.marginIqd),
    fundedIqd: money(amount(funded!.total)),
  };
};

registerCrossReferenceFigures('logistics', logisticsFigures);

export interface CrossReferenceReport {
  readonly importFileId: string;
  readonly fileNo: string;
  readonly clientCode: string;
  readonly status: string;
  /**
   * One entry per module, never merged. The absence of a `total` field here is
   * the §11 guarantee: there is nothing to add up.
   */
  readonly sides: readonly CrossReferenceSide[];
}

/**
 * §11.5's Money Transfer and Logistics Cross-Reference.
 *
 * 10.1's gate: "the two remain fully separate in revenue, expense and margin
 * reporting" and "the report shows both without netting them".
 *
 * The report groups the file's references by module and asks each module for its
 * own figures. It never adds across modules, and — more usefully — it *cannot*:
 * the cross-reference table holds no amounts, the return type has no combined
 * field, and each side's figures are a separate object. Somebody who wanted a
 * combined total would have to change three things and would have to mean it.
 */
export async function crossReference(
  tx: Tx,
  importFileId: string,
): Promise<CrossReferenceReport> {
  const [file] = await tx
    .select({
      id: logisticsClientImportFile.id,
      fileNo: logisticsClientImportFile.fileNo,
      status: logisticsClientImportFile.status,
      clientCode: businessPartner.code,
    })
    .from(logisticsClientImportFile)
    .innerJoin(businessPartner, eq(businessPartner.id, logisticsClientImportFile.clientId))
    .where(eq(logisticsClientImportFile.id, importFileId))
    .limit(1);

  if (!file) {
    throw new Error(`No client import file '${importFileId}'.`);
  }

  const references = await tx
    .select({
      module: logisticsClientImportFileReference.module,
      documentType: logisticsClientImportFileReference.documentType,
      documentId: logisticsClientImportFileReference.documentId,
      documentNo: logisticsClientImportFileReference.documentNo,
    })
    .from(logisticsClientImportFileReference)
    .where(eq(logisticsClientImportFileReference.importFileId, importFileId))
    .orderBy(logisticsClientImportFileReference.module, logisticsClientImportFileReference.documentNo);

  const byModule = new Map<string, typeof references>();
  for (const reference of references) {
    const bucket = byModule.get(reference.module) ?? [];
    bucket.push(reference);
    byModule.set(reference.module, bucket);
  }

  const sides: CrossReferenceSide[] = [];
  for (const [module, documents] of [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const provider = figureProviders.get(module);
    sides.push({
      module,
      documents: documents.map((d) => ({
        documentType: d.documentType,
        documentId: d.documentId,
        documentNo: d.documentNo,
      })),
      figures: provider ? await provider(tx, documents) : null,
    });
  }

  return {
    importFileId: file.id,
    fileNo: file.fileNo,
    clientCode: file.clientCode,
    status: file.status,
    sides,
  };
}
