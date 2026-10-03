'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import { parseQuantity } from '@/server/domain/uom';
import * as attachments from '@/server/services/attachments';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';
import * as shipments from '@/server/services/shipments';

/** Shipments & containers — REQ-AP-001 §17, §18, §21.9. Every verb is the service's. */
const BLS = '/payables/shipments';
const CONTAINERS = '/payables/containers';
const blRecord = (blNo: string) => `${BLS}/${encodeURIComponent(blNo)}`;
const containerRecord = (containerNo: string) => `${CONTAINERS}/${encodeURIComponent(containerNo)}`;

const quantity = (value: string) => {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return 0n;
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) throw new Error(`"${value}" is not a quantity.`);
  return parseQuantity(cleaned);
};

/**
 * IM2 — the B/L's containers table: a row per container (number, size/type,
 * seal) and per model what it carries; a cell left empty is not typed.
 */
function containerRows(formData: FormData): shipments.ContainerRowInput[] {
  const rowCount = Number(text(formData, 'row_count')) || 0;
  const modelCount = Number(text(formData, 'model_count')) || 0;
  const models = Array.from({ length: modelCount }, (_, m) => text(formData, `model_${m}`));
  const rows: shipments.ContainerRowInput[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const containerNo = text(formData, `container_no_${index}`).trim();
    const quantities: Record<string, bigint | null> = {};
    let any = false;
    for (const [m, key] of models.entries()) {
      const raw = text(formData, `qty_${index}_${m}`).trim();
      quantities[key] = raw ? quantity(raw) : null;
      if (raw) any = true;
    }
    if (!containerNo && !any && !text(formData, `seal_no_${index}`).trim()) continue;
    rows.push({
      containerNo,
      sizeType: text(formData, `size_type_${index}`) || null,
      sealNo: text(formData, `seal_no_${index}`) || null,
      quantities,
    });
  }
  return rows;
}

export async function createBlAction(formData: FormData): Promise<void> {
  const back = text(formData, 'back');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const payableNo = text(formData, 'payable_no');
      const payableId = payableNo ? (await payables.loadByNo(tx, payableNo)).id : text(formData, 'payable_id');
      return shipments.createBl(tx, ctx, {
        payableId,
        blNo: text(formData, 'bl_no'),
        blDate: text(formData, 'bl_date'),
        shippingLine: text(formData, 'shipping_line') || null,
        vessel: text(formData, 'vessel') || null,
        voyage: text(formData, 'voyage') || null,
        portOfLoading: text(formData, 'port_of_loading') || null,
        portOfDischargeCode: text(formData, 'port_of_discharge') || null,
        eta: text(formData, 'eta') || null,
        containerRows: containerRows(formData),
      });
    },
    (value) => {
      const created = value as { blNo?: string } | null | undefined;
      return back || (created?.blNo ? blRecord(created.blNo) : BLS);
    },
  );
}

export async function addContainersAction(formData: FormData): Promise<void> {
  const blNo = text(formData, 'bl_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const view = await shipments.viewBl(tx, blNo);
      return shipments.addContainers(tx, ctx, view.bl.id, { rows: containerRows(formData) });
    },
    blRecord(blNo),
  );
}

/** IM2 — the B/L's boxes corrected (while nothing on it is received). */
export async function updateBlAction(formData: FormData): Promise<void> {
  const blNo = text(formData, 'bl_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const view = await shipments.viewBl(tx, blNo);
      return shipments.updateBl(tx, ctx, view.bl.id, {
        blNo: text(formData, 'new_bl_no'),
        blDate: text(formData, 'bl_date'),
        eta: text(formData, 'eta'),
        shippingLine: text(formData, 'shipping_line') || null,
        vessel: text(formData, 'vessel') || null,
        voyage: text(formData, 'voyage') || null,
        portOfLoading: text(formData, 'port_of_loading') || null,
        portOfDischargeCode: text(formData, 'port_of_discharge') || null,
      });
    },
    (value) => blRecord((value as { blNo?: string } | null | undefined)?.blNo ?? blNo),
  );
}

/** IM2 — a B/L entered by mistake, cancelled with its reason (and its containers with it). */
export async function cancelBlAction(formData: FormData): Promise<void> {
  const blNo = text(formData, 'bl_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const view = await shipments.viewBl(tx, blNo);
      return shipments.cancelBl(tx, ctx, view.bl.id, text(formData, 'reason'));
    },
    blRecord(blNo),
  );
}

/** The B/L's own paperwork: the scanned B/L, the packing list. */
export async function attachToBl(formData: FormData): Promise<void> {
  const blNo = text(formData, 'bl_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${blRecord(blNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const view = await shipments.viewBl(tx, blNo);
    await attachments.upload(tx, ctx, { objectType: shipments.BL_OBJECT, objectId: view.bl.id, fileName: upload.name, content });
    await events.record(tx, {
      payableId: view.bl.payableId,
      eventCode: 'ATTACHMENT_ADDED',
      summary: `${upload.name} attached to B/L ${view.bl.blNo}`,
      sourceType: shipments.BL_OBJECT,
      sourceId: view.bl.id,
      sourceNo: view.bl.blNo,
      actorUserId: ctx.principal.userId,
    });
  }, blRecord(blNo));
}

export async function blStatusAction(formData: FormData): Promise<void> {
  const blNo = text(formData, 'bl_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const view = await shipments.viewBl(tx, blNo);
      return shipments.changeStatusForBl(tx, ctx, view.bl.id, {
        statusCode: text(formData, 'status_code'),
        date: text(formData, 'status_date'),
        note: text(formData, 'note') || null,
      });
    },
    blRecord(blNo),
  );
}

async function containerIdOf(tx: Parameters<Parameters<typeof runAdminAndReturn>[0]>[0], formData: FormData) {
  return (await shipments.viewContainer(tx, text(formData, 'container_no'), text(formData, 'container_id') || null))
    .container.id;
}

export async function containerStatusAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      shipments.changeStatus(tx, ctx, await containerIdOf(tx, formData), {
        statusCode: text(formData, 'status_code'),
        date: text(formData, 'status_date'),
        note: text(formData, 'note') || null,
      }),
    containerRecord(containerNo),
  );
}

export async function containerEtaAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      shipments.changeEta(tx, ctx, await containerIdOf(tx, formData), {
        eta: text(formData, 'eta'),
        note: text(formData, 'note') || null,
      }),
    containerRecord(containerNo),
  );
}

export async function portFileAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  await runAdminAndReturn(
    async (tx, ctx) => shipments.portFileSent(tx, ctx, await containerIdOf(tx, formData), text(formData, 'sent_on')),
    containerRecord(containerNo),
  );
}

export async function containerLinesAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  const count = Number(text(formData, 'row_count')) || 0;
  await runAdminAndReturn(
    async (tx, ctx) => {
      const lines = [];
      for (let index = 0; index < count; index += 1) {
        const itemCode = text(formData, `item_${index}`);
        const planned = text(formData, `planned_${index}`).trim();
        if (!itemCode && !planned) continue;
        lines.push({
          itemCode: itemCode || null,
          description: text(formData, `description_${index}`) || itemCode,
          plannedQty: planned,
          uomCode: text(formData, `uom_${index}`) || null,
        });
      }
      return shipments.setContainerLines(tx, ctx, await containerIdOf(tx, formData), lines);
    },
    containerRecord(containerNo),
  );
}

/** §18 — the form's document id makes a double submit one receipt. */
export async function receiveContainerAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  const count = Number(text(formData, 'row_count')) || 0;
  await runAdminAndReturn(
    async (tx, ctx) => {
      const lines = [];
      for (let index = 0; index < count; index += 1) {
        lines.push({
          containerLineId: text(formData, `line_${index}`),
          receivedQty: quantity(text(formData, `received_${index}`)),
          damagedQty: quantity(text(formData, `damaged_${index}`)),
          // Left empty, the service works it out: planned − received − damaged.
          ...(text(formData, `short_${index}`).trim() ? { shortQty: quantity(text(formData, `short_${index}`)) } : {}),
        });
      }
      return shipments.receive(tx, ctx, {
        documentId: text(formData, 'document_id'),
        containerId: await containerIdOf(tx, formData),
        warehouseCode: text(formData, 'warehouse_code'),
        receiptDate: text(formData, 'receipt_date'),
        lines,
        varianceReason: text(formData, 'variance_reason') || null,
        note: text(formData, 'note') || null,
      });
    },
    containerRecord(containerNo),
  );
}

/** IM2 — a container's number, size/type and seal, corrected until it is received. */
export async function updateContainerAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      shipments.updateContainer(tx, ctx, await containerIdOf(tx, formData), {
        containerNo: text(formData, 'new_container_no'),
        sizeType: text(formData, 'size_type') || null,
        sealNo: text(formData, 'seal_no') || null,
      }),
    (value) => containerRecord((value as { containerNo?: string } | null | undefined)?.containerNo ?? containerNo),
  );
}

/** IM2 — a container that is not on the ship after all, cancelled with its reason. */
export async function cancelContainerAction(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  await runAdminAndReturn(
    async (tx, ctx) => shipments.cancelContainer(tx, ctx, await containerIdOf(tx, formData), text(formData, 'reason')),
    containerRecord(containerNo),
  );
}

/** The delivery note, the photos — kept with the container. */
export async function attachToContainer(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${containerRecord(containerNo)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const view = await shipments.viewContainer(tx, containerNo, text(formData, 'container_id') || null);
    await attachments.upload(tx, ctx, {
      objectType: shipments.CONTAINER_OBJECT,
      objectId: view.container.id,
      fileName: upload.name,
      content,
    });
    await events.record(tx, {
      payableId: view.container.payableId,
      eventCode: 'ATTACHMENT_ADDED',
      summary: `${upload.name} attached to ${view.container.containerNo}`,
      sourceType: shipments.CONTAINER_OBJECT,
      sourceId: view.container.id,
      sourceNo: view.container.containerNo,
      actorUserId: ctx.principal.userId,
    });
  }, containerRecord(containerNo));
}

/**
 * IM2-1 — what did not arrive, claimed from the supplier: a goods return per
 * invoice out of transit. It opens on the first return, to be approved and
 * posted there; the import's page shows the claim against each item.
 */
export async function claimShortageAction(formData: FormData): Promise<void> {
  const payableNo = text(formData, 'payable_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      const owner = await payables.loadByNo(tx, payableNo);
      return shipments.claimShortage(tx, ctx, {
        payableId: owner.id,
        returnDate: text(formData, 'return_date'),
        reason: text(formData, 'reason'),
        supplierReference: text(formData, 'supplier_reference') || null,
      });
    },
    (value) => {
      const claimed = value as { returns?: { returnNo: string }[] } | null | undefined;
      const first = claimed?.returns?.[0]?.returnNo;
      return first ? `/payables/goods-returns/${encodeURIComponent(first)}` : `/payables/${encodeURIComponent(payableNo)}`;
    },
  );
}
