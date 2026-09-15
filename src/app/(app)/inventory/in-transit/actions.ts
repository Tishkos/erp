'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as shipments from '@/server/services/supplier-shipment';

const LIST = '/inventory/in-transit';

/**
 * Move a shipment to the next stage — Operations block 8.
 *
 * The stock moves with it, and on the last step it lands in the warehouse the
 * person chose. Everything else about where it goes is a property of the
 * warehouse rather than a decision made here: there is one In Process
 * warehouse, one On Board, one On Port, and the service reads them.
 */
export async function advanceShipment(formData: FormData): Promise<void> {
  const to = text(formData, 'to') as shipments.ShipmentStatus;
  const destination = text(formData, 'warehouse_code').trim();

  await runAdminAndReturn(
    (tx, ctx) =>
      shipments.advance(tx, ctx, text(formData, 'id'), to, destination || null),
    LIST,
  );
}
