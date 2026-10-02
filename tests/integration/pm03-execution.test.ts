/**
 * REQ-PM-001 Stage PM-3 — execution.
 *
 *   PM6 `pm03-commitments` — a purchase order approved with an element
 *                            assigned is a commitment; posting its invoice
 *                            converts it to an actual without double-counting;
 *                            cancelling releases it with a reason; a payable
 *                            without an order is a commitment of its own;
 *                            reversal gives the promise back.
 *   PM7 `pm03-line-items`  — the line items equal the journal lines carrying
 *                            the dimension plus the material issues, and
 *                            their sum equals the element's actual; the
 *                            Material Issues document moves stock and cost
 *                            in one transaction, once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as orders from '@/server/services/purchase-order';
import * as payables from '@/server/services/payables';
import * as pb from '@/server/services/project-budget';
import * as pe from '@/server/services/project-execution';
import * as ps from '@/server/services/project-system';
import * as sr from '@/server/services/service-receipt';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const price = (v: string) => parseDecimal(v, 4n);
let world: TradingWorld;
let releaser: ActorContext;
let seq = 0;

async function anotherManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `releaser-${(seq += 1)}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope(scope(ctx), fn);

beforeEach(async () => {
  world = await buildTradingWorld();
  releaser = await anotherManager();
});

/** A released internal project: root, one child element, an original budget of 5,000,000 SUB on the child. */
async function stagedProject(code = 'DEPOT-26') {
  const { projectCode } = await as(world.manager, (tx) =>
    ps.createDefinition(tx, world.manager, { name: 'Depot extension', typeCode: 'INTERNAL', code, branchCode: BAGHDAD, managerUserId: world.manager.principal.userId, baselineStartsOn: '2026-10-01', baselineEndsOn: '2027-03-31' }),
  );
  const root = `${projectCode}-1`;
  const civil = (await as(world.manager, (tx) => ps.addElement(tx, world.manager, projectCode, { parentCode: root, name: 'Civil works' }))).code;
  await as(releaser, (tx) => ps.release(tx, releaser, projectCode));
  const doc = await as(world.manager, (tx) =>
    pb.createBudgetDocument(tx, world.manager, projectCode, { kind: 'original', description: 'Tender', lines: [{ wbsCode: civil, costCode: 'SUB', amountIqd: '5000000' }, { wbsCode: civil, costCode: 'MAT', amountIqd: '3000000' }] }),
  );
  await as(world.manager, (tx) => pb.submitBudgetDocument(tx, world.manager, doc.documentNo));
  await as(releaser, (tx) => pb.approveBudgetDocument(tx, releaser, doc.documentNo));
  return { projectCode, root, civil };
}

const elementOf = async (projectCode: string, code: string) => (await as(world.manager, (tx) => ps.tree(tx, projectCode))).find((e) => e.code === code)!;

describe('PM6 · pm03-commitments — the order promises, the invoice spends, the cancellation gives back', () => {
  it('an approved order with an element is a commitment; its invoice converts it without double-counting; a reversal gives it back', async () => {
    const { projectCode, civil } = await stagedProject();
    const made = await as(world.clerk, (tx) =>
      orders.create(tx, world.clerk, {
        supplierId: world.supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-10-05',
        projectCode,
        wbsCode: civil,
        costCode: 'SUB',
        lines: [{ lineType: 'service', description: 'Earthworks subcontract', quantity: parseQuantity('1'), uomCode: 'EA', unitPriceIqd: price('2000000'), branchCode: BAGHDAD }],
      }),
    );
    // Nothing is promised before approval.
    expect((await elementOf(projectCode, civil)).committedIqd).toBe('0.0000');
    await as(world.clerk, (tx) => orders.submit(tx, world.clerk, made.id));
    await as(world.manager, (tx) => orders.approve(tx, world.manager, made.id));
    expect(await elementOf(projectCode, civil)).toMatchObject({ committedIqd: '2000000.0000', actualIqd: '0.0000', availableIqd: '6000000.0000' });
    const { rows: promise } = await ownerPool.query(`select wbs_code, cost_code, amount_iqd::text as a, purchase_order_id from project_commitment where project_code = $1`, [projectCode]);
    expect(promise).toEqual([{ wbs_code: civil, cost_code: 'SUB', a: '2000000.0000', purchase_order_id: made.id }]);
    // Approving again changes nothing.
    expect(await rejection(as(world.manager, (tx) => orders.approve(tx, world.manager, made.id)))).toMatch(/only a submitted order/);

    // The service is confirmed by the benefiting department (§8.6), then invoiced against the order; the invoice stands where the order stands.
    const { rows: lines } = await ownerPool.query(`select id from purchase_order_line where purchase_order_id = $1`, [made.id]);
    const receipt = await as(world.clerk, (tx) => sr.create(tx, world.clerk, { purchaseOrderId: made.id, departmentCode: 'FIN', branchCode: BAGHDAD, serviceDate: '2026-10-15', lines: [{ purchaseOrderLineId: lines[0]!.id, quantity: parseQuantity('1') }] }));
    await as(world.clerk, (tx) => sr.submit(tx, world.clerk, receipt.id));
    await as(world.manager, (tx) => sr.approve(tx, world.manager, receipt.id));
    const invoice = await as(world.clerk, (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'SUB-001',
        purchaseOrderId: made.id,
        branchCode: BAGHDAD,
        invoiceDate: '2026-10-20',
        dueDate: '2026-11-20',
        expenseAccountId: world.accounts.expense ?? null,
        lines: [{ purchaseOrderLineId: lines[0]!.id, description: 'Earthworks subcontract', quantity: parseQuantity('1'), unitPriceIqd: price('2000000'), isInventory: false }],
      }),
    );
    const { rows: header } = await ownerPool.query(`select project_code, wbs_code, cost_code from ap_invoice where id = $1`, [invoice.id]);
    expect(header[0]).toEqual({ project_code: projectCode, wbs_code: civil, cost_code: 'SUB' });
    await as(world.clerk, (tx) => ap.submit(tx, world.clerk, invoice.id));
    const posted = await as(world.manager, (tx) => ap.post(tx, world.manager, invoice.id));
    // Committed 0, actual 2,000,000 — one figure, not two.
    expect(await elementOf(projectCode, civil)).toMatchObject({ committedIqd: '0.0000', actualIqd: '2000000.0000', availableIqd: '6000000.0000' });
    const { rows: cost } = await ownerPool.query(`select kind, amount_iqd::text as a, journal_entry_id, source_type, source_id, consumed_commitment_id from project_cost where project_code = $1`, [projectCode]);
    expect(cost).toEqual([{ kind: 'invoice', a: '2000000.0000', journal_entry_id: posted.journalEntryId, source_type: 'ap_invoice', source_id: invoice.id, consumed_commitment_id: expect.any(String) }]);
    // The journal lines carry the project dimension.
    const { rows: dims } = await ownerPool.query(`select count(*)::int as n from journal_line where journal_entry_id = $1 and project_code = $2`, [posted.journalEntryId, projectCode]);
    expect(dims[0]!.n).toBeGreaterThan(0);
    // The line items read the same figure as the journal.
    const items = await as(world.manager, (tx) => pe.lineItems(tx, { projectCode }));
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]).toMatchObject({ wbsCode: civil, costCode: 'SUB', invoiceNo: invoice.invoiceNo, amountIqd: '2000000.0000' });
    expect(await as(world.manager, (tx) => pe.journalTotal(tx, projectCode))).toBe(price('2000000'));

    // The procurement register shows the order with its promise fully converted.
    const procurement = await as(world.manager, (tx) => pe.procurement(tx, { projectCode }));
    expect(procurement.rows).toHaveLength(1);
    expect(procurement.rows[0]).toMatchObject({ documentType: 'purchase_order', documentNo: made.orderNo, committedIqd: '2000000.0000', consumedIqd: '2000000.0000', openIqd: '0.0000' });

    // Reversal: the cost is mirrored, the promise stands open again.
    await as(world.manager, (tx) => ap.reverse(tx, world.manager, invoice.id, { reason: 'wrong supplier' }));
    expect(await elementOf(projectCode, civil)).toMatchObject({ committedIqd: '2000000.0000', actualIqd: '0.0000' });
    const after = await as(world.manager, (tx) => pe.lineItems(tx, { projectCode }));
    expect(after.rows.map((r) => [r.kind, r.amountIqd, r.isReversal]).sort()).toEqual([
      ['invoice', '2000000.0000', false],
      ['invoice_reversal', '-2000000.0000', true],
    ]);
    expect(after.totalIqd).toBe('0.0000');

    // Cancelling the order releases what it still promises, with the reason.
    await as(world.manager, (tx) => orders.cancel(tx, world.manager, made.id, 'subcontractor withdrew'));
    expect(await elementOf(projectCode, civil)).toMatchObject({ committedIqd: '0.0000', availableIqd: '8000000.0000' });
    const { rows: released } = await ownerPool.query(`select released_on, release_reason from project_commitment where purchase_order_id = $1`, [made.id]);
    expect(released[0]!.released_on).not.toBeNull();
    expect(released[0]!.release_reason).toMatch(/subcontractor withdrew/);
  });

  it('an order over the element\'s availability is refused at approval; an incomplete assignment is refused at creation', async () => {
    const { projectCode, civil } = await stagedProject();
    expect(
      await rejection(
        as(world.clerk, (tx) =>
          orders.create(tx, world.clerk, { supplierId: world.supplierId, branchCode: BAGHDAD, orderDate: '2026-10-05', projectCode, wbsCode: civil, lines: [{ lineType: 'service', description: 'x', quantity: parseQuantity('1'), uomCode: 'EA', unitPriceIqd: price('1'), branchCode: BAGHDAD }] }),
        ),
      ),
    ).toMatch(/names the project, the element and the cost code together/);
    const big = await as(world.clerk, (tx) =>
      orders.create(tx, world.clerk, {
        supplierId: world.supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-10-05',
        projectCode,
        wbsCode: civil,
        costCode: 'SUB',
        lines: [{ lineType: 'service', description: 'Too much', quantity: parseQuantity('1'), uomCode: 'EA', unitPriceIqd: price('9000000'), branchCode: BAGHDAD }],
      }),
    );
    await as(world.clerk, (tx) => orders.submit(tx, world.clerk, big.id));
    expect(await rejection(as(world.manager, (tx) => orders.approve(tx, world.manager, big.id)))).toMatch(/available|stop line/);
    expect((await elementOf(projectCode, civil)).committedIqd).toBe('0.0000');
  });

  it('a service payable without an order is a commitment of its own, released when it is cancelled', async () => {
    const { projectCode, civil } = await stagedProject();
    const opened = await as(world.manager, (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'service',
        supplierReference: 'SRV-77',
        supplierId: world.supplierId,
        branchCode: BAGHDAD,
        departmentCode: 'FIN',
        currency: 'IQD',
        documentDate: '2026-10-06',
        description: 'Site survey',
        amountTxn: '750000',
        projectCode,
        wbsCode: civil,
        costCode: 'SUB',
      }),
    );
    expect(await elementOf(projectCode, civil)).toMatchObject({ committedIqd: '750000.0000' });
    const procurement = await as(world.manager, (tx) => pe.procurement(tx, { projectCode }));
    expect(procurement.rows[0]).toMatchObject({ documentType: 'payable', documentNo: opened.payableNo, committedIqd: '750000.0000', openIqd: '750000.0000' });
    await as(world.manager, (tx) => payables.cancel(tx, world.manager, { payableId: opened.id, reason: 'survey not needed' }));
    expect((await elementOf(projectCode, civil)).committedIqd).toBe('0.0000');
  });
});

describe('PM7 · pm03-line-items — the Material Issues document and the sum of the line items', () => {
  async function stocked() {
    await as(world.manager, (tx) =>
      inventory.receive(tx, world.manager, { itemCode: PANEL, warehouseCode: WAREHOUSE, branchCode: BAGHDAD, quantity: parseQuantity('100'), unitCostIqd: price('10000'), movementDate: '2026-10-01', kind: 'goods_receipt', batchNumber: 'B-1' }),
    );
  }

  it('an issue moves the stock and raises the cost at FIFO in one transaction, once; a return goes back at the same cost', async () => {
    const { projectCode, civil } = await stagedProject();
    await stocked();
    const formId = randomUUID();
    const made = await as(world.clerk, (tx) =>
      pe.createIssue(tx, world.clerk, { projectCode, wbsCode: civil, costCode: 'MAT', warehouseCode: WAREHOUSE, movementDate: '2026-10-10', description: 'Panels to site', lines: [{ itemCode: PANEL, quantity: '40', batchNumber: 'B-1' }], documentId: formId }),
    );
    expect(made.documentNo).toBe('PMI-BGW-2026-000001');
    // The form's one-time id: a repeat answers with the same document.
    const again = await as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { projectCode, wbsCode: civil, costCode: 'MAT', warehouseCode: WAREHOUSE, lines: [{ itemCode: PANEL, quantity: '40' }], documentId: formId }));
    expect(again).toEqual({ id: made.id, documentNo: made.documentNo, existing: true });
    // A draft moves nothing.
    expect((await elementOf(projectCode, civil)).actualIqd).toBe('0.0000');
    const posted = await as(world.manager, (tx) => pe.postIssue(tx, world.manager, made.documentNo));
    expect(posted.totalCostIqd).toBe(price('400000'));
    expect(await rejection(as(world.manager, (tx) => pe.postIssue(tx, world.manager, made.documentNo)))).toMatch(/is posted/);
    const { rows: stock } = await ownerPool.query(`select coalesce(sum(quantity), 0)::text as q from inventory_movement where item_code = $1 and warehouse_code = $2`, [PANEL, WAREHOUSE]);
    expect(Number(stock[0]!.q)).toBe(60);
    expect(await elementOf(projectCode, civil)).toMatchObject({ actualIqd: '400000.0000' });
    const record = await as(world.manager, (tx) => pe.issue(tx, world.manager, made.documentNo));
    expect(record.document.status).toBe('posted');
    expect(record.lines[0]).toMatchObject({ costIqd: '400000.0000' });
    expect(record.lines[0]!.movementId).not.toBeNull();
    expect(record.lines[0]!.costId).not.toBeNull();

    // A return at the cost it went out at.
    const back = await as(world.clerk, (tx) =>
      pe.createIssue(tx, world.clerk, { projectCode, wbsCode: civil, costCode: 'MAT', warehouseCode: WAREHOUSE, kind: 'return', movementDate: '2026-10-12', lines: [{ itemCode: PANEL, quantity: '10', unitCostIqd: '10000', batchNumber: 'B-1' }] }),
    );
    expect(await rejection(as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { projectCode, wbsCode: civil, costCode: 'MAT', warehouseCode: WAREHOUSE, kind: 'return', lines: [{ itemCode: PANEL, quantity: '1' }] })))).toMatch(/names the unit cost/);
    await as(world.manager, (tx) => pe.postIssue(tx, world.manager, back.documentNo));
    expect(await elementOf(projectCode, civil)).toMatchObject({ actualIqd: '300000.0000' });

    // The line items: the issue and the return, their sum the element's actual; the register lists both documents.
    const items = await as(world.manager, (tx) => pe.lineItems(tx, { projectCode, wbsCode: civil }));
    expect(items.rows.map((r) => [r.kind, r.amountIqd, r.sourceId])).toEqual([
      ['material_return', '-100000.0000', back.documentNo],
      ['material_issue', '400000.0000', made.documentNo],
    ]);
    expect(items.totalIqd).toBe('300000.0000');
    const list = await as(world.manager, (tx) => pe.issues(tx, { projectCode }));
    expect(list.rows.map((r) => [r.documentNo, r.kind, r.status, r.totalCostIqd])).toEqual([
      [back.documentNo, 'return', 'posted', '-100000.0000'],
      [made.documentNo, 'issue', 'posted', '400000.0000'],
    ]);

    // A draft is cancelled with a reason; a posted one is not.
    const draft = await as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { projectCode, wbsCode: civil, costCode: 'MAT', warehouseCode: WAREHOUSE, lines: [{ itemCode: PANEL, quantity: '1', batchNumber: 'B-1' }] }));
    expect(await rejection(as(world.clerk, (tx) => pe.cancelIssue(tx, world.clerk, draft.documentNo, '')))).toMatch(/reason/);
    await as(world.clerk, (tx) => pe.cancelIssue(tx, world.clerk, draft.documentNo, 'raised twice'));
    expect(await rejection(as(world.clerk, (tx) => pe.cancelIssue(tx, world.clerk, made.documentNo, 'x')))).toMatch(/only a draft is cancelled/);
    const { rows: audit } = await ownerPool.query(`select action from audit_event where object_type = 'project_material_issue' and object_id = $1 order by occurred_at`, [made.documentNo]);
    expect(audit.map((a) => a.action)).toEqual(['project_material_issue.created', 'project_material_issue.posted']);
  });

  it('refuses an issue to an element that may not receive it, to a project that is not active, and beyond the element\'s availability', async () => {
    const { projectCode, root, civil } = await stagedProject();
    await stocked();
    await as(world.manager, (tx) => ps.addElement(tx, world.manager, projectCode, { parentCode: root, name: 'Plan only', isAccountAssignment: false }));
    const base = { costCode: 'MAT', warehouseCode: WAREHOUSE, lines: [{ itemCode: PANEL, quantity: '1', batchNumber: 'B-1' }] };
    expect(await rejection(as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { ...base, projectCode, wbsCode: `${root}.2` })))).toMatch(/not an account-assignment element/);
    expect(await rejection(as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { ...base, projectCode, wbsCode: civil, lines: [{ itemCode: 'NOPE', quantity: '1' }] })))).toMatch(/no item/);
    // 100 panels at 10,000 = 1,000,000 of a 3,000,000 MAT budget is fine; the SUB budget is not MAT's to spend.
    const ok = await as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { ...base, projectCode, wbsCode: civil, lines: [{ itemCode: PANEL, quantity: '100', batchNumber: 'B-1' }] }));
    await as(world.manager, (tx) => pe.postIssue(tx, world.manager, ok.documentNo));
    expect(await elementOf(projectCode, civil)).toMatchObject({ actualIqd: '1000000.0000' });
    await as(world.manager, (tx) => ps.hold(tx, world.manager, projectCode, 'rain'));
    expect(await rejection(as(world.clerk, (tx) => pe.createIssue(tx, world.clerk, { ...base, projectCode, wbsCode: civil })))).toMatch(/is on_hold/);
  });
});
