'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as shipments from '@/server/services/supplier-shipment';

/**
 * Invoice Status Tracking's two actions, absorbed by In-Transit Inventory
 * (REQ-LOG-001 item 18). The service is unchanged; only the page it returns
 * to moved (`/inventory/in-transit` redirects here).
 */
const LIST = '/logistics/in-transit';

/** Move a non-import shipment to its next stage; the stock moves with it. */
export async function advanceShipment(formData: FormData): Promise<void> {
  const to = text(formData, 'to') as shipments.ShipmentStatus;
  const destination = text(formData, 'warehouse_code').trim();
  await runAdminAndReturn((tx, ctx) => shipments.advance(tx, ctx, text(formData, 'id'), to, destination || null), LIST);
}

/** Who is told when a shipment moves — block 8's "selected system users". */
export async function setShipmentWatchers(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      shipments.setWatchers(
        tx,
        ctx,
        ctx.branchCode,
        formData.getAll('watcher').map((value) => String(value)),
      ),
    LIST,
  );
}
