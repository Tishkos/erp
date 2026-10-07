'use server';

import { redirect } from 'next/navigation';
import { rowCount, runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import * as additions from '@/server/services/manual-stock-addition';

const LIST = '/inventory/manual-additions';
const record = (additionNo: string) => `${LIST}/${encodeURIComponent(additionNo)}`;
const sheetOf = (formData: FormData) => {
  const editing = text(formData, 'addition_no').trim();
  return editing ? `${LIST}/new?draft=${encodeURIComponent(editing)}` : `${LIST}/new`;
};

/** The sheet's fields, read as the service takes them. A line naming an item must carry its quantity and price. */
function inputOf(formData: FormData): additions.AdditionInput {
  const lines: additions.AdditionLineInput[] = [];
  const claimed = rowCount(formData, 1);
  for (let row = 0; row < claimed; row += 1) {
    const itemCode = text(formData, `item_code_${row}`).trim();
    if (!itemCode) continue;
    const quantityText = text(formData, `quantity_${row}`).trim();
    const costText = text(formData, `unit_cost_${row}`).trim();
    if (!quantityText || !costText) {
      throw new Error(`Line ${row + 1} names ${itemCode} but not its quantity and unit price. Complete it, or clear the item.`);
    }
    let quantity: bigint;
    let unitCostIqd: bigint;
    try {
      quantity = parseQuantity(quantityText);
      unitCostIqd = parseDecimal(costText, 4n);
    } catch {
      throw new Error(`Line ${row + 1}: the quantity takes up to six decimals and the unit price up to four.`);
    }
    lines.push({ itemCode, uomCode: text(formData, `uom_code_${row}`).trim() || null, quantity, unitCostIqd });
  }
  return {
    warehouseCode: text(formData, 'warehouse_code').trim(),
    postingDate: text(formData, 'posting_date').trim(),
    reason: text(formData, 'reason'),
    offsetAccountId: text(formData, 'offset_account_id').trim() || null,
    departmentCode: text(formData, 'department_code').trim() || null,
    lines,
    documentId: text(formData, 'document_id').trim() || null,
  };
}

/** Writes the sheet: a new one raises the draft (its one-time id makes a second press harmless); an edited one rewrites it. */
async function save(formData: FormData) {
  const editingId = text(formData, 'id').trim();
  return runAdmin((tx, ctx) => {
    const input = inputOf(formData);
    return editingId ? additions.updateDraft(tx, ctx, editingId, input) : additions.create(tx, ctx, input);
  });
}

/** Save as draft — to the record, or back to the sheet with the refusal. */
export async function saveManualAddition(formData: FormData): Promise<void> {
  const saved = await save(formData);
  if (!saved.ok || !saved.value) redirect(withQuery(sheetOf(formData), 'error', saved.error ?? ''));
  redirect(withQuery(record(saved.value.additionNo), 'saved', '1'));
}

/**
 * A super user's sheet: saved, then approved in one press — the submission and
 * the approval both recorded, in the approval's one transaction. A refusal at
 * the approval leaves the draft saved and says why on its record.
 */
export async function saveAndApproveManualAddition(formData: FormData): Promise<void> {
  const saved = await save(formData);
  if (!saved.ok || !saved.value) redirect(withQuery(sheetOf(formData), 'error', saved.error ?? ''));
  const { id, additionNo } = saved.value;
  await runAdminAndReturn((tx, ctx) => additions.approveDraft(tx, ctx, id), record(additionNo));
}

export async function submitManualAddition(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => additions.submit(tx, ctx, text(formData, 'id')), record(text(formData, 'addition_no')));
}

export async function approveManualAddition(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => additions.approve(tx, ctx, text(formData, 'id')), record(text(formData, 'addition_no')));
}

/** A super user's own draft, from its record: submitted and approved in one press. */
export async function approveManualAdditionDraft(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => additions.approveDraft(tx, ctx, text(formData, 'id')), record(text(formData, 'addition_no')));
}

export async function rejectManualAddition(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => additions.reject(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(text(formData, 'addition_no')),
  );
}

export async function reopenManualAddition(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => additions.reopen(tx, ctx, text(formData, 'id')), record(text(formData, 'addition_no')));
}

export async function cancelManualAddition(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => additions.cancel(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(text(formData, 'addition_no')),
  );
}
