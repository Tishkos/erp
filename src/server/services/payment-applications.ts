/**
 * Payment applications — REQ-AP-001 Stage 3 (§15.2–§15.6, §21.7).
 *
 * The company's request to its bank or cashier to pay a supplier, one per
 * instalment of an import's terms. It is not a journal. It moves
 *
 *     draft ──approve──▶ approved ──send──▶ sent ──confirm──▶ confirmed ──debit──▶ debited
 *                          │  reserves          │ clock runs     │ posts the money
 *                          └──── reject / cancel (reason) ───────┘
 *
 * and at each arrow does exactly one thing the diagram draws:
 *
 *   * **approve** — the money is *reserved* on the account it will leave
 *     from (`FUNDS_RESERVED`). A reservation is nothing but this row in
 *     `approved`/`sent`; `treasury.balances` counts it as committed.
 *   * **send** — the dashed arrows are checked: a verified supplier bank
 *     account, the funds, the PD (imports), the instalment's trigger. A
 *     failure is refused with its cause; a manager may send anyway with a
 *     reason, which is stored on the row and logged.
 *   * **confirm** — SWIFT date and MT103 reference (or the transfer
 *     reference, the cash voucher, the cheque). In the same transaction the
 *     existing services create and post the accounting document: a supplier
 *     payment allocated to the import's posted invoice(s), or — when no
 *     invoice is posted yet, a deposit — a supplier advance against its
 *     purchase order. Posting date = the confirmation date. Allocation happens
 *     only here, so an invoice never reads as settled before money moved.
 *   * **debit** — the bank statement shows the money left: set by the
 *     reconciliation match (the sweep reads it) or recorded by hand.
 *
 * The maker never approves their own application, and the approver of the
 * application is the approver of the advance it may become.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  appUser,
  bank,
  bankCashAccount,
  billOfLading,
  businessPartner,
  customsPd,
  fundingSource,
  instalmentTrigger,
  partnerBankAccount,
  payable,
  payableInstalment,
  paymentApplication,
  paymentApplicationTransition,
  paymentMethod,
  shipmentContainer,
  supplierAdvance,
  supplierPayment,
} from '../db/schema';
import {
  PaymentApplicationError,
  SendRefusedError,
  accountTypeFor,
  addDays,
  assertTransition,
  confirmationEvent,
  daysBetween,
  failing,
  fundsCheck,
  instalmentStatus,
  isConfirmationKind,
  isLive,
  isReserved,
  needsPayeeAccount,
  payeeCheck,
  planAmounts,
  formatAmount as shown,
  totals,
  type ConfirmationKind,
  type InstalmentDraft,
  type SendCheck,
} from '../domain/payment-applications';
import { can } from '../domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as payables from './payables';
import * as advances from './supplier-advance';
import * as customs from './customs-pd';
import * as loans from './loans';
import * as payments from './supplier-payment';
import * as rateService from './exchange-rates';
import * as treasury from './treasury';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'payment_application';
const SEQUENCE_KEY = 'PAYMENT_APPLICATION';

const today = () => new Date().toISOString().slice(0, 10);
const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);

export class PaymentApplicationNotFoundError extends Error {
  readonly code = 'PAYMENT_APPLICATION_NOT_FOUND';
  constructor(ref: string) {
    super(`No payment application '${ref}', or it is outside the branches you may see.`);
    this.name = 'PaymentApplicationNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(paymentApplication).where(eq(paymentApplication.id, id)).limit(1);
  if (!row) throw new PaymentApplicationNotFoundError(id);
  return row;
}

export async function loadByNo(tx: Tx, applicationNo: string) {
  const [row] = await tx
    .select()
    .from(paymentApplication)
    .where(eq(paymentApplication.applicationNo, applicationNo))
    .limit(1);
  if (!row) throw new PaymentApplicationNotFoundError(applicationNo);
  return row;
}

async function methodOf(tx: Tx, code: string) {
  const [row] = await tx.select().from(paymentMethod).where(eq(paymentMethod.code, code)).limit(1);
  if (!row) throw new PaymentApplicationError(`'${code}' is not a payment method.`);
  const kind = row.confirmationKind;
  if (!isConfirmationKind(kind)) {
    throw new PaymentApplicationError(`${row.name} has no confirmation kind; set it on the payment method.`);
  }
  return { ...row, kind: kind as ConfirmationKind };
}

async function accountOf(tx: Tx, id: string) {
  const [row] = await tx.select().from(bankCashAccount).where(eq(bankCashAccount.id, id)).limit(1);
  if (!row) throw new PaymentApplicationError(`No bank or cash account with id '${id}'.`);
  return row;
}

async function transitions(tx: Tx) {
  return tx.select().from(paymentApplicationTransition);
}

async function move(tx: Tx, row: { applicationNo: string; status: string }, to: string) {
  assertTransition(row.applicationNo, await transitions(tx), row.status, to);
}

/** The import an application pays — loaded and checked for being open. */
async function openPayable(tx: Tx, payableId: string) {
  const row = await payables.load(tx, payableId);
  if (row.cancelledAt) {
    throw new PaymentApplicationError(`${row.payableNo} is cancelled; nothing more is paid against it.`);
  }
  if (row.closedAt) {
    throw new PaymentApplicationError(`${row.payableNo} is cleared; re-open it before paying more.`);
  }
  return row;
}

async function principalOf(tx: Tx, userId: string, branchCode: string): Promise<ActorContext> {
  return { principal: await authz.loadPrincipal(tx, userId), branchCode };
}

// ---------------------------------------------------------------------------
// §15.2 — the instalment plan
// ---------------------------------------------------------------------------

export interface PlanInput {
  readonly payableId: string;
  readonly rows: readonly InstalmentDraft[];
}

/** The live instalments of a payable, with their applications' statuses. */
export async function instalmentsFor(tx: Tx, payableId: string) {
  const rows = await tx
    .select({
      id: payableInstalment.id,
      sequence: payableInstalment.sequence,
      label: payableInstalment.label,
      basis: payableInstalment.basis,
      percent: payableInstalment.percent,
      amountTxn: payableInstalment.amountTxn,
      triggerCode: payableInstalment.triggerCode,
      triggerName: instalmentTrigger.name,
      triggerDays: payableInstalment.triggerDays,
      expectedDate: sql<string | null>`${payableInstalment.expectedDate}::text`,
    })
    .from(payableInstalment)
    .innerJoin(instalmentTrigger, eq(instalmentTrigger.code, payableInstalment.triggerCode))
    .where(and(eq(payableInstalment.payableId, payableId), isNull(payableInstalment.supersededAt)))
    .orderBy(asc(payableInstalment.sequence));

  const applications = rows.length
    ? await tx
        .select({ instalmentId: paymentApplication.instalmentId, status: paymentApplication.status })
        .from(paymentApplication)
        .where(inArray(paymentApplication.instalmentId, rows.map((row) => row.id)))
    : [];

  return rows.map((row) => ({
    ...row,
    status: instalmentStatus(
      applications.filter((a) => a.instalmentId === row.id).map((a) => a.status),
    ),
  }));
}

/**
 * Plans (or re-plans) the instalments. Instalments that already have a live
 * application are kept as they are; the rest are superseded, never rewritten,
 * and the new rows must bring the plan to exactly what is owed.
 */
export async function planInstalments(tx: Tx, ctx: ActorContext, input: PlanInput) {
  const row = await openPayable(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', payables.PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });
  await payables.assertLaneEditable(tx, ctx, row, 'payment');

  const current = await instalmentsFor(tx, row.id);
  const kept = current.filter((instalment) => instalment.status !== 'planned');
  const replaced = current.filter((instalment) => instalment.status === 'planned');
  const keptTxn = kept.reduce((sum, i) => sum + parseDecimal(i.amountTxn, MONEY_SCALE), 0n);

  const owed = parseDecimal(row.amountTxn, MONEY_SCALE);
  const amounts = planAmounts(owed, input.rows, keptTxn);

  const triggers = await tx.select().from(instalmentTrigger);
  const byCode = new Map(triggers.map((t) => [t.code, t]));

  if (replaced.length > 0) {
    await tx
      .update(payableInstalment)
      .set({ supersededAt: new Date(), supersededBy: ctx.principal.userId })
      .where(inArray(payableInstalment.id, replaced.map((i) => i.id)));
  }

  let sequence = kept.reduce((max, i) => Math.max(max, i.sequence), 0);
  const written: string[] = [];
  for (const [index, draft] of input.rows.entries()) {
    const trigger = byCode.get(draft.triggerCode);
    if (!trigger || !trigger.active) {
      throw new PaymentApplicationError(`'${draft.triggerCode}' is not an active instalment trigger.`);
    }
    if (trigger.needsDays && (draft.triggerDays === null || draft.triggerDays === undefined)) {
      throw new PaymentApplicationError(`${trigger.name} needs the number of days (e.g. 60).`);
    }
    // §15.2 — derived when the trigger's event is known; typed otherwise.
    const expected =
      draft.expectedDate ||
      (trigger.code === 'days_after_invoice' && draft.triggerDays != null
        ? addDays(row.documentDate, draft.triggerDays)
        : trigger.code === 'on_order'
          ? row.documentDate
          : null);

    sequence += 1;
    await tx.insert(payableInstalment).values({
      payableId: row.id,
      sequence,
      label: draft.label.trim(),
      basis: draft.basis,
      percent: draft.basis === 'percent' ? (draft.percent ?? '').trim() : null,
      amountTxn: money(amounts[index]!),
      triggerCode: trigger.code,
      triggerDays: trigger.needsDays ? (draft.triggerDays ?? null) : null,
      expectedDate: expected,
      createdBy: ctx.principal.userId,
    });
    written.push(
      `${sequence}. ${draft.label.trim()} ${draft.basis === 'percent' ? `${draft.percent}%` : ''} ${row.currency} ${shown(amounts[index]!)} — ${trigger.name}${trigger.needsDays ? ` ${draft.triggerDays}` : ''}`.replace(/\s+/g, ' '),
    );
  }

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'INSTALMENT_PLANNED',
    summary: `Instalments planned: ${written.join(' · ')}`,
    before: replaced.length
      ? { superseded: replaced.map((i) => `${i.sequence}. ${i.label} ${i.amountTxn}`) }
      : null,
    after: { instalments: written },
    actorUserId: ctx.principal.userId,
  });
  await payables.recomputeStage(tx, row.id, ctx.principal.userId);
}

// ---------------------------------------------------------------------------
// §15.3 — create
// ---------------------------------------------------------------------------

export interface CreateInput {
  readonly payableId: string;
  readonly instalmentId?: string | null;
  readonly paymentMethodCode: string;
  readonly bankCashAccountId: string;
  readonly payeeBankAccountId?: string | null;
  readonly fundingSourceCode?: string | null;
  readonly loanId?: string | null;
  /** In the payable's currency. Defaults to the instalment's amount. */
  readonly amountTxn?: bigint | null;
  readonly note?: string | null;
  /** The date the IQD figure is converted on; today by default. */
  readonly onDate?: string | null;
}

/** What is still to be asked of the bank: owed less every live application. */
async function unappliedOf(tx: Tx, payableRow: { id: string; amountTxn: string }, exceptId?: string) {
  const rows = await tx
    .select({ id: paymentApplication.id, status: paymentApplication.status, amountTxn: paymentApplication.amountTxn })
    .from(paymentApplication)
    .where(eq(paymentApplication.payableId, payableRow.id));
  const live = rows
    .filter((r) => isLive(r.status) && r.id !== exceptId)
    .reduce((sum, r) => sum + parseDecimal(r.amountTxn, MONEY_SCALE), 0n);
  return parseDecimal(payableRow.amountTxn, MONEY_SCALE) - live;
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateInput) {
  const row = await openPayable(tx, input.payableId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: row.branchCode });
  await payables.assertLaneEditable(tx, ctx, row, 'payment');

  const method = await methodOf(tx, input.paymentMethodCode);
  if (!method.active) throw new PaymentApplicationError(`${method.name} is no longer offered.`);

  const account = await accountOf(tx, input.bankCashAccountId);
  if (!account.active) throw new PaymentApplicationError(`${account.code} is closed; no payment leaves it.`);
  if (account.accountType !== accountTypeFor(method.kind)) {
    throw new PaymentApplicationError(
      method.kind === 'cash'
        ? `${method.name} is paid from a cash account, and ${account.code} is a bank account.`
        : `${method.name} is paid from a bank account, and ${account.code} is a cash account.`,
    );
  }
  // D3 — no USD from an IQD account.
  if (account.currency !== row.currency) {
    throw new PaymentApplicationError(
      `${account.code} holds ${account.currency} and ${row.payableNo} is in ${row.currency} (D3). ` +
        `Pay from an account in ${row.currency}.`,
    );
  }

  let payeeId: string | null = null;
  if (input.payeeBankAccountId) {
    const [payee] = await tx
      .select()
      .from(partnerBankAccount)
      .where(eq(partnerBankAccount.id, input.payeeBankAccountId))
      .limit(1);
    if (!payee) throw new PaymentApplicationError('No such supplier bank account.');
    if (payee.partnerId !== row.supplierId) {
      throw new PaymentApplicationError('That bank account belongs to a different partner.');
    }
    payeeId = payee.id;
  }

  const fundingCode = input.fundingSourceCode || 'own_funds';
  const [funding] = await tx.select().from(fundingSource).where(eq(fundingSource.code, fundingCode)).limit(1);
  if (!funding || !funding.active) {
    throw new PaymentApplicationError(`'${fundingCode}' is not an active funding source.`);
  }
  if (funding.requiresLoan && !input.loanId) {
    throw new PaymentApplicationError(`${funding.name} names the loan that funds it.`);
  }
  if (!funding.requiresLoan && input.loanId) {
    throw new PaymentApplicationError(`${funding.name} is not a loan; choose the loan as the funding source.`);
  }

  let instalmentId: string | null = null;
  let amountTxn = input.amountTxn ?? null;
  if (input.instalmentId) {
    const [instalment] = await tx
      .select()
      .from(payableInstalment)
      .where(eq(payableInstalment.id, input.instalmentId))
      .limit(1);
    if (!instalment || instalment.payableId !== row.id || instalment.supersededAt) {
      throw new PaymentApplicationError(`That instalment is not part of ${row.payableNo}'s current plan.`);
    }
    const [existing] = await tx
      .select({ no: paymentApplication.applicationNo, status: paymentApplication.status })
      .from(paymentApplication)
      .where(
        and(
          eq(paymentApplication.instalmentId, instalment.id),
          sql`${paymentApplication.status} not in ('rejected','cancelled')`,
        ),
      )
      .limit(1);
    if (existing) {
      throw new PaymentApplicationError(
        `Instalment ${instalment.sequence} already has ${existing.no} (${existing.status}). ` +
          'A second application is made only after the first is rejected or cancelled (§15.3).',
      );
    }
    instalmentId = instalment.id;
    amountTxn = amountTxn ?? parseDecimal(instalment.amountTxn, MONEY_SCALE);
  }
  if (!amountTxn || amountTxn <= 0n) {
    throw new PaymentApplicationError('State the amount to pay, in the import’s currency.');
  }

  const owed = parseDecimal(row.amountTxn, MONEY_SCALE);
  if (owed > 0n) {
    const unapplied = await unappliedOf(tx, row);
    if (amountTxn > unapplied) {
      throw new PaymentApplicationError(
        `${row.currency} ${money(amountTxn)} is more than is left to ask the bank for on ${row.payableNo} ` +
          `(${row.currency} ${money(unapplied)}). Applications never total more than is owed.`,
      );
    }
  }

  // §15.3 / §15.7 — a loan funds a payment in its own currency, from the
  // account its money landed in, while it has the room.
  if (input.loanId) {
    await loans.assertCanFund(tx, {
      loanId: input.loanId,
      currency: row.currency,
      bankCashAccountId: account.id,
      amountTxn,
    });
  }

  const onDate = input.onDate || today();
  const converted = await rateService.convertOn(tx, amountTxn, row.currency, onDate);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: row.branchCode, year: Number(onDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(paymentApplication)
    .values({
      applicationNo: allocated.documentNo,
      payableId: row.id,
      instalmentId,
      branchCode: row.branchCode,
      supplierId: row.supplierId,
      paymentMethodCode: method.code,
      bankCashAccountId: account.id,
      payeeBankAccountId: payeeId,
      fundingSourceCode: fundingCode,
      loanId: input.loanId ?? null,
      currency: row.currency,
      amountTxn: money(amountTxn),
      amountIqd: money(converted.amountIqd),
      rateId: converted.txnRateId ?? null,
      note: input.note?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: paymentApplication.id });

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'PAYMENT_DRAFTED',
    summary: `${allocated.documentNo} drafted — ${method.name} from ${account.code}, ${row.currency} ${shown(amountTxn)}`,
    sourceType: PERMISSION_OBJECT,
    sourceId: created!.id,
    sourceNo: allocated.documentNo,
    after: { method: method.code, account: account.code, amountTxn: money(amountTxn) },
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_application.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: row.branchCode,
    after: {
      applicationNo: allocated.documentNo,
      payableNo: row.payableNo,
      method: method.code,
      account: account.code,
      currency: row.currency,
      amountTxn: money(amountTxn),
      amountIqd: money(converted.amountIqd),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, applicationNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// §15.3 — approve: the money is reserved
// ---------------------------------------------------------------------------

export async function approve(tx: Tx, ctx: ActorContext, id: string) {
  const row = await load(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode });
  await move(tx, row, 'approved');
  if (row.createdBy === ctx.principal.userId) {
    throw new PaymentApplicationError(
      `${row.applicationNo}: the person who prepared a payment application cannot approve it — ` +
        'approving it reserves company money (§5.2).',
    );
  }
  const owner = await openPayable(tx, row.payableId);
  await payables.assertLaneEditable(tx, ctx, owner, 'payment');

  const account = await accountOf(tx, row.bankCashAccountId);
  const position = await treasury.accountPosition(tx, account.id);

  await tx
    .update(paymentApplication)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(paymentApplication.id, id));
  // §15.7 — approval draws on the loan that funds it (refused while its money
  // has not arrived, or when it has no room left).
  if (row.loanId) await loans.allocate(tx, ctx, row);

  await events.record(tx, {
    payableId: row.payableId,
    eventCode: 'FUNDS_RESERVED',
    summary:
      `${row.applicationNo} approved — ${row.currency} ${shown(parseDecimal(row.amountTxn, MONEY_SCALE))} ` +
      `reserved on ${account.code} (available before: ${shown(position.availableIqd)} IQD)`,
    sourceType: PERMISSION_OBJECT,
    sourceId: row.id,
    sourceNo: row.applicationNo,
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_application.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'approved', reservedIqd: row.amountIqd },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, row.payableId, ctx.principal.userId);
}

// ---------------------------------------------------------------------------
// §15.3 — the checks, and send
// ---------------------------------------------------------------------------

/** The dashed-arrow checks, as they stand now — shown on the record before Send. */
export async function checksFor(tx: Tx, row: typeof paymentApplication.$inferSelect): Promise<SendCheck[]> {
  const owner = await payables.load(tx, row.payableId);
  const method = await methodOf(tx, row.paymentMethodCode);
  const account = await accountOf(tx, row.bankCashAccountId);

  // 1 — Needs validated PD (imports only): the PD register (Stage 4).
  const pd: SendCheck =
    owner.payableTypeCode === 'import'
      ? await pdCheck(tx, row)
      : { code: 'pd_validated', outcome: 'not_applicable', detail: 'Only imports are paid against a PD.' };

  // 2 — Needs funds.
  const position = await treasury.accountPosition(tx, account.id);
  const funds = fundsCheck({
    accountCode: account.code,
    availableIqd: position.availableIqd,
    ownReservationIqd: isReserved(row.status) ? parseDecimal(row.amountIqd, MONEY_SCALE) : 0n,
    amountIqd: parseDecimal(row.amountIqd, MONEY_SCALE),
  });

  // 3 — Verified supplier bank account (SWIFT / transfer).
  const [payee] = row.payeeBankAccountId
    ? await tx.select().from(partnerBankAccount).where(eq(partnerBankAccount.id, row.payeeBankAccountId)).limit(1)
    : [];
  const payeeResult = payeeCheck({
    kind: method.kind,
    account: payee ?? null,
    belongsToSupplier: payee ? payee.partnerId === row.supplierId : false,
  });

  // 4 — The instalment's trigger: a B/L for the B/L triggers, nothing sailed
  //     for "before shipment" (§15.3 check 3).
  const trigger = await triggerCheck(tx, row);

  return [pd, funds, payeeResult, trigger];
}

/**
 * Check 1 — needs a validated PD (§15.3): the PD register's answer for the
 * day the file goes to the bank, from the account the money leaves.
 */
async function pdCheck(tx: Tx, row: typeof paymentApplication.$inferSelect): Promise<SendCheck> {
  const account = await accountOf(tx, row.bankCashAccountId);
  const readiness = await customs.paymentCheck(tx, row.payableId, {
    asOf: row.applicationDate ?? today(),
    accountBankCode: account.bankCode,
  });
  return { code: 'pd_validated', outcome: readiness.outcome, detail: readiness.detail };
}

async function triggerCheck(tx: Tx, row: typeof paymentApplication.$inferSelect): Promise<SendCheck> {
  if (!row.instalmentId) {
    return { code: 'instalment_trigger', outcome: 'not_applicable', detail: 'Not tied to an instalment.' };
  }
  const [instalment] = await tx
    .select({ triggerCode: payableInstalment.triggerCode, name: instalmentTrigger.name, expected: payableInstalment.expectedDate })
    .from(payableInstalment)
    .innerJoin(instalmentTrigger, eq(instalmentTrigger.code, payableInstalment.triggerCode))
    .where(eq(payableInstalment.id, row.instalmentId))
    .limit(1);
  if (!instalment) {
    return { code: 'instalment_trigger', outcome: 'not_applicable', detail: 'Not tied to an instalment.' };
  }
  if (instalment.triggerCode.startsWith('against_bl')) {
    // §15.3 check 3 — against the B/L means a B/L exists.
    const [bl] = await tx
      .select({ blNo: billOfLading.blNo, blDate: billOfLading.blDate })
      .from(billOfLading)
      .where(and(eq(billOfLading.payableId, row.payableId), isNull(billOfLading.cancelledAt)))
      .orderBy(asc(billOfLading.blDate))
      .limit(1);
    return bl
      ? { code: 'instalment_trigger', outcome: 'pass', detail: `${instalment.name}: B/L ${bl.blNo} issued on ${bl.blDate}.` }
      : {
          code: 'instalment_trigger',
          outcome: 'fail',
          detail: `${instalment.name}: no B/L is recorded on the import yet — the bank pays this one against the B/L.`,
        };
  }
  if (instalment.triggerCode === 'before_shipment') {
    // …and before shipment means nothing has sailed.
    const [sailed] = await tx
      .select({ containerNo: shipmentContainer.containerNo, departedOn: shipmentContainer.departedOn })
      .from(shipmentContainer)
      .where(
        and(
          eq(shipmentContainer.payableId, row.payableId),
          isNull(shipmentContainer.cancelledAt),
          sql`${shipmentContainer.departedOn} is not null`,
        ),
      )
      .limit(1);
    return sailed
      ? {
          code: 'instalment_trigger',
          outcome: 'fail',
          detail: `${instalment.name}: ${sailed.containerNo} sailed on ${sailed.departedOn} — the goods have shipped.`,
        }
      : { code: 'instalment_trigger', outcome: 'pass', detail: `${instalment.name}: nothing has sailed yet.` };
  }
  return { code: 'instalment_trigger', outcome: 'pass', detail: `${instalment.name}.` };
}

export interface SendInput {
  readonly applicationDate: string;
  readonly bankReference?: string | null;
  /** A manager's reason to send although a check fails (§15.3). */
  readonly overrideReason?: string | null;
}

export async function send(tx: Tx, ctx: ActorContext, id: string, input: SendInput) {
  const row = await load(tx, id);
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, { branchCode: row.branchCode });
  await move(tx, row, 'sent');
  if (!input.applicationDate) {
    throw new PaymentApplicationError('Give the date the file went to the bank.');
  }
  const owner = await openPayable(tx, row.payableId);
  await payables.assertLaneEditable(tx, ctx, owner, 'payment');

  const account = await accountOf(tx, row.bankCashAccountId);
  // D3 again — the account may have been changed since the draft.
  if (account.currency !== row.currency || !account.active) {
    throw new PaymentApplicationError(`${account.code} can no longer pay ${row.currency}.`);
  }

  // The IQD figure at the accounting rate of the day the file went (§15.3).
  const converted = await rateService.convertOn(
    tx,
    parseDecimal(row.amountTxn, MONEY_SCALE),
    row.currency,
    input.applicationDate,
  );
  const atDate = { ...row, amountIqd: money(converted.amountIqd), applicationDate: input.applicationDate };

  const checks = await checksFor(tx, atDate);
  const failed = failing(checks);
  const reason = input.overrideReason?.trim() ?? '';
  if (failed.length > 0) {
    const isManager = can(ctx.principal, 'approve', PERMISSION_OBJECT);
    if (!reason || !isManager) throw new SendRefusedError(row.applicationNo, failed);
  }

  const method = await methodOf(tx, row.paymentMethodCode);
  // §15.3 — the PD the bank pays against, recorded on the application.
  const owner2 = await payables.load(tx, row.payableId);
  const pd =
    owner2.payableTypeCode === 'import'
      ? await customs.paymentCheck(tx, row.payableId, {
          asOf: input.applicationDate,
          accountBankCode: account.bankCode,
        })
      : null;
  await tx
    .update(paymentApplication)
    .set({
      status: 'sent',
      applicationDate: input.applicationDate,
      pdId: pd?.pdId ?? null,
      bankReference: input.bankReference?.trim() || null,
      amountIqd: money(converted.amountIqd),
      rateId: converted.txnRateId ?? row.rateId,
      sentBy: ctx.principal.userId,
      sentAt: new Date(),
      ...(failed.length > 0
        ? {
            overriddenChecks: failed.map((check) => check.code),
            overrideReason: reason,
            overrideBy: ctx.principal.userId,
            overrideAt: new Date(),
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(paymentApplication.id, id));

  for (const check of failed) {
    await events.record(tx, {
      payableId: row.payableId,
      eventCode: 'CHECK_OVERRIDDEN',
      summary: `${row.applicationNo} sent although: ${check.detail} Reason: ${reason}`,
      sourceType: PERMISSION_OBJECT,
      sourceId: row.id,
      sourceNo: row.applicationNo,
      actorUserId: ctx.principal.userId,
    });
  }
  await events.record(tx, {
    payableId: row.payableId,
    eventCode: 'PAYMENT_APPLIED',
    summary:
      `${row.applicationNo} sent to ${account.code} on ${input.applicationDate} — ${method.name}, ` +
      `${row.currency} ${shown(parseDecimal(row.amountTxn, MONEY_SCALE))}` +
      (input.bankReference?.trim() ? `, bank ref ${input.bankReference.trim()}` : ''),
    sourceType: PERMISSION_OBJECT,
    sourceId: row.id,
    sourceNo: row.applicationNo,
    actorUserId: ctx.principal.userId,
  });
  if (method.kind === 'swift') {
    await events.record(tx, {
      payableId: row.payableId,
      eventCode: 'SWIFT_PENDING',
      summary: `SWIFT pending — ${row.applicationNo}: the clock runs until the bank confirms; NOT PAID`,
      sourceType: PERMISSION_OBJECT,
      sourceId: row.id,
      sourceNo: row.applicationNo,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_application.sent',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: {
      status: 'sent',
      applicationDate: input.applicationDate,
      overridden: failed.map((check) => check.code),
    },
    reason: failed.length > 0 ? reason : null,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, row.payableId, ctx.principal.userId);
}

// ---------------------------------------------------------------------------
// §15.4 — confirm: the money left, and the books say so
// ---------------------------------------------------------------------------

export interface ConfirmInput {
  /** SWIFT date / transfer date / voucher date / cheque date. */
  readonly confirmedOn: string;
  /** MT103 reference / bank reference / voucher no / cheque no. */
  readonly reference: string;
}

export async function confirm(tx: Tx, ctx: ActorContext, id: string, input: ConfirmInput) {
  const row = await load(tx, id);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: row.branchCode });
  await move(tx, row, 'confirmed');
  const method = await methodOf(tx, row.paymentMethodCode);

  const reference = input.reference?.trim() ?? '';
  if (!input.confirmedOn) {
    throw new PaymentApplicationError(
      method.kind === 'swift' ? 'Give the SWIFT date.' : 'Give the date the money was paid.',
    );
  }
  if (!reference) {
    throw new PaymentApplicationError(
      method.kind === 'swift'
        ? 'Give the SWIFT (MT103) reference from the bank’s copy.'
        : method.kind === 'cash'
          ? 'Give the cash voucher number.'
          : method.kind === 'cheque'
            ? 'Give the cheque number.'
            : 'Give the bank’s transfer reference.',
    );
  }
  if (row.applicationDate && input.confirmedOn < row.applicationDate) {
    throw new PaymentApplicationError(
      `The money cannot have left on ${input.confirmedOn}, before the file went to the bank on ${row.applicationDate}.`,
    );
  }

  const owner = await payables.load(tx, row.payableId);
  const amountTxn = parseDecimal(row.amountTxn, MONEY_SCALE);
  // The posting carries the rate of its own date.
  const converted = await rateService.convertOn(tx, amountTxn, row.currency, input.confirmedOn);
  const amountIqd = converted.amountIqd;
  const note = `${row.applicationNo} — ${method.name} ${reference}`;

  // Posted invoices of this import still owing, oldest first.
  const invoices = await tx
    .select()
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.payableId, row.payableId),
        inArray(apInvoice.status, ['posted', 'partially_executed']),
        isNull(apInvoice.reversedAt),
      ),
    )
    .orderBy(asc(apInvoice.invoiceDate), asc(apInvoice.invoiceNo));
  const owing = invoices.filter((invoice) => payments.outstandingOn(invoice) > 0n);

  let supplierPaymentId: string | null = null;
  let supplierAdvanceId: string | null = null;
  let documentNo: string;

  if (owing.length > 0) {
    // An invoice is posted: a supplier payment, allocated to it.
    const created = await payments.create(tx, ctx, {
      supplierId: row.supplierId,
      bankCashAccountId: row.bankCashAccountId,
      branchCode: row.branchCode,
      paymentDate: input.confirmedOn,
      amountIqd,
      currency: row.currency,
      reference,
      note,
    });
    let left = amountIqd;
    for (const invoice of owing) {
      if (left <= 0n) break;
      const share = payments.outstandingOn(invoice) < left ? payments.outstandingOn(invoice) : left;
      await payments.allocate(tx, ctx, { supplierPaymentId: created.id, apInvoiceId: invoice.id, amountIqd: share });
      left -= share;
    }
    await payments.post(tx, ctx, created.id);
    await tx.update(supplierPayment).set({ amountTxn: money(amountTxn) }).where(eq(supplierPayment.id, created.id));
    supplierPaymentId = created.id;
    documentNo = created.paymentNo;
  } else {
    // Deposit before the invoice is posted: a supplier advance against the
    // import's purchase order — requested by the application's maker,
    // approved by its approver, paid by whoever confirms (§15.4).
    if (!owner.purchaseOrderId) {
      throw new PaymentApplicationError(
        `${owner.payableNo} has no purchase order, so a deposit cannot be recorded against it. ` +
          'Post the invoice first and confirm again.',
      );
    }
    if (!row.approvedBy) throw new PaymentApplicationError(`${row.applicationNo} was never approved.`);
    const maker = await principalOf(tx, row.createdBy, row.branchCode);
    const approver = await principalOf(tx, row.approvedBy, row.branchCode);
    const requested = await advances.request(tx, maker, {
      purchaseOrderId: owner.purchaseOrderId,
      branchCode: row.branchCode,
      requestDate: row.applicationDate ?? input.confirmedOn,
      amountIqd,
      currency: row.currency,
      reason: note,
    });
    await tx
      .update(supplierAdvance)
      .set({ payableId: row.payableId, amountTxn: money(amountTxn) })
      .where(eq(supplierAdvance.id, requested.id));
    await advances.approve(tx, approver, requested.id);
    await advances.pay(tx, ctx, requested.id, input.confirmedOn, row.bankCashAccountId);
    supplierAdvanceId = requested.id;
    documentNo = requested.advanceNo;
  }

  await tx
    .update(paymentApplication)
    .set({
      status: 'confirmed',
      confirmedOn: input.confirmedOn,
      confirmationReference: reference,
      amountIqd: money(amountIqd),
      rateId: converted.txnRateId ?? row.rateId,
      supplierPaymentId,
      supplierAdvanceId,
      confirmedBy: ctx.principal.userId,
      confirmedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(paymentApplication.id, id));

  const label =
    method.kind === 'swift'
      ? `SWIFT confirmed — ${row.applicationNo}, SWIFT date ${input.confirmedOn}, ref ${reference}`
      : method.kind === 'cash'
        ? `Cash paid — ${row.applicationNo}, voucher ${reference} on ${input.confirmedOn}`
        : method.kind === 'cheque'
          ? `Cheque paid — ${row.applicationNo}, cheque ${reference} on ${input.confirmedOn}`
          : `Transfer confirmed — ${row.applicationNo}, ref ${reference} on ${input.confirmedOn}`;
  await events.record(tx, {
    payableId: row.payableId,
    eventCode: confirmationEvent(method.kind),
    summary: `${label}: ${row.currency} ${shown(amountTxn)} PAID, posted as ${documentNo}; reservation released`,
    sourceType: PERMISSION_OBJECT,
    sourceId: row.id,
    sourceNo: row.applicationNo,
    after: { documentNo, amountIqd: money(amountIqd) },
    actorUserId: ctx.principal.userId,
  });

  // §15.4 — Fully paid, derived.
  const summary = await totalsFor(tx, row.payableId);
  if (summary.fullyPaid) {
    await events.record(tx, {
      payableId: row.payableId,
      eventCode: 'FULLY_PAID',
      summary: `Fully paid — ${owner.currency} ${shown(summary.paidTxn)} of ${owner.currency} ${shown(parseDecimal(owner.amountTxn, MONEY_SCALE))}`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_application.confirmed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: {
      status: 'confirmed',
      confirmedOn: input.confirmedOn,
      reference,
      documentNo,
      amountIqd: money(amountIqd),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, row.payableId, ctx.principal.userId);
  return { documentNo, supplierPaymentId, supplierAdvanceId };
}

// ---------------------------------------------------------------------------
// §15.4 / §15.6 — debit final
// ---------------------------------------------------------------------------

export async function recordDebit(
  tx: Tx,
  ctx: ActorContext | null,
  id: string,
  input: { debitDate: string; statementLineId?: string | null },
) {
  const row = await load(tx, id);
  if (ctx) await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: row.branchCode });
  await move(tx, row, 'debited');
  if (!input.debitDate) throw new PaymentApplicationError('Give the date the statement shows the debit.');
  if (row.confirmedOn && input.debitDate < row.confirmedOn) {
    throw new PaymentApplicationError(
      `A debit on ${input.debitDate} is before the payment was confirmed on ${row.confirmedOn}.`,
    );
  }
  await tx
    .update(paymentApplication)
    .set({
      status: 'debited',
      debitDate: input.debitDate,
      statementLineId: input.statementLineId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(paymentApplication.id, id));
  await events.record(tx, {
    payableId: row.payableId,
    eventCode: 'DEBIT_FINAL',
    summary: `Debit final — ${row.applicationNo} seen on the bank statement on ${input.debitDate}${
      input.statementLineId ? ' (reconciliation match)' : ''
    }`,
    sourceType: PERMISSION_OBJECT,
    sourceId: row.id,
    sourceNo: row.applicationNo,
    actorUserId: ctx?.principal.userId ?? null,
  });
  await audit.record(tx, {
    actorUserId: ctx?.principal.userId ?? null,
    action: 'payment_application.debited',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'debited', debitDate: input.debitDate },
    outcome: 'success',
    requestId: ctx?.requestId ?? null,
  });
  await payables.recomputeStage(tx, row.payableId, ctx?.principal.userId ?? null);
}

/**
 * §15.4 — the bank reconciliation matched the payment's bank line to a
 * statement line: the debit is final. Run by the daily sweep; idempotent,
 * because only `confirmed` rows are read and each becomes `debited`.
 */
export async function syncDebits(tx: Tx): Promise<number> {
  const result = await tx.execute(sql`
    select pa.id, min(sl.value_date)::text as "debitDate", min(sl.id::text) as "statementLineId"
      from payment_application pa
      left join supplier_payment sp on sp.id = pa.supplier_payment_id
      left join supplier_advance sa on sa.id = pa.supplier_advance_id
      join bank_cash_account b on b.id = pa.bank_cash_account_id
      join journal_line jl on jl.journal_entry_id = coalesce(sp.journal_entry_id, sa.journal_entry_id)
                          and jl.account_id = b.gl_account_id
      join bank_reconciliation_match_line ml on ml.journal_line_id = jl.id
      join bank_reconciliation_match m on m.id = ml.match_id and m.state = 'confirmed'
      join bank_reconciliation_match_line sml on sml.match_id = m.id and sml.statement_line_id is not null
      join bank_statement_line sl on sl.id = sml.statement_line_id
     where pa.status = 'confirmed'
     group by pa.id`);
  const rows = result.rows as { id: string; debitDate: string; statementLineId: string }[];
  for (const row of rows) {
    await recordDebit(tx, null, row.id, { debitDate: row.debitDate, statementLineId: row.statementLineId });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Reject / cancel — with a reason; the reservation is released
// ---------------------------------------------------------------------------

async function close(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  to: 'rejected' | 'cancelled',
  reason: string,
) {
  const row = await load(tx, id);
  // The bank's refusal, or the manager's, is an approver's act; withdrawing
  // one's own draft is the maker's.
  const verb = to === 'rejected' ? 'approve' : row.status === 'draft' ? 'edit_draft' : 'reverse_cancel';
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode: row.branchCode });
  await move(tx, row, to);
  const text = reason?.trim() ?? '';
  if (!text) throw new PaymentApplicationError(`Say why ${row.applicationNo} is ${to}.`);

  await tx
    .update(paymentApplication)
    .set({
      status: to,
      closedReason: text,
      closedBy: ctx.principal.userId,
      closedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(paymentApplication.id, id));

  await events.record(tx, {
    payableId: row.payableId,
    eventCode: to === 'rejected' ? 'PAYMENT_REJECTED' : 'PAYMENT_CANCELLED',
    summary: `${row.applicationNo} ${to}: ${text}`,
    sourceType: PERMISSION_OBJECT,
    sourceId: row.id,
    sourceNo: row.applicationNo,
    actorUserId: ctx.principal.userId,
  });
  // §15.7 — the loan's draw goes back to it.
  if (row.loanId) await loans.release(tx, ctx, row, `${to}: ${text}`);
  if (isReserved(row.status)) {
    await events.record(tx, {
      payableId: row.payableId,
      eventCode: 'FUNDS_RELEASED',
      summary: `Reservation of ${row.currency} ${shown(parseDecimal(row.amountTxn, MONEY_SCALE))} released — ${row.applicationNo} ${to}`,
      sourceType: PERMISSION_OBJECT,
      sourceId: row.id,
      sourceNo: row.applicationNo,
      actorUserId: ctx.principal.userId,
    });
  }
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `payment_application.${to}`,
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: to },
    reason: text,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, row.payableId, ctx.principal.userId);
}

export const reject = (tx: Tx, ctx: ActorContext, id: string, reason: string) =>
  close(tx, ctx, id, 'rejected', reason);
export const cancel = (tx: Tx, ctx: ActorContext, id: string, reason: string) =>
  close(tx, ctx, id, 'cancelled', reason);

// ---------------------------------------------------------------------------
// §15.5 — Applied / Paid / Remaining
// ---------------------------------------------------------------------------

export async function totalsFor(tx: Tx, payableId: string) {
  const [owner] = await tx
    .select({ amountTxn: payable.amountTxn })
    .from(payable)
    .where(eq(payable.id, payableId))
    .limit(1);
  const rows = await tx
    .select({ status: paymentApplication.status, amountTxn: paymentApplication.amountTxn, amountIqd: paymentApplication.amountIqd })
    .from(paymentApplication)
    .where(eq(paymentApplication.payableId, payableId));
  return totals(
    parseDecimal(owner?.amountTxn ?? '0', MONEY_SCALE),
    rows.map((row) => ({
      status: row.status,
      amountTxn: parseDecimal(row.amountTxn, MONEY_SCALE),
      amountIqd: parseDecimal(row.amountIqd, MONEY_SCALE),
    })),
  );
}

// ---------------------------------------------------------------------------
// Reading — the list, the record, the import's Payments section
// ---------------------------------------------------------------------------

export interface ListFilter {
  readonly status?: string | null;
  readonly payableId?: string | null;
}

export async function list(tx: Tx, filter: ListFilter = {}) {
  const asOf = today();
  const rows = await tx
    .select({
      id: paymentApplication.id,
      applicationNo: paymentApplication.applicationNo,
      status: paymentApplication.status,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      methodName: paymentMethod.name,
      methodKind: paymentMethod.confirmationKind,
      accountCode: bankCashAccount.code,
      accountName: bankCashAccount.name,
      bankName: bank.name,
      currency: paymentApplication.currency,
      amountTxn: paymentApplication.amountTxn,
      amountIqd: paymentApplication.amountIqd,
      applicationDate: sql<string | null>`${paymentApplication.applicationDate}::text`,
      confirmedOn: sql<string | null>`${paymentApplication.confirmedOn}::text`,
      createdAt: paymentApplication.createdAt,
      branchCode: paymentApplication.branchCode,
    })
    .from(paymentApplication)
    .innerJoin(payable, eq(payable.id, paymentApplication.payableId))
    .innerJoin(businessPartner, eq(businessPartner.id, paymentApplication.supplierId))
    .innerJoin(paymentMethod, eq(paymentMethod.code, paymentApplication.paymentMethodCode))
    .innerJoin(bankCashAccount, eq(bankCashAccount.id, paymentApplication.bankCashAccountId))
    .leftJoin(bank, eq(bank.code, bankCashAccount.bankCode))
    .where(
      and(
        filter.status ? eq(paymentApplication.status, filter.status as never) : undefined,
        filter.payableId ? eq(paymentApplication.payableId, filter.payableId) : undefined,
      ),
    )
    .orderBy(desc(paymentApplication.createdAt));

  const withDays = rows.map((row) => ({
    ...row,
    daysWaiting: row.status === 'sent' && row.applicationDate ? daysBetween(row.applicationDate, asOf) : null,
  }));
  // §21.7 — sorted by days waiting: the longest-waiting SWIFT first.
  return withDays.sort((a, b) => (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1));
}

export async function view(tx: Tx, applicationNo: string) {
  const row = await loadByNo(tx, applicationNo);
  const owner = await payables.load(tx, row.payableId);
  const method = await methodOf(tx, row.paymentMethodCode);
  const account = await accountOf(tx, row.bankCashAccountId);
  const [accountBank] = account.bankCode
    ? await tx.select().from(bank).where(eq(bank.code, account.bankCode)).limit(1)
    : [];
  const [supplier] = await tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, row.supplierId))
    .limit(1);
  const [payee] = row.payeeBankAccountId
    ? await tx.select().from(partnerBankAccount).where(eq(partnerBankAccount.id, row.payeeBankAccountId)).limit(1)
    : [];
  const [instalment] = row.instalmentId
    ? await tx
        .select({
          sequence: payableInstalment.sequence,
          label: payableInstalment.label,
          triggerName: instalmentTrigger.name,
          amountTxn: payableInstalment.amountTxn,
        })
        .from(payableInstalment)
        .innerJoin(instalmentTrigger, eq(instalmentTrigger.code, payableInstalment.triggerCode))
        .where(eq(payableInstalment.id, row.instalmentId))
        .limit(1)
    : [];
  const [funding] = await tx
    .select({ name: fundingSource.name })
    .from(fundingSource)
    .where(eq(fundingSource.code, row.fundingSourceCode))
    .limit(1);
  const [paymentDoc] = row.supplierPaymentId
    ? await tx
        .select({ no: supplierPayment.paymentNo })
        .from(supplierPayment)
        .where(eq(supplierPayment.id, row.supplierPaymentId))
        .limit(1)
    : [];
  const [advanceDoc] = row.supplierAdvanceId
    ? await tx
        .select({ no: supplierAdvance.advanceNo })
        .from(supplierAdvance)
        .where(eq(supplierAdvance.id, row.supplierAdvanceId))
        .limit(1)
    : [];

  const [pdRow] = row.pdId
    ? await tx
        .select({ pdNo: customsPd.pdNo, year: customsPd.registrationYear })
        .from(customsPd)
        .where(eq(customsPd.id, row.pdId))
        .limit(1)
    : [];

  const people = await tx
    .select({ id: appUser.id, name: appUser.displayName })
    .from(appUser)
    .where(
      inArray(
        appUser.id,
        [row.createdBy, row.approvedBy, row.sentBy, row.confirmedBy, row.closedBy, row.overrideBy].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    );
  const nameOf = (userId: string | null) => people.find((p) => p.id === userId)?.name ?? null;

  const checks = ['draft', 'approved'].includes(row.status) ? await checksFor(tx, row) : [];
  const position = await treasury.accountPosition(tx, account.id);

  // §15.4 — what Confirm will post: a payment against the posted invoice(s),
  // or, while none is posted, a deposit (supplier advance) against the order.
  const owing = await tx
    .select({ invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.payableId, row.payableId),
        inArray(apInvoice.status, ['posted', 'partially_executed']),
        isNull(apInvoice.reversedAt),
        sql`${apInvoice.totalIqd} > ${apInvoice.settledAmountIqd}`,
      ),
    );

  return {
    application: row,
    payable: owner,
    method,
    account,
    accountBank: accountBank ?? null,
    supplier: supplier ?? null,
    payee: payee ?? null,
    instalment: instalment ?? null,
    fundingName: funding?.name ?? row.fundingSourceCode,
    loan: await loans.forApplication(tx, row.loanId),
    pd: pdRow ?? null,
    documentNo: paymentDoc?.no ?? advanceDoc?.no ?? null,
    documentKind: paymentDoc ? ('payment' as const) : advanceDoc ? ('advance' as const) : null,
    people: {
      createdBy: nameOf(row.createdBy),
      approvedBy: nameOf(row.approvedBy),
      sentBy: nameOf(row.sentBy),
      confirmedBy: nameOf(row.confirmedBy),
      closedBy: nameOf(row.closedBy),
      overrideBy: nameOf(row.overrideBy),
    },
    checks,
    position,
    confirmPostsAs: owing.length > 0 ? ('payment' as const) : ('advance' as const),
    owingInvoices: owing.map((invoice) => invoice.invoiceNo),
    daysWaiting:
      row.status === 'sent' && row.applicationDate ? daysBetween(row.applicationDate, today()) : null,
  };
}

/**
 * What the New payment application dialog offers for one import: methods,
 * the accounts in its currency with their Available, the supplier's bank
 * accounts (verified first), the funding sources, the open instalments.
 */
export async function pickersFor(tx: Tx, payableId: string) {
  const owner = await payables.load(tx, payableId);
  const methods = await tx
    .select({ code: paymentMethod.code, name: paymentMethod.name, kind: paymentMethod.confirmationKind })
    .from(paymentMethod)
    .where(eq(paymentMethod.active, true))
    .orderBy(asc(paymentMethod.name));
  const accounts = await tx
    .select({
      id: bankCashAccount.id,
      code: bankCashAccount.code,
      name: bankCashAccount.name,
      accountType: bankCashAccount.accountType,
      currency: bankCashAccount.currency,
      bankName: bank.name,
    })
    .from(bankCashAccount)
    .leftJoin(bank, eq(bank.code, bankCashAccount.bankCode))
    .where(and(eq(bankCashAccount.active, true), eq(bankCashAccount.currency, owner.currency)))
    .orderBy(asc(bankCashAccount.code));
  const withAvailable = [];
  for (const account of accounts) {
    const position = await treasury.accountPosition(tx, account.id);
    withAvailable.push({ ...account, availableIqd: money(position.availableIqd) });
  }
  const payees = await tx
    .select({
      id: partnerBankAccount.id,
      bankName: partnerBankAccount.bankName,
      accountNumber: partnerBankAccount.accountNumber,
      swift: partnerBankAccount.swift,
      currency: partnerBankAccount.currency,
      verified: sql<boolean>`${partnerBankAccount.approvalStatus} = 'approved' and ${partnerBankAccount.isActive}`,
    })
    .from(partnerBankAccount)
    .where(eq(partnerBankAccount.partnerId, owner.supplierId))
    .orderBy(desc(partnerBankAccount.isActive));
  const funding = await tx
    .select({ code: fundingSource.code, name: fundingSource.name })
    .from(fundingSource)
    .where(eq(fundingSource.active, true));
  const instalments = (await instalmentsFor(tx, payableId)).filter((i) => i.status === 'planned');
  const fundingLoans = await loans.fundingChoices(tx, owner.currency);
  const triggers = await tx
    .select({ code: instalmentTrigger.code, name: instalmentTrigger.name, needsDays: instalmentTrigger.needsDays })
    .from(instalmentTrigger)
    .where(eq(instalmentTrigger.active, true))
    .orderBy(asc(instalmentTrigger.sortOrder));
  return { methods, accounts: withAvailable, payees, funding, loans: fundingLoans, instalments, triggers };
}

/** §21.13 — the application a supplier payment was confirmed from, if any. */
export async function forSupplierPayment(tx: Tx, supplierPaymentId: string) {
  const [row] = await tx
    .select({ applicationNo: paymentApplication.applicationNo })
    .from(paymentApplication)
    .where(eq(paymentApplication.supplierPaymentId, supplierPaymentId))
    .limit(1);
  return row ?? null;
}

/** Open imports, for the list's "New payment application" picker. */
export async function payableImports(tx: Tx) {
  const result = await tx.execute(sql`
    select p.payable_no as "payableNo", p.supplier_reference as "reference", bp.legal_name as "supplierName",
           p.currency, p.amount_txn::text as "amountTxn"
      from payable p
      join business_partner bp on bp.id = p.supplier_id
     where p.payable_type_code = 'import' and p.cancelled_at is null and p.closed_at is null
     order by p.payable_no desc`);
  return result.rows as unknown as {
    payableNo: string;
    reference: string;
    supplierName: string;
    currency: string;
    amountTxn: string;
  }[];
}

export { needsPayeeAccount };
