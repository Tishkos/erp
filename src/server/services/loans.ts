/**
 * Loans — REQ-AP-001 Stage 6 (§15.6 "Deposit / loan in", "Loan repayment";
 * §15.7; §21.10).
 *
 *     draft ──approve──▶ approved ──disburse──▶ active ──last instalment paid──▶ fully_repaid
 *       └────────── cancel (reason) ───┘
 *
 *   * **create** — the officer enters the bank's offer: principal, commission
 *     and how it is taken, the account the money lands in, the schedule's
 *     shape. The schedule is generated at once and may be retyped until the
 *     loan is approved.
 *   * **approve** — a second person (§5.2); the CEO above the account's
 *     approval limit (§2, a limit nobody has set is not a licence).
 *   * **disburse** — the money arrived: the journal posts (Dr bank net · Dr
 *     clearing or commission expense · Cr loan liability), and the loan can
 *     now fund payment applications.
 *   * **pay an instalment** — Dr liability (principal) · Dr interest · Dr a
 *     spread commission · Cr bank, dated the day it left. The last one makes
 *     the loan fully repaid.
 *   * **allocate / release** — the payment application's approval draws on
 *     the loan; its rejection or cancellation gives the draw back. Each draw
 *     carries its share of the commission to its import as a `bank_commission`
 *     landed-cost charge (D5).
 *
 * The journal stays IQD (as D17): each posting converts at the accounting rate
 * of its own date. Nothing is deleted: a loan is cancelled with a reason, a
 * schedule superseded, an allocation released.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  bank,
  bankCashAccount,
  bankLoan,
  bankLoanAllocation,
  bankLoanInstalment,
  bankLoanRepayment,
  landedCostCharge,
  loanCommissionTreatment,
  payable,
  paymentApplication,
  stageTimeLimit,
} from '../db/schema';
import {
  ALLOCATION_METHODS,
  FREQUENCIES,
  LoanError,
  assertMove,
  assertScheduleRepays,
  buildSchedule,
  COMMISSION_BASES,
  commissionOf,
  commissionShares,
  GRACE_KINDS,
  INTEREST_BASES,
  INTEREST_TYPES,
  LOAN_PURPOSES,
  PRINCIPAL_METHODS,
  instalmentState,
  netProceeds,
  outstanding,
  percentOf,
  scheduleEditable,
  unallocated,
  type AllocationMethod,
  type Frequency,
  type ScheduleRow,
} from '../domain/loans';
import { addDays, formatAmount as shown } from '../domain/payment-applications';
import { limitInForce } from '../domain/payables';
import { requiresHigherApproval } from '../domain/treasury';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as posting from './posting';
import * as rateService from './exchange-rates';
import { allocateDocumentNumber } from './numbering';
import { registerPage, searchOf, type RegisterPaging } from './register-page';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'bank_loan';
const SEQUENCE_KEY = 'LOAN';
const ALLOCATION_SOURCE = 'bank_loan_allocation';

const today = () => businessToday();
const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);

export { LoanError };

export class LoanNotFoundError extends Error {
  readonly code = 'LOAN_NOT_FOUND';
  constructor(ref: string) {
    super(`No loan '${ref}'.`);
    this.name = 'LoanNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(bankLoan).where(eq(bankLoan.id, id)).limit(1);
  if (!row) throw new LoanNotFoundError(id);
  return row;
}

/** HD9 — the loan row locked for a transition, so a double submit posts once. */
async function lock(tx: Tx, id: string) {
  const [row] = await tx.select().from(bankLoan).where(eq(bankLoan.id, id)).for('update');
  if (!row) throw new LoanNotFoundError(id);
  return row;
}

export async function loadByNo(tx: Tx, loanNo: string) {
  const [row] = await tx.select().from(bankLoan).where(eq(bankLoan.loanNo, loanNo)).limit(1);
  if (!row) throw new LoanNotFoundError(loanNo);
  return row;
}

async function treatmentOf(tx: Tx, code: string) {
  const [row] = await tx
    .select()
    .from(loanCommissionTreatment)
    .where(eq(loanCommissionTreatment.code, code))
    .limit(1);
  if (!row) throw new LoanError(`'${code}' is not a commission treatment.`);
  return row;
}

async function accountOf(tx: Tx, id: string) {
  const [row] = await tx.select().from(bankCashAccount).where(eq(bankCashAccount.id, id)).limit(1);
  if (!row) throw new LoanError(`No bank account with id '${id}'.`);
  return row;
}

/** The live schedule, in order. */
export async function scheduleOf(tx: Tx, loanId: string) {
  return tx
    .select()
    .from(bankLoanInstalment)
    .where(and(eq(bankLoanInstalment.loanId, loanId), isNull(bankLoanInstalment.supersededAt)))
    .orderBy(asc(bankLoanInstalment.sequence));
}

/** What every branch has drawn on the loan (a SECURITY DEFINER sum, as reservations are). */
export async function allocatedOf(tx: Tx, loanId: string): Promise<bigint> {
  const result = await tx.execute(sql`select bank_loan_allocated_txn(${loanId})::text as total`);
  return amountOf((result.rows[0] as { total: string }).total);
}

/** §15.7 — the instalment warning window (seed 7 days), from the clock settings. */
export async function warningDays(tx: Tx): Promise<number> {
  const limits = await tx
    .select({
      scope: stageTimeLimit.scope,
      limitDays: stageTimeLimit.limitDays,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
      active: stageTimeLimit.active,
      validFrom: sql<string>`${stageTimeLimit.validFrom}::text`,
    })
    .from(stageTimeLimit)
    .where(eq(stageTimeLimit.checkCode, 'loan_instalment_due'));
  return limitInForce(limits, {}, today())?.limitDays ?? 7;
}

/** The period before the first due date, for the first instalment's interest. */
function startOf(firstDueDate: string, frequency: Frequency): string {
  if (frequency === 'quarterly') return addMonthsBack(firstDueDate, 3);
  return addMonthsBack(firstDueDate, 1);
}

function addMonthsBack(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

async function writeSchedule(
  tx: Tx,
  ctx: ActorContext,
  loanId: string,
  rows: readonly ScheduleRow[],
): Promise<void> {
  await tx
    .update(bankLoanInstalment)
    .set({ supersededAt: new Date(), supersededBy: ctx.principal.userId })
    .where(and(eq(bankLoanInstalment.loanId, loanId), isNull(bankLoanInstalment.supersededAt)));
  for (const row of rows) {
    await tx.insert(bankLoanInstalment).values({
      loanId,
      sequence: row.sequence,
      dueDate: row.dueDate,
      principalTxn: money(row.principal),
      commissionTxn: money(row.commission),
      interestTxn: money(row.interest),
      totalTxn: money(row.total),
      createdBy: ctx.principal.userId,
    });
  }
  await tx
    .update(bankLoan)
    .set({ maturityDate: rows[rows.length - 1]!.dueDate, updatedAt: new Date() })
    .where(eq(bankLoan.id, loanId));
}

// ---------------------------------------------------------------------------
// §15.7 — create
// ---------------------------------------------------------------------------

export interface CreateLoanInput {
  readonly bankCode: string;
  readonly bankCashAccountId: string;
  readonly principalTxn: bigint;
  readonly commissionPct?: string | null;
  /** The bank's own figure when it rounds; principal × pct otherwise. */
  readonly commissionTxn?: bigint | null;
  readonly commissionTreatmentCode: string;
  /**
   * The bank's own terms (0273). Each is optional and each default is what the
   * register did before them: equal principal, interest on the reducing
   * balance, a fixed rate, no grace.
   */
  readonly facilityReference?: string | null;
  readonly principalMethod?: string | null;
  readonly interestBasis?: string | null;
  readonly interestType?: string | null;
  readonly interestReferenceRate?: string | null;
  readonly interestSpreadPct?: string | null;
  readonly commissionBasis?: string | null;
  readonly otherFeesTxn?: bigint | null;
  readonly graceKind?: string | null;
  readonly graceUntil?: string | null;
  readonly purposeCode?: string | null;
  readonly expectedDisbursementDate?: string | null;
  /** D5 — true (default) capitalises the commission into the funded imports. */
  readonly commissionCapitalised?: boolean;
  readonly interestPctPa?: string | null;
  readonly allocationMethod?: string | null;
  readonly instalmentCount: number;
  readonly frequency: string;
  readonly firstDueDate: string;
  readonly customDates?: readonly string[];
  readonly purpose?: string | null;
  /** The date the IQD figure is converted on; today by default. */
  readonly onDate?: string | null;
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateLoanInput) {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const [lender] = await tx.select().from(bank).where(eq(bank.code, input.bankCode)).limit(1);
  if (!lender || !lender.active) throw new LoanError(`'${input.bankCode}' is not an active bank.`);
  const account = await accountOf(tx, input.bankCashAccountId);
  if (!account.active) throw new LoanError(`${account.code} is closed; no loan lands in it.`);
  if (account.accountType !== 'bank') {
    throw new LoanError(`${account.code} is a cash account; a loan's proceeds land in a bank account.`);
  }
  if (input.principalTxn <= 0n) throw new LoanError('State the principal the bank lends.');

  const frequency = input.frequency as Frequency;
  if (!(FREQUENCIES as readonly string[]).includes(frequency)) {
    throw new LoanError(`'${input.frequency}' is not a repayment frequency.`);
  }
  const method = (input.allocationMethod || 'by_amount_used') as AllocationMethod;
  if (!(ALLOCATION_METHODS as readonly string[]).includes(method)) {
    throw new LoanError(`'${input.allocationMethod}' is not an allocation method.`);
  }
  const count = Math.trunc(input.instalmentCount);
  if (!Number.isFinite(count) || count <= 0) throw new LoanError('A loan is repaid in at least one instalment.');
  if (!input.firstDueDate) throw new LoanError('Give the first instalment’s due date.');

  const treatment = await treatmentOf(tx, input.commissionTreatmentCode);
  if (!treatment.active) throw new LoanError(`${treatment.name} is no longer offered.`);
  const pct = percentOf(input.commissionPct, 'A commission');
  const commission = input.commissionTxn ?? commissionOf(input.principalTxn, pct);
  if (commission < 0n || commission >= input.principalTxn) {
    throw new LoanError('The commission is less than the principal, and never negative.');
  }
  const interest = (input.interestPctPa ?? '').trim() ? percentOf(input.interestPctPa, 'An interest rate') : null;
  const net = netProceeds(input.principalTxn, commission, treatment.deducted);

  /*
   * The bank's terms (0273), each held to its own list. A letter that says
   * nothing leaves the register as it was: equal principal, reducing balance,
   * a fixed rate and no grace.
   */
  const oneOf = <T extends string>(value: string | null | undefined, list: readonly T[], fallback: T, what: string): T => {
    const chosen = (value ?? '').trim();
    if (!chosen) return fallback;
    if (!(list as readonly string[]).includes(chosen)) throw new LoanError(`'${chosen}' is not ${what}.`);
    return chosen as T;
  };
  const principalMethod = oneOf(input.principalMethod, PRINCIPAL_METHODS, 'equal_principal', 'a repayment method');
  const interestBasis = oneOf(input.interestBasis, INTEREST_BASES, 'reducing', 'an interest basis');
  const interestType = oneOf(input.interestType, INTEREST_TYPES, 'fixed', 'an interest type');
  const commissionBasis = oneOf(input.commissionBasis, COMMISSION_BASES, 'percentage', 'a commission basis');
  const graceKind = oneOf(input.graceKind, GRACE_KINDS, 'none', 'a grace period');
  const purposeCode = (input.purposeCode ?? '').trim()
    ? oneOf(input.purposeCode, LOAN_PURPOSES, 'general', 'a purpose')
    : null;

  const referenceRate = (input.interestReferenceRate ?? '').trim() || null;
  if (interestType === 'variable' && !referenceRate) {
    throw new LoanError('A variable rate follows a published one. Name it as the letter does.');
  }
  const spread = (input.interestSpreadPct ?? '').trim() ? percentOf(input.interestSpreadPct, 'A spread') : null;
  const graceUntil = graceKind === 'none' ? null : ((input.graceUntil ?? '').trim() || null);
  if (graceKind !== 'none' && !graceUntil) throw new LoanError('A grace period runs to a date. Say when it ends.');
  const otherFees = input.otherFeesTxn ?? 0n;
  if (otherFees < 0n) throw new LoanError('Bank fees are never negative.');

  const schedule = buildSchedule({
    principal: input.principalTxn,
    commission,
    spreadCommission: treatment.spread,
    // A variable rate is its reference plus the spread; the letter's own rate
    // is what the first schedule is built on either way.
    interestPctPa: interest,
    count,
    frequency,
    firstDueDate: input.firstDueDate,
    ...(input.customDates ? { customDates: input.customDates } : {}),
    startDate: startOf(input.firstDueDate, frequency),
    principalMethod,
    interestBasis,
    grace: graceKind,
    graceUntil,
  });

  const onDate = input.onDate || today();
  const converted = await rateService.convertOn(tx, input.principalTxn, account.currency, onDate);
  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { year: Number(onDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(bankLoan)
    .values({
      loanNo: allocated.documentNo,
      bankCode: lender.code,
      bankCashAccountId: account.id,
      branchCode: ctx.branchCode,
      currency: account.currency,
      principalTxn: money(input.principalTxn),
      principalIqd: money(converted.amountIqd),
      rateId: converted.txnRateId ?? null,
      commissionPct: toDecimalString(pct, 4n),
      commissionTxn: money(commission),
      facilityReference: (input.facilityReference ?? '').trim() || null,
      principalMethod,
      interestBasis,
      interestType,
      interestReferenceRate: referenceRate,
      interestSpreadPct: spread === null ? null : toDecimalString(spread, 4n),
      commissionBasis,
      otherFeesTxn: money(otherFees),
      graceKind,
      graceUntil,
      purposeCode,
      expectedDisbursementDate: (input.expectedDisbursementDate ?? '').trim() || null,
      commissionTreatmentCode: treatment.code,
      commissionCapitalised: input.commissionCapitalised ?? true,
      interestPctPa: interest === null ? null : toDecimalString(interest, 4n),
      netProceedsTxn: money(net),
      allocationMethod: method,
      instalmentCount: count,
      frequency,
      firstDueDate: schedule[0]!.dueDate,
      purpose: input.purpose?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: bankLoan.id });

  await writeSchedule(tx, ctx, created!.id, schedule);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: {
      loanNo: allocated.documentNo,
      bank: lender.code,
      account: account.code,
      currency: account.currency,
      principalTxn: money(input.principalTxn),
      commissionTxn: money(commission),
      treatment: treatment.code,
      netProceedsTxn: money(net),
      instalments: count,
      frequency,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, loanNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// §15.7 — the schedule, retyped before approval
// ---------------------------------------------------------------------------

export interface ScheduleRowInput {
  readonly dueDate: string;
  readonly principalTxn: bigint;
  readonly interestTxn?: bigint | null;
  readonly commissionTxn?: bigint | null;
}

export async function setSchedule(tx: Tx, ctx: ActorContext, loanId: string, rows: readonly ScheduleRowInput[]) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  if (!scheduleEditable(loan.status)) {
    throw new LoanError(`${loan.loanNo} is ${loan.status}; its schedule was fixed when it was approved.`);
  }
  const treatment = await treatmentOf(tx, loan.commissionTreatmentCode);
  const typed = rows.map((row) => ({
    dueDate: row.dueDate,
    principal: row.principalTxn,
    interest: row.interestTxn ?? 0n,
    commission: row.commissionTxn ?? 0n,
  }));
  const commission = amountOf(loan.commissionTxn);
  assertScheduleRepays(loan.loanNo, typed, amountOf(loan.principalTxn), treatment.spread ? commission : 0n);
  const schedule: ScheduleRow[] = typed.map((row, index) => ({
    sequence: index + 1,
    dueDate: row.dueDate,
    principal: row.principal,
    commission: row.commission,
    interest: row.interest,
    total: row.principal + row.commission + row.interest,
  }));
  await writeSchedule(tx, ctx, loan.id, schedule);
  await tx
    .update(bankLoan)
    .set({ instalmentCount: schedule.length, firstDueDate: schedule[0]!.dueDate, updatedAt: new Date() })
    .where(eq(bankLoan.id, loan.id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.schedule_set',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    after: { instalments: schedule.map((row) => ({ dueDate: row.dueDate, totalTxn: money(row.total) })) },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Where the loan stands — read from what was posted, never from a count
// ---------------------------------------------------------------------------

export interface LoanPosition {
  /** What the bank lent. */
  readonly principal: bigint;
  /** What has been repaid of it, posted. */
  readonly principalRepaid: bigint;
  /** What is left — the principal less what came back. Never below nothing. */
  readonly outstanding: bigint;
  readonly interestPaid: bigint;
  readonly feesPaid: bigint;
  /** Everything that has left the bank account for this loan. */
  readonly totalPaid: bigint;
  /** Instalments still asking for money. */
  readonly instalmentsLeft: number;
  /** What those come to, as the schedule stands. */
  readonly scheduledLeft: bigint;
  /** The day the principal reached nothing, where it has. */
  readonly repaidOn: string | null;
  readonly settled: boolean;
}

/**
 * Where a loan stands, from the ledger of posted repayments (0275).
 *
 * "Outstanding Principal = Original Principal − Posted Principal Repayments"
 * — and nothing else. A loan with four instalments all marked paid but only
 * three posted is not repaid; a loan whose principal came back in one early
 * payment is, whatever its schedule still says.
 */
export async function positionOf(tx: Tx, loanId: string): Promise<LoanPosition> {
  const [loan] = await tx.select().from(bankLoan).where(eq(bankLoan.id, loanId)).limit(1);
  if (!loan) throw new LoanError('No such loan.');

  const paid = await tx
    .select({
      principal: sql<string>`coalesce(sum(${bankLoanRepayment.principalTxn}), 0)::text`,
      interest: sql<string>`coalesce(sum(${bankLoanRepayment.interestTxn}), 0)::text`,
      fees: sql<string>`coalesce(sum(${bankLoanRepayment.feesTxn}), 0)::text`,
      total: sql<string>`coalesce(sum(${bankLoanRepayment.totalTxn}), 0)::text`,
      last: sql<string | null>`max(${bankLoanRepayment.paidDate})::text`,
    })
    .from(bankLoanRepayment)
    .where(eq(bankLoanRepayment.loanId, loanId));

  const row = paid[0]!;
  const principal = amountOf(loan.principalTxn);
  const principalRepaid = amountOf(row.principal);
  const outstanding = principalRepaid >= principal ? 0n : principal - principalRepaid;

  // What the schedule is still asking for: rows nobody has paid that ask for
  // something. A grace row asks for nothing and is not one of them.
  const open = await tx
    .select({ total: bankLoanInstalment.totalTxn })
    .from(bankLoanInstalment)
    .where(
      and(
        eq(bankLoanInstalment.loanId, loanId),
        isNull(bankLoanInstalment.supersededAt),
        sql`${bankLoanInstalment.status} <> 'paid'`,
      ),
    );
  const live = open.map((instalment) => amountOf(instalment.total)).filter((total) => total > 0n);

  return {
    principal,
    principalRepaid,
    outstanding,
    interestPaid: amountOf(row.interest),
    feesPaid: amountOf(row.fees),
    totalPaid: amountOf(row.total),
    instalmentsLeft: live.length,
    scheduledLeft: live.reduce((sum, total) => sum + total, 0n),
    repaidOn: loan.repaidOn,
    settled: loan.status === 'fully_repaid',
  };
}

/**
 * Fully repaid, when it is — and never because somebody said so.
 *
 * The rule is the one the sponsor stated: the outstanding principal is nothing,
 * and nothing else is still being asked for. A loan that still has an
 * instalment carrying interest is not settled, however much principal came
 * back; a loan whose last instalment was waived by an early settlement is,
 * because the settlement marked those rows paid as it posted.
 *
 * Called after every repayment. Returns whether it settled the loan, so the
 * caller can say so on the import's log.
 */
async function settleIfCleared(
  tx: Tx,
  ctx: ActorContext,
  loan: { readonly id: string; readonly loanNo: string; readonly status: string; readonly branchCode: string },
  onDate: string,
): Promise<boolean> {
  if (loan.status !== 'active') return false;
  const position = await positionOf(tx, loan.id);
  if (position.outstanding > 0n || position.instalmentsLeft > 0) return false;

  assertMove(loan.loanNo, loan.status, 'fully_repaid');
  await tx
    .update(bankLoan)
    .set({ status: 'fully_repaid', repaidOn: onDate, updatedAt: new Date() })
    .where(eq(bankLoan.id, loan.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.fully_repaid',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    before: { status: loan.status },
    after: {
      status: 'fully_repaid',
      repaidOn: onDate,
      principalRepaid: money(position.principalRepaid),
      interestPaid: money(position.interestPaid),
      feesPaid: money(position.feesPaid),
      totalPaid: money(position.totalPaid),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return true;
}

/** Every posted repayment of a loan, newest first — the record's own list. */
export async function repaymentsOf(tx: Tx, loanId: string) {
  return tx
    .select({
      id: bankLoanRepayment.id,
      kind: bankLoanRepayment.kind,
      paidDate: bankLoanRepayment.paidDate,
      principalTxn: bankLoanRepayment.principalTxn,
      interestTxn: bankLoanRepayment.interestTxn,
      feesTxn: bankLoanRepayment.feesTxn,
      totalTxn: bankLoanRepayment.totalTxn,
      reference: bankLoanRepayment.reference,
      journalEntryId: bankLoanRepayment.journalEntryId,
    })
    .from(bankLoanRepayment)
    .where(eq(bankLoanRepayment.loanId, loanId))
    .orderBy(desc(bankLoanRepayment.paidDate), desc(bankLoanRepayment.createdAt));
}

// ---------------------------------------------------------------------------
// submit — the offer, as the bank wrote it, put in front of somebody else
// ---------------------------------------------------------------------------

/**
 * Sent for approval (0273, by direction 2026-10-03).
 *
 * A draft is the accountant's: the offer and its schedule are retyped as often
 * as the bank's letter is read again. Submitting says they are as the letter
 * states, and hands them to whoever approves. It is still not a posting — no
 * money has moved and none will until the bank sends it — so a submitted loan
 * may be put back to draft and corrected.
 *
 * `create` on the loan: whoever may enter one may send it on. Approval is a
 * different grant, and `approve` already refuses the person who entered it.
 */
export async function submit(tx: Tx, ctx: ActorContext, loanId: string) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  assertMove(loan.loanNo, loan.status, 'submitted');

  const schedule = await scheduleOf(tx, loan.id);
  if (schedule.length === 0) {
    throw new LoanError(`${loan.loanNo} has no schedule to approve. Lay the instalments out first.`);
  }

  await tx
    .update(bankLoan)
    .set({
      status: 'submitted',
      submittedBy: ctx.principal.userId,
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankLoan.id, loan.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    before: { status: loan.status },
    after: { status: 'submitted', instalments: schedule.length },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Back to draft, to be retyped — a submitted loan nobody has approved yet. */
export async function returnToDraft(tx: Tx, ctx: ActorContext, loanId: string, reason: string) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  assertMove(loan.loanNo, loan.status, 'draft');
  const said = reason.trim();
  if (!said) throw new LoanError('Say what should be changed. A return without a reason is not an answer.');

  await tx
    .update(bankLoan)
    .set({ status: 'draft', submittedBy: null, submittedAt: null, updatedAt: new Date() })
    .where(eq(bankLoan.id, loan.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.returned',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    before: { status: loan.status },
    after: { status: 'draft', reason: said },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// approve — a second person; the CEO above the account's limit
// ---------------------------------------------------------------------------

export async function approve(tx: Tx, ctx: ActorContext, loanId: string) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  assertMove(loan.loanNo, loan.status, 'approved');
  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (loan.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new LoanError(`${loan.loanNo}: the person who entered a loan cannot approve it (§5.2).`);
  }
  const account = await accountOf(tx, loan.bankCashAccountId);
  const limit = account.approvalLimitIqd === null ? null : amountOf(account.approvalLimitIqd);
  if (
    requiresHigherApproval(amountOf(loan.principalIqd), limit) &&
    !ctx.principal.isSuperUser &&
    !ctx.principal.roleCodes.includes('ceo')
  ) {
    throw new LoanError(
      `${loan.loanNo} is ${shown(amountOf(loan.principalIqd))} IQD, above ${account.code}'s approval limit of ` +
        `${limit === null ? 'nothing (no limit has been set)' : `${shown(limit)} IQD`}; the CEO approves it.`,
    );
  }
  await tx
    .update(bankLoan)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(bankLoan.id, loan.id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.approved',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    before: { status: loan.status },
    after: { status: 'approved' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// disburse — the money arrived (§15.6 "Deposit / loan in")
// ---------------------------------------------------------------------------

/** The account a commission is booked to: the funded imports' cost, or an expense. */
const commissionRole = (capitalised: boolean) => (capitalised ? 'landed_cost_clearing' : 'bank_commission');

export async function disburse(
  tx: Tx,
  ctx: ActorContext,
  loanId: string,
  input: { readonly disbursementDate: string; readonly reference: string },
) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  assertMove(loan.loanNo, loan.status, 'active');
  if (!input.disbursementDate) throw new LoanError('Give the date the money arrived.');
  const reference = input.reference?.trim() ?? '';
  if (!reference) throw new LoanError('Give the bank’s reference for the credit (the advice or statement line).');

  const account = await accountOf(tx, loan.bankCashAccountId);
  const treatment = await treatmentOf(tx, loan.commissionTreatmentCode);
  const principal = amountOf(loan.principalTxn);
  const commission = treatment.deducted ? amountOf(loan.commissionTxn) : 0n;

  const principalIqd = await rateService.convertOn(tx, principal, loan.currency, input.disbursementDate);
  const commissionIqd =
    commission > 0n ? (await rateService.convertOn(tx, commission, loan.currency, input.disbursementDate)).amountIqd : 0n;
  const netIqd = principalIqd.amountIqd - commissionIqd;

  const criteria = { branchCode: loan.branchCode };
  const dimensions = { branch: loan.branchCode };
  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.loan_disbursement',
    documentTypeCode: PERMISSION_OBJECT,
    source: { module: 'treasury', documentId: loan.id, event: 'disbursed' },
    branchCode: loan.branchCode,
    documentDate: input.disbursementDate,
    postingDate: input.disbursementDate,
    description: `Loan ${loan.loanNo} disbursed — ${loan.currency} ${shown(principal - commission)} into ${account.code} (${reference})`,
    lines: [
      {
        role: 'bank',
        accountId: account.glAccountId,
        debit: money(netIqd),
        criteria,
        dimensions,
        bankAccountCode: account.code,
      },
      ...(commissionIqd > 0n
        ? [{ role: commissionRole(loan.commissionCapitalised), debit: money(commissionIqd), criteria, dimensions }]
        : []),
      { role: 'loan_liability', credit: money(principalIqd.amountIqd), criteria, dimensions, loanNo: loan.loanNo },
    ],
  });

  await tx
    .update(bankLoan)
    .set({
      status: 'active',
      disbursementDate: input.disbursementDate,
      disbursementReference: reference,
      disbursementJournalEntryId: result.journalEntryId,
      // The IQD the liability was booked at.
      principalIqd: money(principalIqd.amountIqd),
      rateId: principalIqd.txnRateId ?? loan.rateId,
      activatedBy: ctx.principal.userId,
      activatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankLoan.id, loan.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.disbursed',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    before: { status: loan.status },
    after: {
      status: 'active',
      disbursementDate: input.disbursementDate,
      reference,
      netIqd: money(netIqd),
      commissionIqd: money(commissionIqd),
      principalIqd: money(principalIqd.amountIqd),
      journalEntryId: result.journalEntryId,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// §15.6 "Loan repayment" — an instalment leaves the account
// ---------------------------------------------------------------------------

export async function payInstalment(
  tx: Tx,
  ctx: ActorContext,
  instalmentId: string,
  input: { readonly paidDate: string; readonly reference: string },
) {
  // HD9 — the instalment and its loan, locked: a double submit pays once.
  const [instalment] = await tx
    .select()
    .from(bankLoanInstalment)
    .where(eq(bankLoanInstalment.id, instalmentId))
    .for('update');
  if (!instalment || instalment.supersededAt) throw new LoanError('That instalment is not part of the loan’s schedule.');
  const loan = await lock(tx, instalment.loanId);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  if (loan.status !== 'active') {
    throw new LoanError(`${loan.loanNo} is ${loan.status.replace('_', ' ')}; only a disbursed loan is repaid.`);
  }
  if (instalment.status === 'paid') {
    throw new LoanError(`Instalment ${instalment.sequence} of ${loan.loanNo} was paid on ${instalment.paidDate}.`);
  }
  if (!input.paidDate) throw new LoanError('Give the date the instalment left the account.');
  const reference = input.reference?.trim() ?? '';
  if (!reference) throw new LoanError('Give the bank’s reference for the debit.');
  if (loan.disbursementDate && input.paidDate < loan.disbursementDate) {
    throw new LoanError(`${input.paidDate} is before the loan was disbursed (${loan.disbursementDate}).`);
  }
  const schedule = await scheduleOf(tx, loan.id);
  const earlier = schedule.find((row) => row.sequence < instalment.sequence && row.status !== 'paid');
  if (earlier) {
    throw new LoanError(`Instalment ${earlier.sequence} of ${loan.loanNo} is still unpaid; instalments are repaid in order.`);
  }

  const account = await accountOf(tx, loan.bankCashAccountId);
  const convert = async (value: bigint) =>
    value > 0n ? (await rateService.convertOn(tx, value, loan.currency, input.paidDate)).amountIqd : 0n;
  const principalIqd = await convert(amountOf(instalment.principalTxn));
  const interestIqd = await convert(amountOf(instalment.interestTxn));
  const commissionIqd = await convert(amountOf(instalment.commissionTxn));
  const totalIqd = principalIqd + interestIqd + commissionIqd;

  const criteria = { branchCode: loan.branchCode };
  const dimensions = { branch: loan.branchCode };
  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.loan_repayment',
    documentTypeCode: PERMISSION_OBJECT,
    source: { module: 'treasury', documentId: instalment.id, event: 'repaid' },
    branchCode: loan.branchCode,
    documentDate: input.paidDate,
    postingDate: input.paidDate,
    description: `Loan ${loan.loanNo} instalment ${instalment.sequence} repaid (${reference})`,
    lines: [
      ...(principalIqd > 0n
        ? [{ role: 'loan_liability', debit: money(principalIqd), criteria, dimensions, loanNo: loan.loanNo }]
        : []),
      ...(interestIqd > 0n ? [{ role: 'loan_interest', debit: money(interestIqd), criteria, dimensions }] : []),
      ...(commissionIqd > 0n
        ? [{ role: commissionRole(loan.commissionCapitalised), debit: money(commissionIqd), criteria, dimensions }]
        : []),
      {
        role: 'bank',
        accountId: account.glAccountId,
        credit: money(totalIqd),
        criteria,
        dimensions,
        bankAccountCode: account.code,
      },
    ],
  });

  await tx
    .update(bankLoanInstalment)
    .set({
      status: 'paid',
      paidDate: input.paidDate,
      paidReference: reference,
      journalEntryId: result.journalEntryId,
      paidBy: ctx.principal.userId,
      paidAt: new Date(),
    })
    .where(eq(bankLoanInstalment.id, instalment.id));

  /*
   * The ledger the status is read from (0275). What was paid, split the way
   * the instalment split it — the commission a spread treatment rides on the
   * instalments is a fee, not principal and not interest.
   */
  await tx.insert(bankLoanRepayment).values({
    loanId: loan.id,
    instalmentId: instalment.id,
    kind: 'instalment',
    paidDate: input.paidDate,
    principalTxn: instalment.principalTxn,
    interestTxn: instalment.interestTxn,
    feesTxn: instalment.commissionTxn,
    totalTxn: instalment.totalTxn,
    totalIqd: money(totalIqd),
    reference,
    journalEntryId: result.journalEntryId,
    createdBy: ctx.principal.userId,
  });

  /*
   * Fully repaid, if this was what cleared it — worked out from the ledger,
   * not from the instalments that happen to be left. The old rule counted
   * rows, which said nothing about what had actually been paid.
   */
  const settledNow = await settleIfCleared(tx, ctx, loan, input.paidDate);
  const remaining = schedule.filter((row) => row.id !== instalment.id && row.status !== 'paid');

  for (const payableId of await fundedPayables(tx, loan.id)) {
    await events.record(tx, {
      payableId,
      eventCode: 'LOAN_INSTALMENT_PAID',
      summary:
        `${loan.loanNo} instalment ${instalment.sequence} repaid on ${input.paidDate} — ` +
        `${loan.currency} ${shown(amountOf(instalment.totalTxn))}${settledNow ? '; the loan is fully repaid' : ''}`,
      sourceType: PERMISSION_OBJECT,
      sourceId: loan.id,
      sourceNo: loan.loanNo,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.instalment_paid',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    after: {
      sequence: instalment.sequence,
      paidDate: input.paidDate,
      reference,
      totalIqd: money(totalIqd),
      journalEntryId: result.journalEntryId,
      fullyRepaid: remaining.length === 0,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { journalEntryId: result.journalEntryId, fullyRepaid: remaining.length === 0 };
}

/** A commission the bank charges on its own (`paid separately`). */
export async function payCommission(
  tx: Tx,
  ctx: ActorContext,
  loanId: string,
  input: { readonly paidOn: string; readonly reference: string },
) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  const treatment = await treatmentOf(tx, loan.commissionTreatmentCode);
  if (treatment.deducted || treatment.spread) {
    throw new LoanError(`${loan.loanNo}'s commission is ${treatment.name.toLowerCase()}; it is not paid on its own.`);
  }
  if (loan.status !== 'approved' && loan.status !== 'active') {
    throw new LoanError(`${loan.loanNo} is ${loan.status.replace('_', ' ')}; no commission is paid on it.`);
  }
  if (loan.commissionPaidOn) throw new LoanError(`${loan.loanNo}'s commission was paid on ${loan.commissionPaidOn}.`);
  const commission = amountOf(loan.commissionTxn);
  if (commission <= 0n) throw new LoanError(`${loan.loanNo} carries no commission.`);
  if (!input.paidOn) throw new LoanError('Give the date the commission left the account.');
  const reference = input.reference?.trim() ?? '';
  if (!reference) throw new LoanError('Give the bank’s reference for the debit.');

  const account = await accountOf(tx, loan.bankCashAccountId);
  const commissionIqd = (await rateService.convertOn(tx, commission, loan.currency, input.paidOn)).amountIqd;
  const criteria = { branchCode: loan.branchCode };
  const dimensions = { branch: loan.branchCode };
  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.loan_commission',
    documentTypeCode: PERMISSION_OBJECT,
    source: { module: 'treasury', documentId: loan.id, event: 'commission_paid' },
    branchCode: loan.branchCode,
    documentDate: input.paidOn,
    postingDate: input.paidOn,
    description: `Loan ${loan.loanNo} commission paid (${reference})`,
    lines: [
      { role: commissionRole(loan.commissionCapitalised), debit: money(commissionIqd), criteria, dimensions },
      {
        role: 'bank',
        accountId: account.glAccountId,
        credit: money(commissionIqd),
        criteria,
        dimensions,
        bankAccountCode: account.code,
      },
    ],
  });
  await tx
    .update(bankLoan)
    .set({
      commissionPaidOn: input.paidOn,
      commissionReference: reference,
      commissionJournalEntryId: result.journalEntryId,
      updatedAt: new Date(),
    })
    .where(eq(bankLoan.id, loan.id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.commission_paid',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    after: { paidOn: input.paidOn, reference, commissionIqd: money(commissionIqd), journalEntryId: result.journalEntryId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// cancel — before the money arrives, with a reason
// ---------------------------------------------------------------------------

/**
 * What it would cost to end the loan today — by direction, 2026-10-03.
 *
 * The principal still outstanding, the interest earned since the last
 * instalment that was paid (on that outstanding, actual/365, the same count the
 * schedule uses), and whatever the bank charges for ending it early, which is
 * its own figure and is typed. Nothing is written: this is the quote a person
 * reads before deciding.
 */
export async function settlementQuote(tx: Tx, loanId: string, onDate: string) {
  const [loan] = await tx.select().from(bankLoan).where(eq(bankLoan.id, loanId)).limit(1);
  if (!loan) throw new LoanError('No such loan.');
  const position = await positionOf(tx, loanId);

  /*
   * Interest runs from the last date money changed hands — the last repayment,
   * or the disbursement if none has — to the day of the settlement.
   */
  const [latest] = await tx
    .select({ paidDate: bankLoanRepayment.paidDate })
    .from(bankLoanRepayment)
    .where(eq(bankLoanRepayment.loanId, loanId))
    .orderBy(desc(bankLoanRepayment.paidDate))
    .limit(1);
  const from = latest?.paidDate ?? loan.disbursementDate ?? onDate;
  const days = BigInt(Math.max(0, Math.round((Date.parse(onDate) - Date.parse(from)) / 86_400_000)));
  const rate = loan.interestPctPa ? percentOf(loan.interestPctPa, 'An interest rate') : 0n;
  const accrued =
    rate > 0n && position.outstanding > 0n
      ? (position.outstanding * rate * days) / (100n * 10n ** MONEY_SCALE * 365n)
      : 0n;

  return {
    outstanding: position.outstanding,
    accruedFrom: from,
    accruedDays: Number(days),
    accruedInterest: accrued,
    /** What the bank charges to end it early. Typed, because the bank quotes it. */
    feeTxn: 0n,
    total: position.outstanding + accrued,
  };
}

/**
 * End the loan early: pay what is left in one go — by direction, 2026-10-03.
 *
 * One posting, one repayment row: the principal still outstanding, the interest
 * accrued to the day, and the bank's early-settlement charge. Every instalment
 * still standing is marked paid against it, because the schedule no longer
 * describes anything that will happen — and the loan becomes fully repaid by
 * the same rule every other repayment goes through, not by this function
 * deciding it.
 */
export async function settleEarly(
  tx: Tx,
  ctx: ActorContext,
  loanId: string,
  input: {
    readonly onDate: string;
    readonly reference: string;
    /** The bank's charge for ending it early; nothing when it makes none. */
    readonly feeTxn?: bigint | null;
    /** The interest the bank asks for, when it differs from the accrual. */
    readonly interestTxn?: bigint | null;
  },
) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  if (loan.status !== 'active') {
    throw new LoanError(`${loan.loanNo} is ${loan.status.replace('_', ' ')}; only a disbursed loan is settled.`);
  }
  const reference = input.reference?.trim() ?? '';
  if (!reference) throw new LoanError('Give the bank’s reference for the settlement.');
  if (!input.onDate) throw new LoanError('Give the date the settlement was paid.');

  const quote = await settlementQuote(tx, loanId, input.onDate);
  if (quote.outstanding <= 0n) {
    throw new LoanError(`${loan.loanNo} has no principal outstanding; there is nothing to settle.`);
  }
  const interest = input.interestTxn ?? quote.accruedInterest;
  const fee = input.feeTxn ?? 0n;
  if (interest < 0n || fee < 0n) throw new LoanError('A settlement’s interest and fee are never negative.');
  const total = quote.outstanding + interest + fee;

  const account = await accountOf(tx, loan.bankCashAccountId);
  const convert = async (value: bigint) =>
    value > 0n ? (await rateService.convertOn(tx, value, loan.currency, input.onDate)).amountIqd : 0n;
  const principalIqd = await convert(quote.outstanding);
  const interestIqd = await convert(interest);
  const feeIqd = await convert(fee);
  const totalIqd = principalIqd + interestIqd + feeIqd;

  const criteria = { branchCode: loan.branchCode };
  const dimensions = { branch: loan.branchCode };
  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.loan_repayment',
    documentTypeCode: PERMISSION_OBJECT,
    source: { module: 'treasury', documentId: loan.id, event: 'settled' },
    branchCode: loan.branchCode,
    documentDate: input.onDate,
    postingDate: input.onDate,
    description: `Loan ${loan.loanNo} settled early — ${loan.currency} ${shown(total)} (${reference})`,
    lines: [
      { role: 'loan_liability', debit: money(principalIqd), criteria, dimensions, loanNo: loan.loanNo },
      ...(interestIqd > 0n ? [{ role: 'loan_interest', debit: money(interestIqd), criteria, dimensions }] : []),
      ...(feeIqd > 0n
        ? [{ role: commissionRole(false), debit: money(feeIqd), criteria, dimensions }]
        : []),
      {
        role: 'bank',
        accountId: account.glAccountId,
        credit: money(totalIqd),
        criteria,
        dimensions,
        bankAccountCode: account.code,
      },
    ],
  });

  await tx.insert(bankLoanRepayment).values({
    loanId: loan.id,
    kind: 'settlement',
    paidDate: input.onDate,
    principalTxn: money(quote.outstanding),
    interestTxn: money(interest),
    feesTxn: money(fee),
    totalTxn: money(total),
    totalIqd: money(totalIqd),
    reference,
    journalEntryId: result.journalEntryId,
    createdBy: ctx.principal.userId,
  });

  /*
   * The schedule described instalments that will not now happen. They are
   * marked paid against this settlement rather than deleted: the bank's letter
   * said they were due, and the register keeps what the letter said.
   */
  await tx
    .update(bankLoanInstalment)
    .set({
      status: 'paid',
      paidDate: input.onDate,
      paidReference: reference,
      journalEntryId: result.journalEntryId,
      paidBy: ctx.principal.userId,
      paidAt: new Date(),
    })
    .where(
      and(
        eq(bankLoanInstalment.loanId, loan.id),
        isNull(bankLoanInstalment.supersededAt),
        sql`${bankLoanInstalment.status} <> 'paid'`,
      ),
    );

  await tx
    .update(bankLoan)
    .set({ settlementFeeTxn: money(fee), updatedAt: new Date() })
    .where(eq(bankLoan.id, loan.id));

  await settleIfCleared(tx, ctx, loan, input.onDate);

  for (const payableId of await fundedPayables(tx, loan.id)) {
    await events.record(tx, {
      payableId,
      eventCode: 'LOAN_INSTALMENT_PAID',
      summary:
        `${loan.loanNo} settled early on ${input.onDate} — ${loan.currency} ${shown(total)}; the loan is fully repaid`,
      sourceType: PERMISSION_OBJECT,
      sourceId: loan.id,
      sourceNo: loan.loanNo,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.settled_early',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    after: {
      onDate: input.onDate,
      principal: money(quote.outstanding),
      interest: money(interest),
      fee: money(fee),
      total: money(total),
      reference,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { total, principal: quote.outstanding, interest, fee, journalEntryId: result.journalEntryId };
}

export async function cancel(tx: Tx, ctx: ActorContext, loanId: string, reason: string) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, loan.status === 'draft' ? 'edit_draft' : 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: loan.branchCode,
  });
  assertMove(loan.loanNo, loan.status, 'cancelled');
  const text = reason?.trim() ?? '';
  if (!text) throw new LoanError(`Say why ${loan.loanNo} is cancelled.`);
  if (loan.commissionPaidOn) {
    throw new LoanError(`${loan.loanNo}'s commission was paid on ${loan.commissionPaidOn}; a loan already charged for is not cancelled.`);
  }
  const naming = await tx
    .select({ no: paymentApplication.applicationNo })
    .from(paymentApplication)
    .where(
      and(
        eq(paymentApplication.loanId, loan.id),
        sql`${paymentApplication.status} not in ('rejected','cancelled')`,
      ),
    );
  if (naming.length > 0) {
    throw new LoanError(
      `${naming.map((row) => row.no).join(', ')} ${naming.length === 1 ? 'is' : 'are'} funded by ${loan.loanNo}; ` +
        'cancel or re-fund them first.',
    );
  }
  await tx
    .update(bankLoan)
    .set({
      status: 'cancelled',
      closedReason: text,
      closedBy: ctx.principal.userId,
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankLoan.id, loan.id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_loan.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: loan.id,
    branchCode: loan.branchCode,
    before: { status: loan.status },
    after: { status: 'cancelled' },
    reason: text,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// §15.7 — allocations: what the loan funded, and the commission each carries
// ---------------------------------------------------------------------------

async function fundedPayables(tx: Tx, loanId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ payableId: bankLoanAllocation.payableId })
    .from(bankLoanAllocation)
    .where(and(eq(bankLoanAllocation.loanId, loanId), isNull(bankLoanAllocation.releasedAt)));
  return rows.map((row) => row.payableId);
}

/**
 * Called when a payment application is drafted naming a loan: the loan exists,
 * is approved or active, is in the application's currency, lands in the
 * account the application pays from, and has the room.
 */
export async function assertCanFund(
  tx: Tx,
  input: {
    readonly loanId: string;
    readonly currency: string;
    readonly bankCashAccountId: string;
    readonly amountTxn: bigint;
    readonly mustBeActive?: boolean;
  },
) {
  const loan = await load(tx, input.loanId);
  if (input.mustBeActive ? loan.status !== 'active' : loan.status !== 'approved' && loan.status !== 'active') {
    throw new LoanError(
      input.mustBeActive
        ? `${loan.loanNo} is ${loan.status.replace('_', ' ')}; its money has not arrived, so it funds nothing yet. Record the disbursement first.`
        : `${loan.loanNo} is ${loan.status.replace('_', ' ')}; only an approved or disbursed loan funds a payment.`,
    );
  }
  if (loan.currency !== input.currency) {
    throw new LoanError(`${loan.loanNo} is in ${loan.currency}; this payment is in ${input.currency}.`);
  }
  if (loan.bankCashAccountId !== input.bankCashAccountId) {
    const account = await accountOf(tx, loan.bankCashAccountId);
    throw new LoanError(`${loan.loanNo}'s money is in ${account.code}; a payment it funds is paid from there.`);
  }
  const room = unallocated(amountOf(loan.principalTxn), await allocatedOf(tx, loan.id));
  if (input.amountTxn > room) {
    throw new LoanError(
      `${loan.loanNo} has ${loan.currency} ${shown(room)} left to fund; this payment is ${loan.currency} ${shown(input.amountTxn)}.`,
    );
  }
  return loan;
}

/** The IQD of a commission share, at the rate the loan was booked at. */
function shareIqd(loan: typeof bankLoan.$inferSelect, share: bigint): bigint {
  const principal = amountOf(loan.principalTxn);
  return principal === 0n ? 0n : (share * amountOf(loan.principalIqd)) / principal;
}

/** Re-states every live allocation's commission share; re-issues the charges that changed. */
async function restateShares(tx: Tx, ctx: ActorContext, loan: typeof bankLoan.$inferSelect, reason: string) {
  const live = await tx
    .select()
    .from(bankLoanAllocation)
    .where(and(eq(bankLoanAllocation.loanId, loan.id), isNull(bankLoanAllocation.releasedAt)))
    .orderBy(asc(bankLoanAllocation.createdAt));
  const shares = commissionShares(
    loan.allocationMethod as AllocationMethod,
    amountOf(loan.commissionTxn),
    amountOf(loan.principalTxn),
    live.map((row) => ({ id: row.id, amount: amountOf(row.amountTxn), manualShare: amountOf(row.commissionShareTxn) })),
  );
  const [owner] = await tx.select({ no: bankLoan.loanNo }).from(bankLoan).where(eq(bankLoan.id, loan.id)).limit(1);
  for (const row of live) {
    const share = shares.get(row.id) ?? 0n;
    const changed = share !== amountOf(row.commissionShareTxn) || (share > 0n && !row.landedCostChargeId && loan.commissionCapitalised);
    if (!changed) continue;
    if (row.landedCostChargeId) {
      await tx
        .update(landedCostCharge)
        .set({ cancelledAt: new Date(), cancelledBy: ctx.principal.userId, cancelReason: reason })
        .where(eq(landedCostCharge.id, row.landedCostChargeId));
    }
    let chargeId: string | null = null;
    if (loan.commissionCapitalised && share > 0n) {
      const [charge] = await tx
        .insert(landedCostCharge)
        .values({
          payableId: row.payableId,
          chargeTypeCode: 'bank_commission',
          amountTxn: money(share),
          currency: loan.currency,
          amountIqd: money(shareIqd(loan, share)),
          sourceType: ALLOCATION_SOURCE,
          sourceId: row.id,
          sourceNo: owner!.no,
          note: `Commission share of ${owner!.no} (${loan.allocationMethod.replace(/_/g, ' ')})`,
          createdBy: ctx.principal.userId,
        })
        .returning({ id: landedCostCharge.id });
      chargeId = charge!.id;
    }
    await tx
      .update(bankLoanAllocation)
      .set({ commissionShareTxn: money(share), landedCostChargeId: chargeId })
      .where(eq(bankLoanAllocation.id, row.id));
    await events.record(tx, {
      payableId: row.payableId,
      eventCode: 'COMMISSION_RECORDED',
      summary:
        `Commission share of ${owner!.no}: ${loan.currency} ${shown(share)}` +
        (loan.commissionCapitalised ? ' — charged to this import’s landed cost' : ' — expensed, not charged to the import'),
      sourceType: ALLOCATION_SOURCE,
      sourceId: row.id,
      sourceNo: owner!.no,
      actorUserId: ctx.principal.userId,
    });
  }
}

/** The payment application's approval draws on the loan (§15.7). */
export async function allocate(
  tx: Tx,
  ctx: ActorContext,
  application: typeof paymentApplication.$inferSelect,
) {
  if (!application.loanId) return null;
  const amount = amountOf(application.amountTxn);
  const loan = await assertCanFund(tx, {
    loanId: application.loanId,
    currency: application.currency,
    bankCashAccountId: application.bankCashAccountId,
    amountTxn: amount,
    mustBeActive: true,
  });
  const [created] = await tx
    .insert(bankLoanAllocation)
    .values({
      loanId: loan.id,
      paymentApplicationId: application.id,
      payableId: application.payableId,
      amountTxn: money(amount),
      createdBy: ctx.principal.userId,
    })
    .returning({ id: bankLoanAllocation.id });
  const allocatedNow = await allocatedOf(tx, loan.id);
  await events.record(tx, {
    payableId: application.payableId,
    eventCode: 'LOAN_LINKED',
    summary:
      `${application.applicationNo} funded by ${loan.loanNo} — ${loan.currency} ${shown(amount)} ` +
      `(${shown(allocatedNow)} of ${shown(amountOf(loan.principalTxn))} drawn)`,
    sourceType: ALLOCATION_SOURCE,
    sourceId: created!.id,
    sourceNo: loan.loanNo,
    actorUserId: ctx.principal.userId,
  });
  await restateShares(tx, ctx, loan, `Commission re-shared: ${application.applicationNo} drew on ${loan.loanNo}`);
  return { id: created!.id };
}

/** The application was rejected or cancelled: its draw goes back to the loan. */
export async function release(
  tx: Tx,
  ctx: ActorContext,
  application: typeof paymentApplication.$inferSelect,
  reason: string,
) {
  const [row] = await tx
    .select()
    .from(bankLoanAllocation)
    .where(and(eq(bankLoanAllocation.paymentApplicationId, application.id), isNull(bankLoanAllocation.releasedAt)))
    .limit(1);
  if (!row) return;
  const loan = await lock(tx, row.loanId);
  // "PAYAPP-… rejected: the bank refused the file"
  const why = `${application.applicationNo} ${reason}`;
  await tx
    .update(bankLoanAllocation)
    .set({ releasedAt: new Date(), releasedBy: ctx.principal.userId, releaseReason: why })
    .where(eq(bankLoanAllocation.id, row.id));
  if (row.landedCostChargeId) {
    await tx
      .update(landedCostCharge)
      .set({ cancelledAt: new Date(), cancelledBy: ctx.principal.userId, cancelReason: why })
      .where(eq(landedCostCharge.id, row.landedCostChargeId));
  }
  await events.record(tx, {
    payableId: row.payableId,
    eventCode: 'LOAN_UNLINKED',
    summary:
      `${loan.loanNo}'s ${loan.currency} ${shown(amountOf(row.amountTxn))} released — ${why}` +
      (amountOf(row.commissionShareTxn) > 0n ? `; commission share ${shown(amountOf(row.commissionShareTxn))} withdrawn` : ''),
    sourceType: ALLOCATION_SOURCE,
    sourceId: row.id,
    sourceNo: loan.loanNo,
    actorUserId: ctx.principal.userId,
  });
  if (loan.allocationMethod === 'equal') {
    await restateShares(tx, ctx, loan, `Commission re-shared: ${application.applicationNo} released its draw on ${loan.loanNo}`);
  }
}

/** `manual` — the manager states each draw's share of the commission. */
export async function setManualShares(
  tx: Tx,
  ctx: ActorContext,
  loanId: string,
  shares: readonly { readonly allocationId: string; readonly shareTxn: bigint }[],
) {
  const loan = await lock(tx, loanId);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: loan.branchCode });
  if (loan.allocationMethod !== 'manual') {
    throw new LoanError(`${loan.loanNo} shares its commission ${loan.allocationMethod.replace(/_/g, ' ')}; shares are typed only for a manual loan.`);
  }
  const live = await tx
    .select()
    .from(bankLoanAllocation)
    .where(and(eq(bankLoanAllocation.loanId, loan.id), isNull(bankLoanAllocation.releasedAt)));
  const typed = new Map(shares.map((share) => [share.allocationId, share.shareTxn]));
  commissionShares(
    'manual',
    amountOf(loan.commissionTxn),
    amountOf(loan.principalTxn),
    live.map((row) => ({ id: row.id, amount: amountOf(row.amountTxn), manualShare: typed.get(row.id) ?? amountOf(row.commissionShareTxn) })),
  );
  for (const row of live) {
    const share = typed.get(row.id);
    if (share === undefined || share === amountOf(row.commissionShareTxn)) continue;
    // Stated here; restateShares re-issues the charge for the new figure.
    await tx
      .update(bankLoanAllocation)
      .set({ commissionShareTxn: money(share) })
      .where(eq(bankLoanAllocation.id, row.id));
    if (row.landedCostChargeId) {
      await tx
        .update(landedCostCharge)
        .set({ cancelledAt: new Date(), cancelledBy: ctx.principal.userId, cancelReason: 'Commission share restated' })
        .where(eq(landedCostCharge.id, row.landedCostChargeId));
      await tx.update(bankLoanAllocation).set({ landedCostChargeId: null }).where(eq(bankLoanAllocation.id, row.id));
    }
  }
  await restateShares(tx, ctx, loan, 'Commission share restated');
}

// ---------------------------------------------------------------------------
// The sweep — due inside the window, overdue after it (§15.6 exception)
// ---------------------------------------------------------------------------

export async function instalmentSweep(tx: Tx, asOf: string): Promise<{ due: number; overdue: number }> {
  const window = await warningDays(tx);
  const rows = await tx
    .select({ instalment: bankLoanInstalment, loanNo: bankLoan.loanNo, currency: bankLoan.currency })
    .from(bankLoanInstalment)
    .innerJoin(bankLoan, eq(bankLoan.id, bankLoanInstalment.loanId))
    .where(
      and(
        isNull(bankLoanInstalment.supersededAt),
        sql`${bankLoanInstalment.status} <> 'paid'`,
        eq(bankLoan.status, 'active'),
      ),
    );
  let due = 0;
  let overdue = 0;
  for (const { instalment, loanNo, currency } of rows) {
    const state = instalmentState(instalment, asOf, window);
    if (state !== instalment.status) {
      await tx.update(bankLoanInstalment).set({ status: state }).where(eq(bankLoanInstalment.id, instalment.id));
      if (state === 'due') due += 1;
    }
    if (state === 'overdue' && !instalment.overdueNotifiedAt) {
      overdue += 1;
      for (const payableId of await fundedPayables(tx, instalment.loanId)) {
        await events.record(tx, {
          payableId,
          eventCode: 'LOAN_INSTALMENT_OVERDUE',
          summary:
            `${loanNo} instalment ${instalment.sequence} (${currency} ${shown(amountOf(instalment.totalTxn))}) ` +
            `was due on ${instalment.dueDate} and is not paid`,
          sourceType: PERMISSION_OBJECT,
          sourceId: instalment.loanId,
          sourceNo: loanNo,
          actorUserId: null,
        });
      }
      await tx
        .update(bankLoanInstalment)
        .set({ overdueNotifiedAt: new Date() })
        .where(eq(bankLoanInstalment.id, instalment.id));
    }
  }
  return { due, overdue };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface LoanListFilter extends RegisterPaging {
  readonly view?: 'open' | 'overdue' | 'closed' | 'all';
  readonly search?: string | null;
}

/**
 * §21.10 — loan no · bank · principal · outstanding · next due · overdue flag
 * · status. One page of fifty with the true count (HD15): the view and the
 * search are in the query. Overdue is an active loan with an unpaid
 * instalment due before today.
 */
export async function listForScreen(tx: Tx, filter: LoanListFilter = {}) {
  const asOf = today();
  const unpaidPastDue = sql`exists (select 1 from bank_loan_instalment i
                               where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status <> 'paid'
                                 and i.due_date < ${asOf}::date)`;
  const view = filter.view ?? 'open';
  const where = and(
    view === 'open'
      ? inArray(bankLoan.status, ['draft', 'approved', 'active'])
      : view === 'overdue'
        ? and(eq(bankLoan.status, 'active'), unpaidPastDue)
        : view === 'closed'
          ? inArray(bankLoan.status, ['fully_repaid', 'cancelled'])
          : undefined,
    searchOf(
      [bankLoan.loanNo, bank.name, bankCashAccount.code, bankLoan.currency, bankLoan.status, bankLoan.principalTxn],
      filter.search,
    ) ?? undefined,
  );
  return registerPage({
    paging: filter,
    count: async () => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bankLoan)
        .innerJoin(bank, eq(bank.code, bankLoan.bankCode))
        .innerJoin(bankCashAccount, eq(bankCashAccount.id, bankLoan.bankCashAccountId))
        .where(where);
      return row?.n ?? 0;
    },
    rows: async ({ limit, offset }) => {
      const rows = await tx
        .select({
          id: bankLoan.id,
          loanNo: bankLoan.loanNo,
          bankName: bank.name,
          accountCode: bankCashAccount.code,
          currency: bankLoan.currency,
          principalTxn: bankLoan.principalTxn,
          commissionTxn: bankLoan.commissionTxn,
          status: bankLoan.status,
          disbursementDate: bankLoan.disbursementDate,
          maturityDate: bankLoan.maturityDate,
          createdAt: bankLoan.createdAt,
          repaidTxn: sql<string>`coalesce((select sum(i.principal_txn) from bank_loan_instalment i
                                   where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status = 'paid'), 0)::text`,
          nextDue: sql<string | null>`(select min(i.due_date)::text from bank_loan_instalment i
                                   where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status <> 'paid')`,
          nextTotal: sql<string | null>`(select i.total_txn::text from bank_loan_instalment i
                                   where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status <> 'paid'
                                   order by i.sequence limit 1)`,
          overdueCount: sql<number>`(select count(*)::int from bank_loan_instalment i
                                   where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status <> 'paid'
                                     and i.due_date < ${asOf}::date)`,
          allocatedTxn: sql<string>`bank_loan_allocated_txn(${bankLoan.id})::text`,
        })
        .from(bankLoan)
        .innerJoin(bank, eq(bank.code, bankLoan.bankCode))
        .innerJoin(bankCashAccount, eq(bankCashAccount.id, bankLoan.bankCashAccountId))
        .where(where)
        .orderBy(desc(bankLoan.createdAt), desc(bankLoan.id))
        .limit(limit)
        .offset(offset);
      return rows.map((row) => {
        const principal = amountOf(row.principalTxn);
        const live = row.status === 'active';
        return {
          ...row,
          outstandingTxn: money(row.status === 'cancelled' ? 0n : principal - amountOf(row.repaidTxn)),
          overdue: live && row.overdueCount > 0,
          nextDue: live || row.status === 'approved' ? row.nextDue : null,
        };
      });
    },
  });
}

export async function view(tx: Tx, loanNo: string) {
  const loan = await loadByNo(tx, loanNo);
  const [lender] = await tx.select().from(bank).where(eq(bank.code, loan.bankCode)).limit(1);
  const account = await accountOf(tx, loan.bankCashAccountId);
  const treatment = await treatmentOf(tx, loan.commissionTreatmentCode);
  const schedule = await scheduleOf(tx, loan.id);
  const window = await warningDays(tx);
  const allocations = await tx
    .select({
      id: bankLoanAllocation.id,
      applicationId: bankLoanAllocation.paymentApplicationId,
      applicationNo: paymentApplication.applicationNo,
      applicationStatus: paymentApplication.status,
      payableNo: payable.payableNo,
      amountTxn: bankLoanAllocation.amountTxn,
      commissionShareTxn: bankLoanAllocation.commissionShareTxn,
      createdAt: bankLoanAllocation.createdAt,
      releasedAt: bankLoanAllocation.releasedAt,
      releaseReason: bankLoanAllocation.releaseReason,
    })
    .from(bankLoanAllocation)
    .innerJoin(paymentApplication, eq(paymentApplication.id, bankLoanAllocation.paymentApplicationId))
    .innerJoin(payable, eq(payable.id, bankLoanAllocation.payableId))
    .where(eq(bankLoanAllocation.loanId, loan.id))
    .orderBy(asc(bankLoanAllocation.createdAt));
  const people = await tx
    .select({ id: appUser.id, name: appUser.displayName })
    .from(appUser)
    .where(
      inArray(
        appUser.id,
        [loan.createdBy, loan.approvedBy, loan.activatedBy, loan.closedBy].filter((v): v is string => Boolean(v)),
      ),
    );
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  const principal = amountOf(loan.principalTxn);
  const allocated = await allocatedOf(tx, loan.id);
  const todayIs = today();
  return {
    loan,
    bank: lender ?? null,
    account,
    treatment,
    schedule: schedule.map((row) => ({
      ...row,
      // What the row would say today, before tonight's sweep writes it.
      state: loan.status === 'active' ? instalmentState(row, todayIs, window) : (row.status as string),
    })),
    allocations,
    totals: {
      principal: money(principal),
      allocated: money(allocated),
      unallocated: money(unallocated(principal, allocated)),
      outstanding: money(
        outstanding(
          principal,
          schedule.map((row) => ({ status: row.status, principal: amountOf(row.principalTxn) })),
        ),
      ),
      repaidTotal: money(
        schedule.filter((row) => row.status === 'paid').reduce((sum, row) => sum + amountOf(row.totalTxn), 0n),
      ),
    },
    people: {
      createdBy: nameOf(loan.createdBy),
      approvedBy: nameOf(loan.approvedBy),
      activatedBy: nameOf(loan.activatedBy),
      closedBy: nameOf(loan.closedBy),
    },
    nextUnpaid: schedule.find((row) => row.status !== 'paid') ?? null,
  };
}

/** The New loan dialog: banks, bank accounts, treatments. */
export async function pickers(tx: Tx) {
  const banks = await tx
    .select({ code: bank.code, name: bank.name, swift: bank.swiftBic })
    .from(bank)
    .where(eq(bank.active, true))
    .orderBy(asc(bank.name));
  const accounts = await tx
    .select({
      id: bankCashAccount.id,
      code: bankCashAccount.code,
      name: bankCashAccount.name,
      currency: bankCashAccount.currency,
      bankCode: bankCashAccount.bankCode,
    })
    .from(bankCashAccount)
    .where(and(eq(bankCashAccount.active, true), eq(bankCashAccount.accountType, 'bank')))
    .orderBy(asc(bankCashAccount.code));
  const treatments = await tx
    .select({
      code: loanCommissionTreatment.code,
      name: loanCommissionTreatment.name,
      // Whether the bank keeps it out of the money it sends, and whether it
      // rides on the instalments — so the form can say what will land in the
      // account and lay the schedule out (2026-10-03).
      deducted: loanCommissionTreatment.deducted,
      spread: loanCommissionTreatment.spread,
    })
    .from(loanCommissionTreatment)
    .where(eq(loanCommissionTreatment.active, true))
    .orderBy(asc(loanCommissionTreatment.sortOrder));
  return { banks, accounts, treatments };
}

/** The loans a payment application may name: approved or disbursed, in its currency, with room. */
export async function fundingChoices(tx: Tx, currency: string) {
  const rows = await tx
    .select({
      id: bankLoan.id,
      loanNo: bankLoan.loanNo,
      status: bankLoan.status,
      currency: bankLoan.currency,
      principalTxn: bankLoan.principalTxn,
      accountId: bankLoan.bankCashAccountId,
      accountCode: bankCashAccount.code,
      bankName: bank.name,
      allocatedTxn: sql<string>`bank_loan_allocated_txn(${bankLoan.id})::text`,
    })
    .from(bankLoan)
    .innerJoin(bank, eq(bank.code, bankLoan.bankCode))
    .innerJoin(bankCashAccount, eq(bankCashAccount.id, bankLoan.bankCashAccountId))
    .where(and(inArray(bankLoan.status, ['approved', 'active']), eq(bankLoan.currency, currency)))
    .orderBy(asc(bankLoan.loanNo));
  return rows
    .map((row) => ({ ...row, unallocatedTxn: money(amountOf(row.principalTxn) - amountOf(row.allocatedTxn)) }))
    .filter((row) => amountOf(row.unallocatedTxn) > 0n);
}

/** §21.3 "Bank & funding" — the loans that fund one import, with the commission each carries. */
export async function forPayable(tx: Tx, payableId: string) {
  return tx
    .select({
      id: bankLoanAllocation.id,
      loanNo: bankLoan.loanNo,
      bankName: bank.name,
      currency: bankLoan.currency,
      applicationNo: paymentApplication.applicationNo,
      amountTxn: bankLoanAllocation.amountTxn,
      commissionShareTxn: bankLoanAllocation.commissionShareTxn,
      capitalised: bankLoan.commissionCapitalised,
      loanStatus: bankLoan.status,
      nextDue: sql<string | null>`(select min(i.due_date)::text from bank_loan_instalment i
                                    where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status <> 'paid')`,
      overdue: sql<boolean>`exists (select 1 from bank_loan_instalment i
                                    where i.loan_id = ${bankLoan.id} and i.superseded_at is null and i.status <> 'paid'
                                      and i.due_date < ${businessToday()}::date)`,
    })
    .from(bankLoanAllocation)
    .innerJoin(bankLoan, eq(bankLoan.id, bankLoanAllocation.loanId))
    .innerJoin(bank, eq(bank.code, bankLoan.bankCode))
    .innerJoin(paymentApplication, eq(paymentApplication.id, bankLoanAllocation.paymentApplicationId))
    .where(and(eq(bankLoanAllocation.payableId, payableId), isNull(bankLoanAllocation.releasedAt)))
    .orderBy(asc(bankLoanAllocation.createdAt));
}

/** The loan a payment application names, for its record. */
export async function forApplication(tx: Tx, loanId: string | null) {
  if (!loanId) return null;
  const [row] = await tx
    .select({ loanNo: bankLoan.loanNo, status: bankLoan.status })
    .from(bankLoan)
    .where(eq(bankLoan.id, loanId))
    .limit(1);
  return row ?? null;
}
