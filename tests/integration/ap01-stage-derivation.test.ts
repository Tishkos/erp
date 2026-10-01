/**
 * REQ-AP-001 A4 — the stage is derived from the database's own rails.
 *
 * The unit suite proves the predicates; this proves the loop: the seeded
 * rail rows drive `recomputeStage`, the change is logged, and R2 holds — an
 * import with a posted invoice stays at *Order confirmed* because stage 2 is
 * "invoiced **and funded**", and funding is a payment-lane fact that does
 * not exist yet.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as payables from '@/server/services/payables';
import {
  BRANCH,
  IMPORT_INPUT,
  buildPayablesWorld,
  eventsOf,
  postedInvoice,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
});

const stageOf = async (id: string): Promise<string> => {
  const { rows } = await ownerPool.query(`select stage_code from payable where id = $1`, [id]);
  return rows[0].stage_code as string;
};

describe('ap01 · stages are derived, never typed', () => {
  it('R2 — an import with a posted invoice is still Order confirmed: invoiced is not funded', async () => {
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, IMPORT_INPUT(world)),
    );
    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-STAGE-1',
      totalIqd: '751940000',
    });

    await withScope(scope(world.manager), (tx) =>
      payables.linkInvoice(tx, world.manager, { payableId: created.id, apInvoiceId: invoiceId }),
    );

    // The invoice is on the record and in the story…
    const story = await eventsOf(created.id);
    expect(story.map((event) => event.eventCode)).toContain('INVOICE_POSTED');
    // …and the stage has not moved, because "Invoiced + funded" needs the
    // instalment plan and its first funding — payment-lane facts of Stage 3.
    expect(await stageOf(created.id)).toBe('order_confirmed');
  });

  it('a service payable climbs to Approved when its invoice posts (approval is folded into posting)', async () => {
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'service',
        supplierReference: 'CONSULT-09',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'USD',
        documentDate: '2026-09-01',
        description: 'September consulting',
        amountTxn: '3000',
      }),
    );
    expect(await stageOf(created.id)).toBe('requested');

    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-STAGE-2',
      totalIqd: '3930000',
    });
    await withScope(scope(world.manager), (tx) =>
      payables.linkInvoice(tx, world.manager, { payableId: created.id, apInvoiceId: invoiceId }),
    );

    // Highest stage whose rule holds: posted satisfies both `invoice_posted`
    // (3) and `invoice_approved` (4) — a posted invoice IS approved to pay.
    expect(await stageOf(created.id)).toBe('approved');

    const story = await eventsOf(created.id);
    const change = story.find((event) => event.eventCode === 'STAGE_CHANGED');
    expect(change?.summary).toMatch(/Requested → Approved/);
  });

  it('a reversed invoice walks the stage back, with the story saying why', async () => {
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'service',
        supplierReference: 'CONSULT-10',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'USD',
        documentDate: '2026-09-01',
        description: 'October consulting',
        amountTxn: '3000',
      }),
    );
    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-STAGE-3',
      totalIqd: '3930000',
    });
    await withScope(scope(world.manager), (tx) =>
      payables.linkInvoice(tx, world.manager, { payableId: created.id, apInvoiceId: invoiceId }),
    );
    expect(await stageOf(created.id)).toBe('approved');

    // The fixture reverses the row directly; the real path (ap-invoice.reverse)
    // has its own suites and ends at the same hook.
    await ownerPool.query(
      `update ap_invoice set status = 'reversed', reversed_at = now(),
              reversed_by = $2, reversal_reason = 'fixture'
        where id = $1`,
      [invoiceId, world.manager.principal.userId],
    );
    await withScope(scope(world.manager), (tx) =>
      payables.onInvoiceEvent(tx, {
        payableId: created.id,
        eventCode: 'INVOICE_REVERSED',
        invoiceId,
        invoiceNo: 'API-STAGE-3',
        summary: 'Purchase invoice API-STAGE-3 reversed — fixture',
        actorUserId: world.manager.principal.userId,
      }),
    );

    expect(await stageOf(created.id)).toBe('requested');
  });

  it('a deactivated stage is skipped by the live rail', async () => {
    await ownerPool.query(
      `update payable_stage set active = false
        where payable_type_code = 'service' and code = 'approved'`,
    );

    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'service',
        supplierReference: 'CONSULT-11',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'USD',
        documentDate: '2026-09-01',
        description: 'November consulting',
        amountTxn: '3000',
      }),
    );
    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-STAGE-4',
      totalIqd: '3930000',
    });
    await withScope(scope(world.manager), (tx) =>
      payables.linkInvoice(tx, world.manager, { payableId: created.id, apInvoiceId: invoiceId }),
    );

    // With Approved switched off, the highest true stage is Invoiced.
    expect(await stageOf(created.id)).toBe('invoiced');
  });
});
