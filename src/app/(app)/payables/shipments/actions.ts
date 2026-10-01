'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
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
        containers: text(formData, 'containers') || null,
        sizeType: text(formData, 'size_type') || null,
        spreadLines: formData.get('spread_lines') !== null,
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
      return shipments.addContainers(tx, ctx, view.bl.id, {
        containers: text(formData, 'containers'),
        sizeType: text(formData, 'size_type') || null,
      });
    },
    blRecord(blNo),
  );
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
          shortQty: quantity(text(formData, `short_${index}`)),
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

/** The delivery note, the photos — kept with the container. */
export async function attachToContainer(formData: FormData): Promise<void> {
  const containerNo = text(formData, 'container_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${containerRecord(containerNo)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
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
