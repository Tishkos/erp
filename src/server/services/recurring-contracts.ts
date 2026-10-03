/**
 * Recurring contracts — REQ-AP-001 §10. The rent is in the system.
 *
 * A contract is the standing agreement; each period it generates one payable
 * of type `recurring`, `generate_days_ahead` before the period starts, and
 * never two — the partial unique on (contract, period_start) is the
 * idempotency, so the daily sweep can run as often as it likes. A lease with
 * `auto_confirm` is its own receipt evidence (D8) and the period opens at
 * stage 2; a metered bill waits for the department.
 *
 * Amendments are dated rows (R3): the amount in force for a period is the
 * newest amendment at or before the period's start, and amending changes
 * future periods only — generated ones stand (A8).
 */
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  payable,
  recurringContract,
  recurringContractAmendment,
} from '../db/schema';
import { PayableValidationError } from '../domain/payables';
import { toDecimalString, parseDecimal, MONEY_SCALE } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as payables from './payables';
import * as ap from './ap-invoice';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, whereOf, type RegisterPage, type RegisterPaging } from './register-page';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'recurring_contract';
const SEQUENCE_KEY = 'RECURRING_CONTRACT';

export class ContractNotFoundError extends Error {
  readonly code = 'CONTRACT_NOT_FOUND';
  constructor(ref: string) {
    super(`No contract '${ref}', or it is outside the branches you may see.`);
    this.name = 'ContractNotFoundError';
  }
}

export class ContractStateError extends Error {
  readonly code = 'CONTRACT_STATE';
  constructor(contractNo: string, detail: string) {
    super(`${contractNo}: ${detail}`);
    this.name = 'ContractStateError';
  }
}

export async function load(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(recurringContract)
    .where(eq(recurringContract.id, id))
    .limit(1);
  if (!row) throw new ContractNotFoundError(id);
  return row;
}

export async function loadByNo(tx: Tx, contractNo: string) {
  const [row] = await tx
    .select()
    .from(recurringContract)
    .where(eq(recurringContract.contractNo, contractNo))
    .limit(1);
  if (!row) throw new ContractNotFoundError(contractNo);
  return row;
}

// ---------------------------------------------------------------------------
// The calendar arithmetic — pure, string dates, no Date drift
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = { monthly: 1, quarterly: 3, yearly: 12 };

function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const zero = (y * 12 + (m - 1)) + months;
  const year = Math.floor(zero / 12);
  const month = (zero % 12) + 1;
  const lastDay = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function addDays(isoDate: string, days: number): string {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface Period {
  readonly start: string;
  /** Inclusive. */
  readonly end: string;
  readonly dueDate: string;
}

/** §10.1 — `day_of_period:<n>` · `days_before_period_start:<n>` · `days_after_invoice:<n>`. */
export function dueDateFor(rule: string, period: { start: string; end: string }): string {
  const [kind, raw] = rule.split(':');
  const n = Number(raw ?? '1');
  switch (kind) {
    case 'day_of_period': {
      const day = String(Math.max(1, n)).padStart(2, '0');
      return `${period.start.slice(0, 8)}${day}`;
    }
    case 'days_before_period_start':
      return addDays(period.start, -n);
    // The landlord invoices; until the invoice exists the period's start
    // stands in, and the invoice's own due date takes over when it posts.
    case 'days_after_invoice':
      return period.start;
    default:
      throw new PayableValidationError('due_rule', `'${rule}' is not a due rule this build knows.`);
  }
}

/** The periods of a contract from its start, in order, while `until` reaches them. */
export function periodsUntil(
  contract: { startDate: string; endDate: string | null; frequency: string; generateDaysAhead: number; dueRule: string },
  until: string,
): Period[] {
  const step = MONTHS[contract.frequency];
  if (!step) {
    throw new PayableValidationError('frequency', `'${contract.frequency}' is not a frequency.`);
  }

  const periods: Period[] = [];
  let start = contract.startDate;
  for (let guard = 0; guard < 600; guard++) {
    if (contract.endDate && start > contract.endDate) break;
    // Generated `generate_days_ahead` before the period starts (§10.2).
    if (addDays(start, -contract.generateDaysAhead) > until) break;
    const end = addDays(addMonths(start, step), -1);
    periods.push({ start, end, dueDate: dueDateFor(contract.dueRule, { start, end }) });
    start = addMonths(start, step);
  }
  return periods;
}

/** The amount in force for a period — the newest amendment at or before it. */
export async function amountFor(tx: Tx, contractId: string, periodStart: string): Promise<string> {
  const [amendment] = await tx
    .select({ amount: recurringContractAmendment.amountPerPeriodTxn })
    .from(recurringContractAmendment)
    .where(
      and(
        eq(recurringContractAmendment.contractId, contractId),
        lte(recurringContractAmendment.effectiveFrom, periodStart),
      ),
    )
    .orderBy(desc(recurringContractAmendment.effectiveFrom), desc(recurringContractAmendment.createdAt))
    .limit(1);
  if (amendment?.amount) return amendment.amount;
  const contract = await load(tx, contractId);
  return contract.amountPerPeriodTxn;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface CreateContractInput {
  readonly supplierId: string;
  readonly departmentCode: string;
  readonly branchCode: string;
  readonly expenseCategoryCode: string;
  readonly description: string;
  readonly currency: string;
  readonly amountPerPeriodTxn: string;
  readonly frequency: 'monthly' | 'quarterly' | 'yearly';
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly dueRule?: string;
  readonly generateDaysAhead?: number;
  readonly autoConfirm?: boolean;
  readonly invoiceExpected?: boolean;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateContractInput,
): Promise<{ id: string; contractNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  // The rule must parse before anything depends on it.
  dueDateFor(input.dueRule ?? 'day_of_period:1', {
    start: input.startDate,
    end: input.startDate,
  });
  parseDecimal(input.amountPerPeriodTxn, MONEY_SCALE);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.startDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(recurringContract)
    .values({
      contractNo: allocated.documentNo,
      supplierId: input.supplierId,
      departmentCode: input.departmentCode,
      branchCode: input.branchCode,
      expenseCategoryCode: input.expenseCategoryCode,
      description: input.description.trim(),
      currency: input.currency,
      amountPerPeriodTxn: input.amountPerPeriodTxn,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      dueRule: input.dueRule ?? 'day_of_period:1',
      generateDaysAhead: input.generateDaysAhead ?? 30,
      autoConfirm: input.autoConfirm ?? false,
      invoiceExpected: input.invoiceExpected ?? true,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: recurringContract.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_contract.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { contractNo: allocated.documentNo, amount: input.amountPerPeriodTxn },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, contractNo: allocated.documentNo };
}

/** §5.2 — a second person activates the standing commitment. */
export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const contract = await load(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: contract.branchCode,
  });
  if (contract.status !== 'draft') {
    throw new ContractStateError(contract.contractNo, 'only a draft can be approved.');
  }
  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (contract.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new ContractStateError(
      contract.contractNo,
      'the person who raised a contract cannot approve it — it is a standing commitment (§5.2).',
    );
  }

  await tx
    .update(recurringContract)
    .set({
      status: 'active',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(recurringContract.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_contract.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: contract.branchCode,
    before: { status: 'draft' },
    after: { status: 'active' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** §10.1 — an amendment is a dated row; the contract's words never change. */
export async function amend(
  tx: Tx,
  ctx: ActorContext,
  input: { contractId: string; effectiveFrom: string; amountPerPeriodTxn?: string | null; note: string },
): Promise<void> {
  const contract = await load(tx, input.contractId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: contract.branchCode,
  });
  if (contract.status !== 'active' && contract.status !== 'draft') {
    throw new ContractStateError(contract.contractNo, 'an ended contract is history.');
  }
  if (!input.note.trim()) {
    throw new PayableValidationError('note', 'an amendment says why, or it is not a record.');
  }
  if (input.amountPerPeriodTxn) parseDecimal(input.amountPerPeriodTxn, MONEY_SCALE);

  await tx.insert(recurringContractAmendment).values({
    contractId: contract.id,
    effectiveFrom: input.effectiveFrom,
    amountPerPeriodTxn: input.amountPerPeriodTxn ?? null,
    note: input.note.trim(),
    createdBy: ctx.principal.userId,
  });

  // Every generated period already has its payable; the amendment reaches the
  // ones still to come (A8). The contract's own payables hear about it.
  const generated = await tx
    .select({ id: payable.id })
    .from(payable)
    .where(and(eq(payable.recurringContractId, contract.id), isNull(payable.cancelledAt)))
    .orderBy(desc(payable.periodStart))
    .limit(1);
  if (generated[0]) {
    await events.record(tx, {
      payableId: generated[0].id,
      eventCode: 'CONTRACT_AMENDED',
      summary: `Contract amended from ${input.effectiveFrom}: ${input.note.trim()}`,
      sourceType: 'recurring_contract',
      sourceId: contract.id,
      sourceNo: contract.contractNo,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_contract.amended',
    objectType: PERMISSION_OBJECT,
    objectId: contract.id,
    branchCode: contract.branchCode,
    after: { effectiveFrom: input.effectiveFrom, amount: input.amountPerPeriodTxn ?? null },
    reason: input.note.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Ending stops generation after end_date; periods already generated stand (§10.3). */
export async function end(
  tx: Tx,
  ctx: ActorContext,
  input: { contractId: string; endDate: string; reason: string },
): Promise<void> {
  const contract = await load(tx, input.contractId);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: contract.branchCode,
  });
  if (contract.status !== 'active') {
    throw new ContractStateError(contract.contractNo, 'only an active contract ends.');
  }
  if (!input.reason.trim()) {
    throw new PayableValidationError('reason', 'ending a standing commitment states why.');
  }

  await tx
    .update(recurringContract)
    .set({
      status: 'ended',
      endDate: input.endDate,
      endedAt: new Date(),
      endedBy: ctx.principal.userId,
      endReason: input.reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(recurringContract.id, contract.id));

  const latest = await tx
    .select({ id: payable.id })
    .from(payable)
    .where(eq(payable.recurringContractId, contract.id))
    .orderBy(desc(payable.periodStart))
    .limit(1);
  if (latest[0]) {
    await events.record(tx, {
      payableId: latest[0].id,
      eventCode: 'CONTRACT_ENDED',
      summary: `Contract ended ${input.endDate}: ${input.reason.trim()}`,
      sourceType: 'recurring_contract',
      sourceId: contract.id,
      sourceNo: contract.contractNo,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'recurring_contract.ended',
    objectType: PERMISSION_OBJECT,
    objectId: contract.id,
    branchCode: contract.branchCode,
    before: { status: 'active' },
    after: { status: 'ended', endDate: input.endDate },
    reason: input.reason.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// §10.2 — generation. The sweep calls this daily; "now" is the sweep's asOf.
// ---------------------------------------------------------------------------

export interface GenerationResult {
  readonly contractsSeen: number;
  readonly periodsCreated: number;
}

/**
 * One **purchase invoice** per contract per due period, idempotently (D12:
 * expenses are invoices — the rent is the contract's invoice, not a record of
 * its own). The partial unique index on (recurring_contract_id, period_start)
 * makes "once per period" a property of the database, not of this loop.
 *
 * The invoice is raised in the name of the contract's maker (the person who
 * would otherwise type it every month) and goes through `ap.create` like any
 * invoice: numbering, the §15 expense route, posting by the CEO, the journal.
 * D8 — a lease is its own evidence: `auto_confirm` submits it for posting at
 * once; a metered bill (`auto_confirm` off) waits in draft for the department
 * to check the amount against the bill.
 */
export async function generateDue(
  tx: Tx,
  asOf: string,
  actor: { userId: string } | null,
): Promise<GenerationResult> {
  const contracts = await tx
    .select()
    .from(recurringContract)
    .where(eq(recurringContract.status, 'active'))
    .orderBy(asc(recurringContract.contractNo));

  let periodsCreated = 0;

  for (const contract of contracts) {
    const periods = periodsUntil(contract, asOf);
    for (const period of periods) {
      const [existing] = await tx
        .select({ id: apInvoice.id })
        .from(apInvoice)
        .where(
          and(
            eq(apInvoice.recurringContractId, contract.id),
            eq(apInvoice.periodStart, period.start),
          ),
        )
        .limit(1);
      if (existing) continue;

      const amountTxn = await amountFor(tx, contract.id, period.start);
      const label = `${contract.description} — ${period.start.slice(0, 7)}`;
      const converted = await (await import('./exchange-rates')).convertOn(
        tx,
        parseDecimal(amountTxn, MONEY_SCALE),
        contract.currency,
        period.start,
      );

      const makerId = actor?.userId ?? contract.createdBy;
      const principal = await authz.loadPrincipal(tx, makerId);
      const ctx: ActorContext = { principal, branchCode: contract.branchCode };

      const created = await ap.create(tx, ctx, {
        supplierId: contract.supplierId,
        supplierInvoiceNo: `${contract.contractNo}-${period.start.slice(0, 7)}`,
        branchCode: contract.branchCode,
        invoiceDate: period.start,
        dueDate: period.dueDate,
        expenseCategoryCode: contract.expenseCategoryCode,
        nonPoJustification: `Contract ${contract.contractNo} — ${label}`,
        note: label,
        recurringContractId: contract.id,
        periodStart: period.start,
        periodEnd: period.end,
        lines: [
          {
            description: label,
            quantity: 1_000_000n,
            unitPriceIqd: converted.amountIqd,
            isInventory: false,
          },
        ],
      });
      periodsCreated += 1;

      if (contract.autoConfirm) {
        await ap.submit(tx, ctx, created.id);
      }

      await audit.record(tx, {
        actorUserId: actor?.userId ?? null,
        action: 'recurring_contract.period_invoiced',
        objectType: PERMISSION_OBJECT,
        objectId: contract.id,
        branchCode: contract.branchCode,
        after: {
          contractNo: contract.contractNo,
          periodStart: period.start,
          invoiceNo: created.invoiceNo,
          amount: amountTxn,
          currency: contract.currency,
          submitted: contract.autoConfirm,
        },
        outcome: 'success',
      });
    }
  }

  return { contractsSeen: contracts.length, periodsCreated };
}

/** The contract page — header, schedule of generated periods, amendments. */
export async function view(tx: Tx, contractNo: string) {
  const contract = await loadByNo(tx, contractNo);
  const periods = await tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      periodStart: apInvoice.periodStart,
      periodEnd: apInvoice.periodEnd,
      dueDate: apInvoice.dueDate,
      status: apInvoice.status,
      totalIqd: apInvoice.totalIqd,
      settledAmountIqd: apInvoice.settledAmountIqd,
    })
    .from(apInvoice)
    .where(eq(apInvoice.recurringContractId, contract.id))
    .orderBy(asc(apInvoice.periodStart));
  const amendments = await tx
    .select()
    .from(recurringContractAmendment)
    .where(eq(recurringContractAmendment.contractId, contract.id))
    .orderBy(asc(recurringContractAmendment.effectiveFrom));
  return { contract, periods, amendments };
}

export async function list(tx: Tx) {
  return tx
    .select()
    .from(recurringContract)
    .orderBy(asc(recurringContract.contractNo));
}

/** §21.4 — one row per contract, with what the list shows and nothing else. */
export interface ContractListRow {
  readonly id: string;
  readonly contractNo: string;
  readonly supplierName: string;
  readonly departmentCode: string;
  readonly expenseCategoryCode: string;
  readonly categoryName: string | null;
  readonly amountPerPeriodTxn: string;
  readonly currency: string;
  readonly frequency: string;
  readonly status: string;
  readonly nextDue: string | null;
  readonly overduePeriods: number;
}

export interface ContractListFilter extends RegisterPaging {
  readonly status?: string | null;
}

/** HD15 — one page of fifty, by contract number, with the true count. */
export async function listForScreen(
  tx: Tx,
  filter: ContractListFilter = {},
): Promise<RegisterPage<ContractListRow>> {
  const where = whereOf([filter.status ? sql`c.status::text = ${filter.status}` : null]);
  const today = businessToday();
  return registerPage({
    paging: filter,
    count: () => countOf(tx, sql`from recurring_contract c ${where}`),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select c.id,
               c.contract_no as "contractNo",
               bp.legal_name as "supplierName",
               c.department_code as "departmentCode",
               c.expense_category_code as "expenseCategoryCode",
               ec.name as "categoryName",
               c.amount_per_period_txn::text as "amountPerPeriodTxn",
               c.currency,
               c.frequency,
               c.status,
               (select min(i.due_date)::text from ap_invoice i
                 where i.recurring_contract_id = c.id
                   and i.status not in ('settled', 'reversed', 'cancelled')) as "nextDue",
               (select count(*)::int from ap_invoice i
                 where i.recurring_contract_id = c.id
                   and i.due_date < ${today}::date
                   and i.status not in ('settled', 'reversed', 'cancelled')) as "overduePeriods"
          from recurring_contract c
          join business_partner bp on bp.id = c.supplier_id
          left join expense_category ec on ec.code = c.expense_category_code
         ${where}
         order by c.contract_no, c.id
         limit ${limit} offset ${offset}`);
      return result.rows as unknown as ContractListRow[];
    },
  });
}
