/**
 * REQ-AP-001 §12 — the deposit knows which file it funds.
 *
 * An advance links to a payable of the same supplier, once; linking and
 * approving both write the payable's story (A2 — "records everything"
 * covers the new `supplier_advance.payable_id` carrier).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as advances from '@/server/services/supplier-advance';
import * as orders from '@/server/services/purchase-order';
import * as payables from '@/server/services/payables';
import {
  BRANCH,
  IMPORT_INPUT,
  buildPayablesWorld,
  eventsOf,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;
let payableId: string;
let orderId: string;

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();

  // The import with its own order — the payable raised it (D9).
  const created = await withScope(scope(world.officer), (tx) =>
    payables.create(tx, world.officer, IMPORT_INPUT(world)),
  );
  payableId = created.id;
  const { rows } = await ownerPool.query(
    `select purchase_order_id from payable where id = $1`,
    [payableId],
  );
  orderId = rows[0].purchase_order_id as string;
  // §8.5 — an advance is paid against a commitment the company has made.
  await withScope(scope(world.manager), (tx) => orders.approve(tx, world.manager, orderId));
});

describe('ap02 · an advance linked to the payable it funds', () => {
  it('link and approval both reach the story; the link is once and same-supplier', async () => {
    const advance = await withScope(scope(world.officer), (tx) =>
      advances.request(tx, world.officer, {
        purchaseOrderId: orderId,
        branchCode: BRANCH,
        requestDate: '2026-09-05',
        amountIqd: 65_500_000_0000n,
      }),
    );

    await withScope(scope(world.officer), (tx) =>
      advances.linkToPayable(tx, world.officer, {
        supplierAdvanceId: advance.id,
        payableId,
      }),
    );

    await withScope(scope(world.manager), (tx) =>
      advances.approve(tx, world.manager, advance.id),
    );

    const story = await eventsOf(payableId);
    const summaries = story.map((event) => event.summary);
    expect(summaries.some((text) => /Advance ADV-.*linked/.test(text))).toBe(true);
    expect(summaries.some((text) => /Advance ADV-.*approved/.test(text))).toBe(true);

    // Linked once: pointing the same advance at another file is refused.
    const other = await withScope(scope(world.officer), (tx) =>
      payables.create(tx, world.officer, {
        ...IMPORT_INPUT(world),
        supplierReference: 'CSA-AL0001-2',
      }),
    );
    const refusal = await rejection(
      withScope(scope(world.officer), (tx) =>
        advances.linkToPayable(tx, world.officer, {
          supplierAdvanceId: advance.id,
          payableId: other.id,
        }),
      ),
    );
    expect(refusal).toMatch(/already funds/);
  });

  it('a different supplier’s payable is refused', async () => {
    const advance = await withScope(scope(world.officer), (tx) =>
      advances.request(tx, world.officer, {
        purchaseOrderId: orderId,
        branchCode: BRANCH,
        requestDate: '2026-09-05',
        amountIqd: 1_000_000_0000n,
      }),
    );

    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status)
       values ('SUP-OTHER','Another Co','false','true','active') returning id`,
    );
    const stranger = await withScope(scope(world.officer), (tx) =>
      payables.create(tx, world.officer, {
        payableTypeCode: 'service',
        supplierReference: 'OTHER-1',
        supplierId: rows[0].id as string,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'IQD',
        documentDate: '2026-09-05',
        description: 'Someone else entirely',
        expenseCategoryCode: 'other',
        amountTxn: '100000',
      }),
    );

    const refusal = await rejection(
      withScope(scope(world.officer), (tx) =>
        advances.linkToPayable(tx, world.officer, {
          supplierAdvanceId: advance.id,
          payableId: stranger.id,
        }),
      ),
    );
    expect(refusal).toMatch(/different supplier/);
  });
});
