'use server';

/**
 * Payables — the server actions behind the workbench, the payable page and
 * the stop/follow-up dialog (REQ-AP-001 §21.2, §21.3, §21.12).
 *
 * Thin by design: each reads its form, calls the service in the caller's own
 * transaction, and returns to the page with ?saved=1 or the service's own
 * sentence. The services hold every rule.
 */
import { runAdminAndReturn, rowCount, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as events from '@/server/services/payable-events';
import * as holds from '@/server/services/payable-holds';
import * as landed from '@/server/services/landed-cost';
import { parseDecimal } from '@/server/domain/money';
import * as payables from '@/server/services/payables';
import * as paymentApplications from '@/server/services/payment-applications';
import { businessToday } from '@/server/domain/business-date';

const back = (payableNo: string, tab?: string) =>
  `/payables/${encodeURIComponent(payableNo)}${tab ? `?tab=${tab}` : ''}`;

export async function createPayable(form: FormData): Promise<void> {
  const lines: Array<{
    itemCode: string | null;
    description: string;
    quantity: string | null;
    uomCode: string | null;
    unitPrice: string | null;
  }> = [];
  for (let index = 0; index < rowCount(form, 0); index++) {
    const description = text(form, `line_${index}_description`).trim();
    if (!description) continue;
    lines.push({
      itemCode: text(form, `line_${index}_item`) || null,
      description,
      quantity: text(form, `line_${index}_quantity`) || null,
      uomCode: text(form, `line_${index}_uom`) || null,
      unitPrice: text(form, `line_${index}_price`) || null,
    });
  }

  let destination = '/payables';
  await runAdminAndReturn(
    async (tx, ctx) => {
      const created = await payables.create(tx, ctx, {
        payableTypeCode: text(form, 'payable_type'),
        supplierReference: text(form, 'supplier_reference'),
        supplierId: text(form, 'supplier_id'),
        branchCode: ctx.branchCode,
        departmentCode: text(form, 'department_code') || null,
        currency: text(form, 'currency').toUpperCase(),
        documentDate: text(form, 'document_date'),
        description: text(form, 'description'),
        paymentTermsText: text(form, 'payment_terms') || null,
        expenseCategoryCode: text(form, 'expense_category') || null,
        amountTxn: text(form, 'amount') || null,
        dueDate: text(form, 'due_date') || null,
        purchaseOrderId: text(form, 'purchase_order_id') || null,
        lines,
      });
      destination = back(created.payableNo);
      return created;
    },
    () => destination,
  );
}

export async function addNote(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const row = await payables.loadByNo(tx, payableNo);
      await payables.addNote(tx, ctx, { payableId: row.id, note: text(form, 'note') });
    },
    back(payableNo, 'log'),
  );
}

export async function setTerms(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const row = await payables.loadByNo(tx, payableNo);
      await payables.setTerms(tx, ctx, {
        payableId: row.id,
        paymentTermsText: text(form, 'payment_terms'),
      });
    },
    back(payableNo),
  );
}

export async function linkInvoice(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const row = await payables.loadByNo(tx, payableNo);
      await payables.linkInvoice(tx, ctx, {
        payableId: row.id,
        apInvoiceId: text(form, 'ap_invoice_id'),
      });
    },
    back(payableNo),
  );
}

export async function updatePiLines(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  const lines: Array<{
    itemCode: string | null;
    description: string;
    quantity: string | null;
    uomCode: string | null;
    unitPrice: string | null;
  }> = [];
  for (let index = 0; index < rowCount(form, 0); index++) {
    const description = text(form, `line_${index}_description`).trim();
    if (!description) continue;
    lines.push({
      itemCode: text(form, `line_${index}_item`) || null,
      description,
      quantity: text(form, `line_${index}_quantity`) || null,
      uomCode: text(form, `line_${index}_uom`) || null,
      unitPrice: text(form, `line_${index}_price`) || null,
    });
  }
  await runAdminAndReturn(
    async (tx, ctx) => {
      const row = await payables.loadByNo(tx, payableNo);
      await payables.updateOrderLines(tx, ctx, { payableId: row.id, lines });
    },
    back(payableNo),
  );
}

export async function cancelPayable(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const row = await payables.loadByNo(tx, payableNo);
      await payables.cancel(tx, ctx, { payableId: row.id, reason: text(form, 'reason') });
    },
    back(payableNo),
  );
}

// ---------------------------------------------------------------------------
// §21.12 — the stop / follow-up dialog
// ---------------------------------------------------------------------------

export async function stopFollowUp(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  const backTo = text(form, 'back') || back(payableNo);
  await runAdminAndReturn(
    async (tx, ctx) => {
      const row = await payables.loadByNo(tx, payableNo);
      await holds.open(tx, ctx, {
        payableId: row.id,
        laneCode: text(form, 'lane'),
        reasonCode: text(form, 'reason_code'),
        detail: text(form, 'detail') || null,
        ownerUserId: text(form, 'owner'),
        startedAt: text(form, 'started_on') ? new Date(text(form, 'started_on')) : undefined,
        nextAction: text(form, 'next_action'),
        nextActionDue: text(form, 'next_action_due'),
      });
    },
    backTo,
  );
}

export async function completeHold(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      await holds.complete(tx, ctx, {
        holdId: text(form, 'hold_id'),
        reasonCode: text(form, 'reason_code'),
        detail: text(form, 'detail') || null,
        ownerUserId: text(form, 'owner'),
        nextAction: text(form, 'next_action'),
        nextActionDue: text(form, 'next_action_due'),
      });
    },
    back(payableNo),
  );
}

export async function updateHold(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      await holds.update(tx, ctx, {
        holdId: text(form, 'hold_id'),
        note: text(form, 'note'),
        nextAction: text(form, 'next_action') || null,
        nextActionDue: text(form, 'next_action_due') || null,
      });
    },
    back(payableNo),
  );
}

export async function reassignHold(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      await holds.reassign(tx, ctx, {
        holdId: text(form, 'hold_id'),
        ownerUserId: text(form, 'owner'),
      });
    },
    back(payableNo),
  );
}

export async function resolveHold(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      await holds.resolve(tx, ctx, {
        holdId: text(form, 'hold_id'),
        resolution: text(form, 'resolution'),
      });
    },
    back(payableNo),
  );
}


export async function attachToPayable(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    const { redirect } = await import('next/navigation');
    redirect(`${back(payableNo, 'attachments')}&error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const row = await payables.loadByNo(tx, payableNo);
    await attachments.upload(tx, ctx, {
      objectType: payables.PERMISSION_OBJECT,
      objectId: row.id,
      fileName: upload.name,
      content,
    });
    // §5.4 — an attachment is an event in the payable's story too.
    await events.record(tx, {
      payableId: row.id,
      eventCode: 'ATTACHMENT_ADDED',
      summary: upload.name,
      actorUserId: ctx.principal.userId,
    });
  }, back(payableNo, 'attachments'));
}

// ---------------------------------------------------------------------------
// §20.2 — the landed cost: a charge from a posted journal, its withdrawal,
// and the lock (or a dated adjustment after it).
// ---------------------------------------------------------------------------

/** Amount as typed ("3,500.00") at the money scale; null when blank. */
function iqdOf(value: string): bigint | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) throw new landed.LandedCostError(`"${value}" is not an amount.`);
  return parseDecimal(cleaned, 4n);
}

export async function addLandedCharge(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(async (tx, ctx) => {
    const row = await payables.loadByNo(tx, payableNo);
    return landed.addCharge(tx, ctx, {
      payableId: row.id,
      chargeTypeCode: text(form, 'charge_type'),
      journalEntryNo: text(form, 'journal_entry_no'),
      amountIqd: iqdOf(text(form, 'amount')) ?? 0n,
      reason: text(form, 'reason') || null,
      note: text(form, 'note') || null,
    });
  }, back(payableNo));
}

export async function withdrawLandedCharge(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => landed.cancelCharge(tx, ctx, text(form, 'charge_id'), text(form, 'reason')),
    back(payableNo),
  );
}

export async function lockLandedCost(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  const count = rowCount(form, 0);
  await runAdminAndReturn(async (tx, ctx) => {
    const row = await payables.loadByNo(tx, payableNo);
    const manual = new Map<string, bigint>();
    for (let index = 0; index < count; index += 1) {
      const model = text(form, `model_${index}`);
      const amount = iqdOf(text(form, `amount_${index}`));
      if (model && amount !== null) manual.set(model, amount);
    }
    return landed.lock(tx, ctx, {
      payableId: row.id,
      basisCode: text(form, 'basis') || null,
      lockDate: text(form, 'lock_date') || null,
      manual,
      note: text(form, 'note') || null,
    });
  }, back(payableNo));
}

/** REQ-FIX-001 FX8 — book the exchange difference a confirmation left waiting. */
export async function settleExchangeDifference(form: FormData): Promise<void> {
  const payableNo = text(form, 'payable_no');
  await runAdminAndReturn(async (tx, ctx) => {
    const row = await payables.loadByNo(tx, payableNo);
    return paymentApplications.settleExchangeDifference(tx, ctx, row.id, businessToday());
  }, back(payableNo));
}

