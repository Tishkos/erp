'use server';

/**
 * Material issues — REQ-PM-001 Stage PM-3 §9. One line per document, as
 * the stock transfer form is: the page mints `document_id`, and a second
 * press of the same form finds the first's document.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as pe from '@/server/services/project-execution';

const LIST = '/projects/material-issues';
const record = (no: string) => `/projects/material-issues/${encodeURIComponent(no)}`;

export async function createMaterialIssue(form: FormData): Promise<void> {
  const [projectCode, wbsCode] = text(form, 'element').split('|');
  await runAdminAndReturn(
    (tx, ctx) =>
      pe.createIssue(tx, ctx, {
        projectCode: projectCode ?? '',
        wbsCode: wbsCode ?? '',
        costCode: text(form, 'cost_code'),
        warehouseCode: text(form, 'warehouse_code'),
        kind: text(form, 'kind') || 'issue',
        movementDate: text(form, 'movement_date') || null,
        description: text(form, 'description') || null,
        documentId: text(form, 'document_id') || null,
        lines: [{ itemCode: text(form, 'item_code'), quantity: text(form, 'quantity'), unitCostIqd: text(form, 'unit_cost_iqd') || null, batchNumber: text(form, 'batch_number') || null, serialNumber: text(form, 'serial_number') || null }],
      }),
    (value) => (value && typeof value === 'object' && 'documentNo' in value ? record(String((value as { documentNo: string }).documentNo)) : LIST),
  );
}

export async function postMaterialIssue(form: FormData): Promise<void> {
  const no = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => pe.postIssue(tx, ctx, no), record(no));
}

export async function cancelMaterialIssue(form: FormData): Promise<void> {
  const no = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => pe.cancelIssue(tx, ctx, no, text(form, 'reason')), record(no));
}
