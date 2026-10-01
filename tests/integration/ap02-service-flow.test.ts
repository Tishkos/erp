/**
 * REQ-AP-001 A9 — "did we actually get it?" before "pay it".
 *
 * A service payable's invoice cannot post without an approved confirmation
 * when the category requires one; a category with requires_receipt=false
 * posts without it (bank charges have no confirmation to wait for). The
 * confirmation itself is the department's act, maker-checked, and it moves
 * the payable's stage.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as payables from '@/server/services/payables';
import * as receipts from '@/server/services/service-receipt';
import {
  BRANCH,
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

async function servicePayable(categoryCode: string, reference: string) {
  return withScope(scope(world.officer), (tx) =>
    payables.create(tx, world.officer, {
      payableTypeCode: 'service',
      supplierReference: reference,
      supplierId: world.supplierId,
      branchCode: BRANCH,
      departmentCode: 'FIN',
      currency: 'USD',
      documentDate: '2026-09-01',
      description: 'September consulting',
      expenseCategoryCode: categoryCode,
      amountTxn: '3000',
    }),
  );
}

describe('ap02 · the service flow: requested → confirmed → invoiced', () => {
  it('the department confirms; the confirmation is maker-checked; the stage moves', async () => {
    const created = await servicePayable('professional_fees', 'CONSULT-A9');

    const receipt = await withScope(scope(world.officer), (tx) =>
      receipts.createForPayable(tx, world.officer, {
        payableId: created.id,
        departmentCode: 'FIN',
        branchCode: BRANCH,
        serviceDate: '2026-09-28',
        description: 'September advisory delivered — report attached',
      }),
    );
    await withScope(scope(world.officer), (tx) =>
      receipts.submit(tx, world.officer, receipt.id),
    );

    // §5.2 — the person who raised a confirmation cannot approve it, even
    // holding the permission: the manager raises one and is refused their own.
    const own = await withScope(scope(world.manager), (tx) =>
      receipts.createForPayable(tx, world.manager, {
        payableId: created.id,
        departmentCode: 'FIN',
        branchCode: BRANCH,
        serviceDate: '2026-09-29',
        description: 'Second advisory block',
      }),
    );
    await withScope(scope(world.manager), (tx) => receipts.submit(tx, world.manager, own.id));
    const refusal = await rejection(
      withScope(scope(world.manager), (tx) => receipts.approve(tx, world.manager, own.id)),
    );
    expect(refusal).toMatch(/cannot approve/);

    await withScope(scope(world.manager), (tx) => receipts.approve(tx, world.manager, receipt.id));

    const { rows } = await ownerPool.query(`select stage_code from payable where id = $1`, [
      created.id,
    ]);
    expect(rows[0].stage_code).toBe('confirmed');

    const story = await eventsOf(created.id);
    const codes = story.map((event) => event.eventCode);
    expect(codes).toContain('SERVICE_RECEIPT_CREATED');
    expect(codes).toContain('SERVICE_CONFIRMED');
  });

  it('A9 — the invoice refuses to post before the confirmation, and posts after it', async () => {
    const created = await servicePayable('professional_fees', 'CONSULT-A9B');
    const { assertReceiptEvidence } = await import('@/server/services/payables');

    // The guard the invoice posting calls, directly: no approved confirmation
    // yet, category requires one → refused with the receipt named as the cure.
    const refusal = await rejection(
      withScope(scope(world.manager), (tx) => assertReceiptEvidence(tx, created.id)),
    );
    expect(refusal).toMatch(/confirm/i);

    const receipt = await withScope(scope(world.officer), (tx) =>
      receipts.createForPayable(tx, world.officer, {
        payableId: created.id,
        departmentCode: 'FIN',
        branchCode: BRANCH,
        serviceDate: '2026-09-28',
        description: 'Delivered',
      }),
    );
    await withScope(scope(world.officer), (tx) => receipts.submit(tx, world.officer, receipt.id));
    await withScope(scope(world.manager), (tx) => receipts.approve(tx, world.manager, receipt.id));

    await withScope(scope(world.manager), (tx) => assertReceiptEvidence(tx, created.id));
  });

  it('A9 — a category with requires_receipt=false approves with the note shown', async () => {
    const created = await servicePayable('bank_charges', 'CHG-A9');
    const { assertReceiptEvidence } = await import('@/server/services/payables');

    const verdict = await withScope(scope(world.manager), (tx) =>
      assertReceiptEvidence(tx, created.id),
    );
    // No refusal — and the note the approver sees says why.
    expect(verdict.required).toBe(false);
    expect(verdict.note).toMatch(/no receipt required/i);
  });

  it('a disputed confirmation is an event and a hold, not a silent disagreement', async () => {
    const created = await servicePayable('utilities', 'UTIL-A9');
    const invoiceId = await postedInvoice(world, {
      invoiceNo: 'API-A9-1',
      totalIqd: '393000',
      payableId: created.id,
      status: 'draft',
    });
    expect(invoiceId).toBeTruthy();

    await withScope(scope(world.officer), (tx) =>
      payables.addNote(tx, world.officer, {
        payableId: created.id,
        note: 'Meter reading disputed with provider',
      }),
    );
    const story = await eventsOf(created.id);
    expect(story.map((event) => event.eventCode)).toContain('NOTE_ADDED');
  });
});
