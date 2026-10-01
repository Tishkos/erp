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
import * as attachments from '@/server/services/attachments';
import * as events from '@/server/services/payable-events';
import * as holds from '@/server/services/payable-holds';
import * as payables from '@/server/services/payables';

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
