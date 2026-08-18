/**
 * A/R collections and write-off — Phase 06.11, §16.
 *
 * > §16: *"Write-off requires defined threshold, approval and reason code."*
 * > §16 acceptance 5: *"Write-offs, refunds and credit notes require controlled
 * > approval."*
 *
 * **The threshold decides who approves, not whether.** Every write-off is
 * approved by somebody; the threshold decides whether the ordinary approver is
 * enough or whether it needs the higher hand. That reading matters because the
 * alternative — small write-offs needing no approval — would let a debt be
 * forgiven with no owner at all, and §16 acceptance 5 says *"controlled
 * approval"* without qualification.
 *
 * The threshold defaults to **zero**, which puts everything above the line until
 * Finance sets a figure. See D12's tail note in `docs/DECISIONS.md`: the number
 * is the company's to choose and the build should not choose it quietly.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  arWriteOff,
  arWriteOffPolicy,
  arWriteOffReason,
  businessPartner,
  collectionActivity,
  promiseToPay,
  salesOrder,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { openBalance } from '../domain/ar-invoicing';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'ar_write_off';
export const DOCUMENT_TYPE = 'ar_write_off';
const SEQUENCE_KEY = 'AR_WRITE_OFF';

export class WriteOffExceedsBalanceError extends Error {
  readonly code = 'WRITE_OFF_EXCEEDS_BALANCE';

  constructor(
    readonly invoiceNo: string,
    readonly openIqd: bigint,
    readonly amountIqd: bigint,
  ) {
    super(
      `Writing off ${toDecimalString(amountIqd, 4n)} against invoice ${invoiceNo} is more than the ` +
        `${toDecimalString(openIqd, 4n)} still owed. A write-off forgives a debt; it cannot create a credit.`,
    );
    this.name = 'WriteOffExceedsBalanceError';
  }
}

export class WriteOffNeedsHigherApprovalError extends Error {
  readonly code = 'WRITE_OFF_ABOVE_THRESHOLD';

  constructor(
    readonly amountIqd: bigint,
    readonly thresholdIqd: bigint,
  ) {
    super(
      `A write-off of ${toDecimalString(amountIqd, 4n)} is above the ${toDecimalString(thresholdIqd, 4n)} ` +
        'threshold, so it needs the higher approval (§16). Whoever holds `configure` on write-offs may ' +
        'approve it; below the threshold the ordinary approver is enough.',
    );
    this.name = 'WriteOffNeedsHigherApprovalError';
  }
}

// ---------------------------------------------------------------------------
// The threshold — §16
// ---------------------------------------------------------------------------

/**
 * The write-off threshold in force for a branch.
 *
 * Branch first, then the company default, then zero. Zero is not "no threshold"
 * — it means *every* write-off is above it, which is the safe reading of a
 * figure nobody has set.
 */
export async function thresholdFor(tx: Tx, branchCode: string): Promise<bigint> {
  const [branchRule] = await tx
    .select()
    .from(arWriteOffPolicy)
    .where(eq(arWriteOffPolicy.branchCode, branchCode))
    .limit(1);

  if (branchRule) return parseDecimal(branchRule.thresholdIqd, 4n);

  const [companyRule] = await tx
    .select()
    .from(arWriteOffPolicy)
    .where(isNull(arWriteOffPolicy.branchCode))
    .limit(1);

  return companyRule ? parseDecimal(companyRule.thresholdIqd, 4n) : 0n;
}

// ---------------------------------------------------------------------------
// Write-off
// ---------------------------------------------------------------------------

export interface CreateWriteOffInput {
  readonly arInvoiceId: string;
  readonly writeOffDate: string;
  readonly amountIqd: bigint;
  readonly reasonCode: string;
  readonly note?: string | null;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateWriteOffInput,
): Promise<{ id: string; writeOffNo: string; aboveThreshold: boolean }> {
  const [invoice] = await tx
    .select()
    .from(arInvoice)
    .where(eq(arInvoice.id, input.arInvoiceId))
    .limit(1);

  if (!invoice) throw new Error(`No A/R invoice with id '${input.arInvoiceId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  const open = openBalance({
    totalIqd: parseDecimal(invoice.netIqd, 4n),
    allocatedIqd: parseDecimal(invoice.allocatedIqd, 4n),
  });

  if (input.amountIqd <= 0n) {
    throw new RangeError('A write-off forgives an amount, so the amount is positive.');
  }

  if (input.amountIqd > open) {
    throw new WriteOffExceedsBalanceError(invoice.invoiceNo, open, input.amountIqd);
  }

  const [reason] = await tx
    .select()
    .from(arWriteOffReason)
    .where(and(eq(arWriteOffReason.code, input.reasonCode), eq(arWriteOffReason.isActive, true)))
    .limit(1);

  if (!reason) {
    throw new Error(
      `'${input.reasonCode}' is not an active write-off reason. §16 requires a reason code, from the ` +
        'configured list rather than free text — a list is what makes "why do we write debts off?" ' +
        'a question with a countable answer.',
    );
  }

  const threshold = await thresholdFor(tx, invoice.branchCode);
  const aboveThreshold = input.amountIqd > threshold;

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: invoice.branchCode, year: Number(input.writeOffDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(arWriteOff)
    .values({
      writeOffNo: allocated.documentNo,
      arInvoiceId: input.arInvoiceId,
      customerId: invoice.customerId,
      branchCode: invoice.branchCode,
      writeOffDate: input.writeOffDate,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      // Copied, not looked up later: the policy may change, and the question a
      // year later is "what rule was this approved under?"
      thresholdAtApprovalIqd: toDecimalString(threshold, 4n),
      aboveThreshold,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: arWriteOff.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_write_off.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: invoice.branchCode,
    outcome: 'success',
    after: {
      writeOffNo: allocated.documentNo,
      invoiceNo: invoice.invoiceNo,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      reasonCode: input.reasonCode,
      thresholdIqd: toDecimalString(threshold, 4n),
      aboveThreshold,
    },
  });

  return { id: created!.id, writeOffNo: allocated.documentNo, aboveThreshold };
}

/**
 * §16 — the controlled approval.
 *
 * Below the threshold, `approve` is enough. Above it, the approver must also
 * hold `configure` on write-offs — the verb this build uses for "may change the
 * rules", which is what forgiving a large debt amounts to.
 */
export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const writeOff = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: writeOff.branchCode,
    objectId: id,
  });

  if (writeOff.aboveThreshold) {
    await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
      branchCode: writeOff.branchCode,
      objectId: id,
    });
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, writeOff.status, 'approved');

  await tx
    .update(arWriteOff)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(arWriteOff.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_write_off.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: writeOff.branchCode,
    outcome: 'success',
    before: { status: writeOff.status },
    after: {
      status: 'approved',
      aboveThreshold: writeOff.aboveThreshold,
      thresholdIqd: writeOff.thresholdAtApprovalIqd,
    },
  });
}

/** Dr Bad Debt Expense / Cr Customer A/R, and the invoice settles. */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const writeOff = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: writeOff.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, writeOff.status, 'posted');

  const [customer] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, writeOff.customerId))
    .limit(1);

  // §4.2 — the dimensions the sale carried, so a bad debt reports against the
  // line of business that booked the revenue. Bad Debt Expense is an expense
  // account, and migration 0005 makes department and business line mandatory on
  // every one of those.
  const [sale] = await tx
    .select({
      departmentCode: salesOrder.departmentCode,
      businessLineCode: salesOrder.businessLineCode,
    })
    .from(salesOrder)
    .innerJoin(arInvoice, eq(arInvoice.salesOrderId, salesOrder.id))
    .where(eq(arInvoice.id, writeOff.arInvoiceId))
    .limit(1);

  const amount = parseDecimal(writeOff.amountIqd, 4n);
  const criteria = { branchCode: writeOff.branchCode };
  const dimensions = {
    branch: writeOff.branchCode,
    business_partner: customer?.code ?? null,
    department: sale?.departmentCode ?? null,
    business_line: sale?.businessLineCode ?? null,
  };

  const lines: PostingLineRequest[] = [
    { role: 'bad_debt_expense', debit: toDecimalString(amount, 4n), criteria, dimensions },
    { role: 'customer_receivable', credit: toDecimalString(amount, 4n), criteria, dimensions },
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'sales.ar_write_off',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'sales', documentId: id, event: 'posted' },
    branchCode: writeOff.branchCode,
    documentDate: writeOff.writeOffDate,
    postingDate: writeOff.writeOffDate,
    description: `Write-off ${writeOff.writeOffNo} — ${customer?.code ?? 'customer'} (${writeOff.reasonCode})`,
    lines,
  });

  await tx
    .update(arWriteOff)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(arWriteOff.id, id));

  // The debt is gone, so the invoice's open balance closes with it. Recorded as
  // an allocation rather than by editing the invoice, so the ageing and the
  // statement both stop showing it for the same reason everything else does.
  await tx
    .update(arInvoice)
    .set({
      allocatedIqd: sql`${arInvoice.allocatedIqd} + ${writeOff.amountIqd}`,
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, writeOff.arInvoiceId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_write_off.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: writeOff.branchCode,
    outcome: 'success',
    before: { status: writeOff.status },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      amountIqd: writeOff.amountIqd,
      reasonCode: writeOff.reasonCode,
    },
  });

  return { journalEntryId: result.journalEntryId };
}

async function load(tx: Tx, id: string) {
  const [writeOff] = await tx.select().from(arWriteOff).where(eq(arWriteOff.id, id)).limit(1);
  if (!writeOff) throw new Error(`No write-off with id '${id}'.`);
  return writeOff;
}

// ---------------------------------------------------------------------------
// Collections — §16
// ---------------------------------------------------------------------------

export async function recordPromise(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly customerId: string;
    readonly arInvoiceId?: string | null;
    readonly branchCode: string;
    readonly promisedOn: string;
    readonly amountIqd: bigint;
    readonly promisedBy?: string | null;
    readonly note?: string | null;
  },
): Promise<{ id: string }> {
  await authz.authorize(ctx.principal, 'execute', 'ar_invoice', {
    branchCode: input.branchCode,
  });

  const [created] = await tx
    .insert(promiseToPay)
    .values({
      customerId: input.customerId,
      arInvoiceId: input.arInvoiceId ?? null,
      branchCode: input.branchCode,
      promisedOn: input.promisedOn,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      promisedBy: input.promisedBy ?? null,
      note: input.note ?? null,
      recordedBy: ctx.principal.userId,
    })
    .returning({ id: promiseToPay.id });

  return { id: created!.id };
}

/**
 * Closes a promise as kept or broken.
 *
 * Both outcomes are recorded, because the useful number is the ratio: a customer
 * who promises and pays is a different collections problem from one who promises
 * and does not, and only the second is worth escalating.
 */
export async function resolvePromise(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  outcome: 'kept' | 'broken' | 'cancelled',
  note?: string | null,
): Promise<void> {
  await tx
    .update(promiseToPay)
    .set({ status: outcome, resolvedAt: new Date(), resolutionNote: note ?? null })
    .where(eq(promiseToPay.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `promise_to_pay.${outcome}`,
    objectType: 'promise_to_pay',
    objectId: id,
    outcome: 'success',
    after: { status: outcome, note: note ?? null },
  });
}

export async function recordActivity(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly customerId: string;
    readonly arInvoiceId?: string | null;
    readonly branchCode: string;
    readonly occurredOn: string;
    readonly activityKind: string;
    readonly note: string;
  },
): Promise<{ id: string }> {
  await authz.authorize(ctx.principal, 'execute', 'ar_invoice', {
    branchCode: input.branchCode,
  });

  const [created] = await tx
    .insert(collectionActivity)
    .values({
      customerId: input.customerId,
      arInvoiceId: input.arInvoiceId ?? null,
      branchCode: input.branchCode,
      occurredOn: input.occurredOn,
      activityKind: input.activityKind,
      note: input.note,
      recordedBy: ctx.principal.userId,
    })
    .returning({ id: collectionActivity.id });

  return { id: created!.id };
}

/** The collections history for a customer — §16's follow-up notes. */
export async function historyFor(tx: Tx, customerId: string) {
  const activities = await tx
    .select()
    .from(collectionActivity)
    .where(eq(collectionActivity.customerId, customerId))
    .orderBy(collectionActivity.occurredOn);

  const promises = await tx
    .select()
    .from(promiseToPay)
    .where(eq(promiseToPay.customerId, customerId))
    .orderBy(promiseToPay.promisedOn);

  return { activities, promises };
}

/**
 * §16 — expected cash collection.
 *
 * Open promises first, because a promise is better information than a due date:
 * a customer who has said they will pay on the 20th is more likely to pay on the
 * 20th than on the date the invoice happens to fall due.
 */
export async function expectedCollection(
  tx: Tx,
  ctx: ActorContext,
  from: string,
  to: string,
) {
  await authz.authorize(ctx.principal, 'view', 'ar_invoice', { branchCode: ctx.branchCode });

  const result = await tx.execute(sql`
    select p.code                                as "customerCode",
           i.invoice_no                          as "invoiceNo",
           coalesce(pr.promised_on, i.due_date)::text as "expectedOn",
           (pr.id is not null)                   as "fromPromise",
           (i.net_iqd - i.allocated_iqd)::text   as "expectedIqd"
      from ar_invoice i
      join business_partner p on p.id = i.customer_id
      left join lateral (
        select id, promised_on
          from promise_to_pay
         where ar_invoice_id = i.id and status = 'open'
         order by promised_on
         limit 1
      ) pr on true
     where i.status in ('posted', 'partially_executed')
       and (i.net_iqd - i.allocated_iqd) > 0
       and coalesce(pr.promised_on, i.due_date) between ${from}::date and ${to}::date
     order by coalesce(pr.promised_on, i.due_date), p.code
  `);

  return (result as unknown as { rows: Record<string, string | boolean>[] }).rows;
}
