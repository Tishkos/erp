/**
 * REQ-PAY-001 PAY3 — every purchase record takes paperwork.
 *
 * The purchase invoice had an upload form and nothing registered to answer
 * "may this person see the invoice?", so the attachment service refused every
 * file put on one (§25: an unregistered parent is denied). Each purchase
 * document now answers it the way the import application does: the object's
 * `view` grant, and row security for the branch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import * as attachments from '@/server/services/attachments';
import * as authz from '@/server/services/authorization';
import * as ap from '@/server/services/ap-invoice';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const PURCHASE_OBJECTS = [
  'ap_invoice',
  'purchase_order',
  'goods_receipt',
  'goods_return',
  'supplier_payment',
  'supplier_advance',
  'recurring_contract',
  'supplier_credit_memo',
] as const;

let world: TradingWorld;
const files = new Map<string, Buffer>();

beforeEach(async () => {
  world = await buildTradingWorld();
  registerAttachmentRuntime();
  attachments.registerStorage({
    put: async (key, content) => void files.set(key, content),
    get: async (key) => files.get(key) ?? null,
  });
  attachments.registerScanner(() => ({ status: 'clean' }));
});

async function draftInvoice(): Promise<string> {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'JNK-ATT-1',
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      lines: [
        {
          itemCode: PANEL,
          quantity: parseQuantity('2'),
          unitPriceIqd: parseDecimal('50000', 4n),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  return made.id;
}

/** A user who may upload files (HR's grant) but reads no purchase invoices. */
async function userWith(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Reader')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

describe('PAY3 · purchase documents take attachments', () => {
  it('a file goes onto a draft purchase invoice and is listed on it', async () => {
    const invoiceId = await draftInvoice();
    const uploaded = await withScope(scope(world.clerk), (tx) =>
      attachments.upload(tx, world.clerk, {
        objectType: 'ap_invoice',
        objectId: invoiceId,
        fileName: 'supplier-invoice.pdf',
        content: Buffer.from('%PDF-1.4\n%supplier invoice\n'),
      }),
    );
    expect(uploaded.scanStatus).toBe('clean');
    const listed = await withScope(scope(world.clerk), (tx) => attachments.currentFor(tx, 'ap_invoice', invoiceId));
    expect(listed.map((row) => row.fileName)).toEqual(['supplier-invoice.pdf']);
  });

  it('somebody who cannot read purchase invoices cannot staple a file to one', async () => {
    const invoiceId = await draftInvoice();
    const outsider = await userWith('hr_officer');
    expect(
      await rejection(
        withScope(scope(outsider), (tx) =>
          attachments.upload(tx, outsider, {
            objectType: 'ap_invoice',
            objectId: invoiceId,
            fileName: 'note.txt',
            content: Buffer.from('hello'),
          }),
        ),
      ),
    ).toMatch(/cannot access the record it belongs to/);
  });

  it('every purchase document type has its access answered — none is refused as unknown', async () => {
    for (const objectType of PURCHASE_OBJECTS) {
      const refusal = await rejection(
        withScope(scope(world.manager), (tx) =>
          attachments.upload(tx, world.manager, {
            objectType,
            objectId: randomUUID(),
            fileName: 'x.txt',
            content: Buffer.from('x'),
          }),
        ),
      );
      // A record that does not exist is "cannot access", never "cannot be determined".
      expect(refusal, objectType).toMatch(/cannot access the record it belongs to/);
      expect(refusal, objectType).not.toMatch(/cannot be determined/);
    }
  });
});
