/**
 * REQ-AP-001 A1 — the payable record and its type controls.
 *
 * Creating a payable of each seeded type allocates its series number, writes
 * PAYABLE_OPENED, enforces the type's controls — PO required for import and
 * local goods (the PI becomes a real, submitted purchase order), department
 * required for service and recurring — and refuses a duplicate supplier +
 * normalised reference + type, which is R1 as a unique index.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
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

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
});

describe('ap01 · one record per thing the company owes', () => {
  it('opens an import: IMP number, a real submitted purchase order, the story begun', async () => {
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, IMPORT_INPUT(world)),
    );

    expect(created.payableNo).toMatch(/^IMP-BGW-2026-\d{6}$/);

    const { rows } = await ownerPool.query(
      `select p.supplier_reference_key, p.stage_code, p.quantity, p.amount_txn,
              o.order_no, o.status as po_status, o.reference as po_reference
         from payable p join purchase_order o on o.id = p.purchase_order_id
        where p.id = $1`,
      [created.id],
    );
    expect(rows[0].supplier_reference_key).toBe('CSAAL00011');
    expect(rows[0].stage_code).toBe('order_confirmed');
    expect(Number(rows[0].quantity)).toBe(5240);
    // 5040 × 100 + 200 × 350 = 574,000 USD.
    expect(Number(rows[0].amount_txn)).toBe(574_000);
    // §14 — the PI is the company's order: created and submitted, awaiting a
    // second person (§5.2), carrying the PI number as its reference.
    expect(rows[0].order_no).toMatch(/^PO-/);
    expect(rows[0].po_status).toBe('submitted');
    expect(rows[0].po_reference).toBe('CSA-AL0001-1');

    const story = await eventsOf(created.id);
    expect(story.map((event) => event.eventCode)).toEqual([
      'PAYABLE_OPENED',
      'PI_RECORDED',
      'PO_LINKED',
      'TERMS_SET',
    ]);
  });

  it('numbers every type from its own series', async () => {
    const make = (input: Record<string, unknown>) =>
      withScope(scope(world.manager), (tx) =>
        payables.create(tx, world.manager, {
          supplierId: world.supplierId,
          branchCode: BRANCH,
          currency: 'USD',
          documentDate: '2026-09-01',
          ...input,
        } as Parameters<typeof payables.create>[2]),
      );

    const service = await make({
      payableTypeCode: 'service',
      supplierReference: 'RENT-ERBIL-OCT',
      departmentCode: 'FIN',
      description: 'Office rent October 2026',
      amountTxn: '2500',
    });
    const recurring = await make({
      payableTypeCode: 'recurring',
      supplierReference: 'LEASE-3F',
      departmentCode: 'FIN',
      description: 'Erbil office lease',
      amountTxn: '2500',
      dueDate: '2026-10-01',
    });
    const advance = await make({
      payableTypeCode: 'advance',
      supplierReference: 'DEP-001',
      description: 'Security deposit',
      amountTxn: '5000',
    });

    expect(service.payableNo).toMatch(/^SVC-BGW-2026-/);
    expect(recurring.payableNo).toMatch(/^RNT-BGW-2026-/);
    expect(advance.payableNo).toMatch(/^ADV-BGW-2026-/);
  });

  it('R1 — a duplicate reference per supplier and type is refused, however it is spelt', async () => {
    await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, IMPORT_INPUT(world)),
    );

    const message = await rejection(
      withScope(scope(world.manager), (tx) =>
        payables.create(tx, world.manager, {
          ...IMPORT_INPUT(world),
          // The same reference as the sheet would mangle it.
          supplierReference: ' csa al0001/1 ',
        }),
      ),
    );
    expect(message).toMatch(/already open as IMP-/);
  });

  it('a service payable without its benefiting department is refused', async () => {
    const message = await rejection(
      withScope(scope(world.manager), (tx) =>
        payables.create(tx, world.manager, {
          payableTypeCode: 'service',
          supplierReference: 'SVC-NO-DEPT',
          supplierId: world.supplierId,
          branchCode: BRANCH,
          currency: 'USD',
          documentDate: '2026-09-01',
          description: 'Consulting',
          amountTxn: '100',
        }),
      ),
    );
    expect(message).toMatch(/benefiting department/);
  });

  it('an import without lines or an order is refused — no goods without an order', async () => {
    const message = await rejection(
      withScope(scope(world.manager), (tx) =>
        payables.create(tx, world.manager, {
          payableTypeCode: 'import',
          supplierReference: 'IMP-NO-LINES',
          supplierId: world.supplierId,
          branchCode: BRANCH,
          currency: 'USD',
          documentDate: '2026-09-01',
          description: 'panels',
          amountTxn: '1000',
        }),
      ),
    );
    expect(message).toMatch(/become the purchase order/);
  });

  it('cancellation states its reason and is refused while a posted invoice stands', async () => {
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, IMPORT_INPUT(world)),
    );

    const { postedInvoice } = await import('./payables-fixture');
    await postedInvoice(world, {
      invoiceNo: 'API-CORE-1',
      totalIqd: '751940000',
      payableId: created.id,
    });

    const refusal = await rejection(
      withScope(scope(world.manager), (tx) =>
        payables.cancel(tx, world.manager, { payableId: created.id, reason: 'duplicate' }),
      ),
    );
    expect(refusal).toMatch(/Reverse the invoice first/);
  });
});
