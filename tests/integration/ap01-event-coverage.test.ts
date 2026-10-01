/**
 * REQ-AP-001 A2 — "records everything" is enforced, not hoped for.
 *
 * Two halves. The first is schema-driven: every table that carries a
 * `payable_id` must be one this suite knows — a new table added without
 * extending the coverage below fails here, which is the §7.2 rule made a
 * test. The second exercises every Stage-1 mutation and asserts each wrote
 * at least one `payable_event` in its own transaction.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as holds from '@/server/services/payable-holds';
import * as payables from '@/server/services/payables';
import {
  BRANCH,
  IMPORT_INPUT,
  buildPayablesWorld,
  postedInvoice,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
});

const eventCount = async (payableId: string): Promise<number> => {
  const { rows } = await ownerPool.query(
    `select count(*)::int as n from payable_event where payable_id = $1`,
    [payableId],
  );
  return rows[0].n as number;
};

describe('ap01 · every service that touches a payable writes its story', () => {
  it('the tables carrying payable_id are exactly the ones this suite covers', async () => {
    const { rows } = await ownerPool.query(`
      select table_name from information_schema.columns
       where column_name = 'payable_id' and table_schema = 'public'
         and table_name not like 'payable_event_2%'
       order by table_name
    `);
    // A new table carrying payable_id is a new writer: add its mutations
    // below, or its changes happen off the record (§7.2).
    expect(rows.map((row) => row.table_name)).toEqual([
      'ap_invoice',
      // Stage 5 (0234): the B/L, every container move and the receipt write
      // their shipment / warehouse events — ap05-shipment.
      'bill_of_lading',
      'container_receipt',
      // Stage 4 (0233): register / status / note / re-register each write
      // their PD_ event — ap04-customs-pd.
      'customs_pd',
      // Stage 2 (0230): the charge writes CHARGED_TO_IMPORT in its own
      // transaction — ap02-charged-to-import.
      'landed_cost_charge',
      'payable_event',
      'payable_hold',
      'payable_hold_update',
      // Stage 3 (0232): planning writes INSTALMENT_PLANNED; every application
      // move writes its event — ap03-payments.
      'payable_instalment',
      'payable_order_line',
      'payment_application',
      // Stage 2 (0230): the confirmation writes SERVICE_RECEIPT_CREATED /
      // SERVICE_CONFIRMED — ap02-service-flow.
      'service_receipt',
      'shipment_container',
      // Stage 2 (0230): link / approve / pay / settle all write through
      // payables.onAdvanceEvent — ap02-advance-link.
      'supplier_advance',
    ]);
  });

  it('every Stage-1 mutation leaves at least one event behind', async () => {
    // create — the opening of the story.
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, IMPORT_INPUT(world)),
    );
    let before = await eventCount(created.id);
    expect(before).toBeGreaterThan(0);

    const mutate = async (label: string, run: () => Promise<unknown>) => {
      const was = await eventCount(created.id);
      await run();
      const now = await eventCount(created.id);
      expect(now, `${label} wrote no payable_event`).toBeGreaterThan(was);
    };

    await mutate('setTerms', () =>
      withScope(scope(world.manager), (tx) =>
        payables.setTerms(tx, world.manager, {
          payableId: created.id,
          paymentTermsText: '20% deposit, 80% against B/L copy',
        }),
      ),
    );

    await mutate('addNote', () =>
      withScope(scope(world.manager), (tx) =>
        payables.addNote(tx, world.manager, {
          payableId: created.id,
          note: 'Supplier confirmed production started.',
        }),
      ),
    );

    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-COV-1',
      totalIqd: '751940000',
    });
    await mutate('linkInvoice', () =>
      withScope(scope(world.manager), (tx) =>
        payables.linkInvoice(tx, world.manager, {
          payableId: created.id,
          apInvoiceId: invoiceId,
        }),
      ),
    );

    let holdId = '';
    await mutate('holds.open', async () => {
      const opened = await withScope(scope(world.manager), (tx) =>
        holds.open(tx, world.manager, {
          payableId: created.id,
          laneCode: 'payment',
          reasonCode: 'DOC',
          ownerUserId: world.officer.principal.userId,
          nextAction: 'Send the missing invoice copy to the bank',
          nextActionDue: '2026-10-08',
        }),
      );
      holdId = opened.id;
    });

    await mutate('holds.update', () =>
      withScope(scope(world.officer), (tx) =>
        holds.update(tx, world.officer, { holdId, note: 'Copy couriered this morning.' }),
      ),
    );

    await mutate('holds.reassign', () =>
      withScope(scope(world.manager), (tx) =>
        holds.reassign(tx, world.manager, {
          holdId,
          ownerUserId: world.manager.principal.userId,
        }),
      ),
    );

    await mutate('holds.resolve', () =>
      withScope(scope(world.manager), (tx) =>
        holds.resolve(tx, world.manager, { holdId, resolution: 'Bank confirmed receipt.' }),
      ),
    );

    // cancel — on a fresh payable with no posted invoice in the way.
    const cancellable = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'advance',
        supplierReference: 'DEP-COV',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        currency: 'USD',
        documentDate: '2026-09-01',
        description: 'Deposit opened in error',
        amountTxn: '100',
      }),
    );
    const wasCancellable = await eventCount(cancellable.id);
    await withScope(scope(world.manager), (tx) =>
      payables.cancel(tx, world.manager, {
        payableId: cancellable.id,
        reason: 'Opened twice; DEP-001 is the real one.',
      }),
    );
    expect(await eventCount(cancellable.id)).toBeGreaterThan(wasCancellable);
  });

  it('the invoice hook fires inside the posting service, not beside it', async () => {
    // The wiring in ap-invoice.post/reverse calls payables.onInvoiceEvent in
    // the same transaction; its full path is exercised by the AP suites. Here:
    // the hook itself writes the event and re-derives in one call.
    const created = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'service',
        supplierReference: 'HOOK-1',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'USD',
        documentDate: '2026-09-01',
        description: 'Hook check',
        amountTxn: '100',
      }),
    );
    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-COV-2',
      totalIqd: '131000',
      payableId: created.id,
    });

    const before = await eventCount(created.id);
    await withScope(scope(world.manager), (tx) =>
      payables.onInvoiceEvent(tx, {
        payableId: created.id,
        eventCode: 'INVOICE_POSTED',
        invoiceId,
        invoiceNo: 'API-COV-2',
        summary: 'Purchase invoice API-COV-2 posted — 131,000 IQD',
        actorUserId: world.manager.principal.userId,
      }),
    );
    // One for the invoice, one for the stage that moved with it.
    expect(await eventCount(created.id)).toBeGreaterThanOrEqual(before + 2);
  });
});
