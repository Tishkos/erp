/**
 * Manual Stock Addition (2026-10-06, migration 0415) — stock put onto the
 * books by hand, approved by a second person.
 *
 *   * draft → sent for approval → approved by somebody else: one FIFO layer a
 *     line in the base unit (a BOX of 24 received as 24 EA at the cost of one
 *     EA), the journal Dr inventory / Cr inventory adjustment equal to the
 *     layers, the position, the movements under the warehouse's branch;
 *   * neither the author nor the sender approves (service and database);
 *   * a super user's own draft is approved in one press, both steps audited;
 *   * reject with a reason, back to draft, edit, cancel with a reason;
 *   * the lines are frozen once it leaves draft; it is never deleted;
 *   * the sheet's one-time id makes a second press harmless;
 *   * a closed period refuses; a warehouse of another branch is refused and
 *     another branch's reader sees nothing;
 *   * the paperclip, the notes and the printer answer for it; My Approvals lists it;
 *   * an unmapped offset role is refused by name; a named offset account is posted to.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, seedBranch } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as attachments from '@/server/services/attachments';
import * as approvalCenter from '@/server/services/approval-center';
import * as coa from '@/server/services/chart-of-accounts';
import * as inventory from '@/server/services/inventory';
import * as additions from '@/server/services/manual-stock-addition';
import * as recordNotes from '@/server/services/record-notes';
import * as units from '@/server/services/item-units';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { runExport } from '@/server/print/export';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { readPdf } from '../support/export-files';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const ERBIL = 'ERB';
const ERBIL_STORE = 'WH-MSA-ERB';
const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);

let world: TradingWorld;
let approver: ActorContext;
let superUser: ActorContext;
let adjustmentAccount: string;

async function person(options: { roles?: readonly string[]; superUser?: boolean; branch?: string } = {}): Promise<ActorContext> {
  const id = randomUUID();
  const branch = options.branch ?? BAGHDAD;
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [
    id,
    `${id}@example.com`,
    options.superUser ? 'Owner' : 'Second Approver',
    options.superUser ?? false,
  ]);
  for (const role of options.roles ?? []) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

const as = <T>(ctx: ActorContext, fn: (tx: Tx) => Promise<T>) => withScope({ userId: ctx.principal.userId, branchCode: ctx.branchCode }, fn);

/** Two boxes of panels at 240,000 a box (24 a box) and five loose at 10,500. */
const SHEET: additions.AdditionInput = {
  warehouseCode: WAREHOUSE,
  postingDate: '2026-09-15',
  reason: 'Found in the back store during the September walk-round',
  lines: [
    { itemCode: PANEL, uomCode: 'BOX', quantity: q('2'), unitCostIqd: iqd('240000') },
    { itemCode: PANEL, uomCode: 'EA', quantity: q('5'), unitCostIqd: iqd('10500') },
  ],
};

const raise = (ctx: ActorContext = world.clerk, input: Partial<additions.AdditionInput> = {}) =>
  as(ctx, (tx) => additions.create(tx, ctx, { ...SHEET, ...input }));
const send = (ctx: ActorContext, id: string) => as(ctx, (tx) => additions.submit(tx, ctx, id));
const approve = (ctx: ActorContext, id: string) => as(ctx, (tx) => additions.approve(tx, ctx, id));
const view = (ctx: ActorContext, no: string) => as(ctx, (tx) => additions.viewByNo(tx, no));

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  world = await buildTradingWorld();
  // The account the value is credited to, mapped as Item Reconciliation's is.
  const { rows: parent } = await ownerPool.query(`select id, account_type from chart_of_account where code = 'X000001'`);
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('X980011','Inventory Adjustments',$1,$2,false,true,'approved',1,'IQD') returning id`,
    [parent[0].account_type, parent[0].id],
  );
  adjustmentAccount = rows[0].id;
  await as(world.manager, (tx) => coa.setRequiredDimensions(tx, world.manager, adjustmentAccount, []));
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('inventory.stock_adjustment','inventory_adjustment',$1,true,$2) on conflict do nothing`,
    [adjustmentAccount, world.manager.principal.userId],
  );
  // A box of 24 — the line is written in boxes, the stock is counted in each.
  await as(world.manager, (tx) => units.addUnit(tx, world.manager, PANEL, { uomCode: 'BOX', numerator: 24n }));
  approver = await person({ roles: ['accounting_manager'] });
  superUser = await person({ superUser: true });
  await seedBranch(ERBIL, 'Erbil');
  await ownerPool.query(`insert into warehouse (code, name, branch_code, warehouse_type) values ($1,'Erbil Store',$2,'main')`, [ERBIL_STORE, ERBIL]);
}, 120_000);

describe('the road and the posting', () => {
  it('is raised, sent, and approved by somebody else: the layers in base units, the journal equal to them, the position', async () => {
    const made = await raise();
    expect(made.additionNo).toMatch(/^MSA-BGW-2026-\d{6}$/);
    let found = (await view(world.clerk, made.additionNo))!;
    expect(found.document.status).toBe('draft');
    expect(found.lines.map((line) => [line.uomCode, line.quantity, iqd(line.unitCostIqd), iqd(line.lineValueIqd)])).toEqual([
      ['BOX', '2', iqd('240000'), iqd('480000')],
      ['EA', '5', iqd('10500'), iqd('52500')],
    ]);
    expect(iqd(found.totalIqd)).toBe(iqd('532500'));
    // A draft moves nothing.
    expect((await as(world.clerk, (tx) => inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD))).onHand).toBe(0n);

    await send(world.clerk, made.id);
    const posted = await approve(world.manager, made.id);
    expect(posted.movementIds).toHaveLength(2);
    expect(iqd(posted.totalIqd)).toBe(iqd('532500'));

    found = (await view(world.manager, made.additionNo))!;
    expect(found.document.status).toBe('approved');
    expect(found.document.journalEntryNo).toBeTruthy();
    // Two boxes are forty-eight each, at 10,000 an each; one layer a line.
    expect(found.lines.map((line) => [line.baseQuantity, line.baseUnitCostIqd && iqd(line.baseUnitCostIqd)])).toEqual([
      ['48', iqd('10000')],
      ['5', iqd('10500')],
    ]);
    expect(found.layers.map((layer) => [layer.lineNo, layer.quantity, iqd(layer.unitCostIqd), iqd(layer.valueIqd), layer.batchNumber, layer.layerDate])).toEqual([
      [1, '48', iqd('10000'), iqd('480000'), made.additionNo, '2026-09-15'],
      [2, '5', iqd('10500'), iqd('52500'), made.additionNo, '2026-09-15'],
    ]);
    // Dr the item's inventory account / Cr inventory adjustment — equal to the layers, to the fils.
    expect(found.journalLines.map((line) => [line.accountCode, iqd(line.debitIqd), iqd(line.creditIqd)])).toEqual([
      [expect.any(String), iqd('532500'), 0n],
      ['X980011', 0n, iqd('532500')],
    ]);
    expect(iqd(found.postedIqd)).toBe(iqd('532500'));
    const { rows: debit } = await ownerPool.query(
      `select l.account_id from journal_line l join journal_entry j on j.id = l.journal_entry_id where j.entry_no = $1 and l.debit_iqd > 0`,
      [found.document.journalEntryNo],
    );
    expect(debit[0].account_id).toBe(world.accounts.inventory);

    const position = await as(world.manager, (tx) => inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD));
    expect(position.onHand).toBe(q('53'));
    const { rows: movements } = await ownerPool.query(
      `select kind::text, branch_code, quantity::text, source_line_id from inventory_movement
        where source_document_type = 'manual_stock_addition' and source_document_id = $1 order by source_line_id`,
      [made.id],
    );
    expect(movements).toEqual([
      { kind: 'count_adjustment', branch_code: BAGHDAD, quantity: '48.000000', source_line_id: '1' },
      { kind: 'count_adjustment', branch_code: BAGHDAD, quantity: '5.000000', source_line_id: '2' },
    ]);

    const { rows: trail } = await ownerPool.query(
      `select action from audit_event where object_type = 'manual_stock_addition' and object_id = $1 order by id`,
      [made.id],
    );
    expect(trail.map((row) => row.action)).toEqual([
      'manual_stock_addition.created',
      'manual_stock_addition.submitted',
      'manual_stock_addition.approved',
    ]);
    // An approved addition is final: it is not cancelled, rejected or approved again.
    expect(await refusal(as(world.manager, (tx) => additions.cancel(tx, world.manager, made.id, 'Late')))).toMatch(/only a draft or a rejected/);
    expect(await refusal(approve(approver, made.id))).toMatch(/only a document sent for approval/);
  });

  it('is approved by neither its author nor its sender — in the service and in the database', async () => {
    // Raised and sent by the manager: the manager may not approve it, a second manager may.
    const made = await raise(world.manager);
    await send(world.manager, made.id);
    expect(await refusal(approve(world.manager, made.id))).toMatch(/cannot approve it/);
    // The clerk holds no approve at all.
    expect(await refusal(approve(world.clerk, made.id))).toMatch(/approve|permit|denied/i);

    // Raised by the clerk, sent by the manager: the sender may not approve either.
    const other = await raise(world.clerk, { documentId: randomUUID() });
    await send(world.manager, other.id);
    expect(await refusal(approve(world.manager, other.id))).toMatch(/cannot approve it/);

    // The database holds the same rule (0415 manual_stock_addition_four_eyes).
    await expect(
      ownerPool.query(`update manual_stock_addition set approved_by = submitted_by where id = $1`, [other.id]),
    ).rejects.toThrow(/manual_stock_addition_four_eyes/);

    await approve(approver, other.id);
    expect((await view(approver, other.additionNo))!.document.status).toBe('approved');
  });

  it("goes straight from draft to approved for a super user's own draft, with both steps audited", async () => {
    const made = await raise(superUser);
    // Not for anybody else's draft, and not for anybody who is not a super user.
    const clerks = await raise(world.clerk, { documentId: randomUUID() });
    expect(await refusal(as(superUser, (tx) => additions.approveDraft(tx, superUser, clerks.id)))).toMatch(/raised by somebody else/);
    expect(await refusal(as(world.clerk, (tx) => additions.approveDraft(tx, world.clerk, clerks.id)))).toMatch(/only a super user/);

    await as(superUser, (tx) => additions.approveDraft(tx, superUser, made.id));
    const found = (await view(superUser, made.additionNo))!;
    expect(found.document.status).toBe('approved');
    expect(found.document.submittedBy).toBe(superUser.principal.userId);
    const { rows } = await ownerPool.query(
      `select action, actor_user_id from audit_event where object_type = 'manual_stock_addition' and object_id = $1 order by id`,
      [made.id],
    );
    expect(rows.map((row) => row.action)).toEqual([
      'manual_stock_addition.created',
      'manual_stock_addition.submitted',
      'manual_stock_addition.approved',
    ]);
    expect(new Set(rows.map((row) => row.actor_user_id))).toEqual(new Set([superUser.principal.userId]));
  });

  it('is rejected with a reason, returned to draft, corrected, and cancelled with a reason', async () => {
    const made = await raise();
    await send(world.clerk, made.id);
    expect(await refusal(as(world.manager, (tx) => additions.reject(tx, world.manager, made.id, '  ')))).toMatch(/Say why/);
    await as(world.manager, (tx) => additions.reject(tx, world.manager, made.id, 'The price is last year\'s'));
    let found = (await view(world.clerk, made.additionNo))!;
    expect(found.document).toMatchObject({ status: 'rejected', rejectionReason: "The price is last year's" });
    // Rejected is not a draft: it is reopened before it is edited.
    expect(await refusal(as(world.clerk, (tx) => additions.updateDraft(tx, world.clerk, made.id, SHEET)))).toMatch(/only a draft is edited/);
    await as(world.clerk, (tx) => additions.reopen(tx, world.clerk, made.id));
    await as(world.clerk, (tx) =>
      additions.updateDraft(tx, world.clerk, made.id, { ...SHEET, lines: [{ itemCode: PANEL, uomCode: 'EA', quantity: q('3'), unitCostIqd: iqd('11000') }] }),
    );
    found = (await view(world.clerk, made.additionNo))!;
    expect(found.document.status).toBe('draft');
    expect(found.lines.map((line) => [line.quantity, iqd(line.lineValueIqd)])).toEqual([['3', iqd('33000')]]);

    expect(await refusal(as(world.clerk, (tx) => additions.cancel(tx, world.clerk, made.id, '')))).toMatch(/Say why/);
    await as(world.clerk, (tx) => additions.cancel(tx, world.clerk, made.id, 'Counted twice — it was already on the books'));
    found = (await view(world.clerk, made.additionNo))!;
    expect(found.document).toMatchObject({ status: 'cancelled', cancellationReason: 'Counted twice — it was already on the books' });
    expect(await refusal(send(world.clerk, made.id))).toMatch(/only a draft/);
    // Never deleted.
    await expect(ownerPool.query(`delete from manual_stock_addition where id = $1`, [made.id])).rejects.toThrow();
  });
});

describe('what holds it', () => {
  it('freezes the lines once it leaves draft', async () => {
    const made = await raise();
    await send(world.clerk, made.id);
    expect(await refusal(as(world.clerk, (tx) => additions.updateDraft(tx, world.clerk, made.id, SHEET)))).toMatch(/only a draft is edited/);
    // As the application role, through its own row security: the trigger refuses (the driver wraps PostgreSQL's words in `cause`).
    const caught = await as(world.clerk, (tx) =>
      tx.execute(sql`update manual_stock_addition_line set quantity = 99 where addition_id = ${made.id}::uuid`),
    ).then(
      () => null,
      (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
    );
    expect(caught).toMatch(/lines are changed only in draft/);
    await expect(
      ownerPool.query(`delete from manual_stock_addition_line where addition_id = $1`, [made.id]),
    ).rejects.toThrow(/lines are changed only in draft/);
    await expect(
      ownerPool.query(`update manual_stock_addition set reason = 'other' where id = $1`, [made.id]),
    ).rejects.toThrow(/changed only in draft/);
  });

  it('answers a second press of one sheet with the document the first made', async () => {
    const documentId = randomUUID();
    const first = await raise(world.clerk, { documentId });
    const second = await raise(world.clerk, { documentId });
    expect(second).toEqual(first);
    const { rows } = await ownerPool.query(`select count(*)::int as n from manual_stock_addition`);
    expect(rows[0].n).toBe(1);
  });

  it('is refused in a closed period, before anything moves', async () => {
    const made = await raise(world.clerk, { postingDate: '2026-01-20' });
    await send(world.clerk, made.id);
    await ownerPool.query(`update fiscal_period set status = 'closed' where name = 'January 2026'`);
    expect(await refusal(approve(world.manager, made.id))).toMatch(/closed/i);
    const { rows } = await ownerPool.query(`select count(*)::int as n from inventory_movement where source_document_id = $1`, [made.id]);
    expect(rows[0].n).toBe(0);
    expect((await view(world.manager, made.additionNo))!.document.status).toBe('submitted');
  });

  it('keeps to the branch: a warehouse of another branch is refused, and another branch reads nothing', async () => {
    expect(await refusal(raise(world.clerk, { warehouseCode: ERBIL_STORE }))).toMatch(/belongs to branch ERB/);
    const made = await raise();
    const erbil = await person({ roles: ['accounting_manager'], branch: ERBIL });
    expect(await view(erbil, made.additionNo)).toBeNull();
    expect(await refusal(approve(erbil, made.id))).toMatch(/No manual stock addition/);
  });

  it('refuses what cannot be added: a future date, no reason, a unit the item does not keep, a control account as the offset', async () => {
    expect(await refusal(raise(world.clerk, { postingDate: '2099-01-01' }))).toMatch(/after today/);
    expect(await refusal(raise(world.clerk, { reason: '   ' }))).toMatch(/Say why/);
    expect(
      await refusal(raise(world.clerk, { lines: [{ itemCode: PANEL, uomCode: 'KG', quantity: q('1'), unitCostIqd: iqd('1') }] })),
    ).toMatch(/not kept in KG/);
    expect(
      await refusal(raise(world.clerk, { lines: [{ itemCode: PANEL, uomCode: 'EA', quantity: q('1'), unitCostIqd: 0n }] })),
    ).toMatch(/stock price/);
    expect(await refusal(raise(world.clerk, { offsetAccountId: world.accounts.supplier_payable! }))).toMatch(/control account/);
    expect(await refusal(raise(world.clerk, { offsetAccountId: world.accounts.bank! }))).toMatch(/bank or cash account/);
  });
});

describe('the offset', () => {
  it('refuses an unmapped inventory adjustment by its name, and posts to an account the sheet names', async () => {
    await ownerPool.query(`delete from posting_rule where event_type = 'inventory.stock_adjustment' and line_role = 'inventory_adjustment'`);
    const unmapped = await raise();
    await send(world.clerk, unmapped.id);
    expect(await refusal(approve(world.manager, unmapped.id))).toMatch(/inventory_adjustment/);
    expect((await view(world.manager, unmapped.additionNo))!.document.status).toBe('submitted');

    const named = await raise(world.clerk, { documentId: randomUUID(), offsetAccountId: world.accounts.purchase_variance! });
    await send(world.clerk, named.id);
    await approve(world.manager, named.id);
    const found = (await view(world.manager, named.additionNo))!;
    const credit = found.journalLines.find((line) => iqd(line.creditIqd) > 0n)!;
    const { rows } = await ownerPool.query(`select code from chart_of_account where id = $1`, [world.accounts.purchase_variance]);
    expect(credit.accountCode).toBe(rows[0].code);
    expect(found.document.offsetAccountId).toBe(world.accounts.purchase_variance);
  });
});

describe('the department (0416)', () => {
  it('answers an adjustment account that asks for a department, and is refused by its name without one', async () => {
    await as(world.manager, (tx) => coa.setRequiredDimensions(tx, world.manager, adjustmentAccount, ['department']));
    const without = await raise();
    await send(world.clerk, without.id);
    expect(await refusal(approve(world.manager, without.id))).toMatch(/requires Department/);

    expect(await refusal(raise(world.clerk, { documentId: randomUUID(), departmentCode: 'NOPE' }))).toMatch(/No department 'NOPE'/);
    const withDepartment = await raise(world.clerk, { documentId: randomUUID(), departmentCode: 'FIN' });
    await send(world.clerk, withDepartment.id);
    await approve(world.manager, withDepartment.id);
    const found = (await view(world.manager, withDepartment.additionNo))!;
    expect(found.document).toMatchObject({ status: 'approved', departmentCode: 'FIN', departmentName: 'Finance' });
    const { rows } = await ownerPool.query(
      `select l.department_code from journal_line l join journal_entry j on j.id = l.journal_entry_id where j.entry_no = $1 and l.credit_iqd > 0`,
      [found.document.journalEntryNo],
    );
    expect(rows[0].department_code).toBe('FIN');
    // Out of draft it is part of what the document says.
    await expect(ownerPool.query(`update manual_stock_addition set department_code = 'FIN' where id = $1`, [without.id])).rejects.toThrow(/changed only in draft/);
  });
});

describe('the doors and My Approvals', () => {
  it('opens its paperclip, its notes and its printed copy to whoever reads it, and nobody else', async () => {
    registerAttachmentRuntime();
    const made = await raise();
    const outsider = await person();
    expect(await as(world.manager, (tx) => attachments.mayAccessParent(tx, world.manager.principal, 'manual_stock_addition', made.id))).toBe(true);
    expect(await as(outsider, (tx) => attachments.mayAccessParent(tx, outsider.principal, 'manual_stock_addition', made.id))).toBeFalsy();

    await as(world.clerk, (tx) => recordNotes.addNote(tx, world.clerk, { object: 'manual_stock_addition', recordId: made.id, body: 'Photo of the shelf attached.' }));
    const notes = await as(world.manager, (tx) => recordNotes.listNotes(tx, { object: 'manual_stock_addition', recordId: made.id }));
    expect(notes.map((note) => note.body)).toEqual(['Photo of the shelf attached.']);
    expect(await refusal(as(outsider, (tx) => recordNotes.addNote(tx, outsider, { object: 'manual_stock_addition', recordId: made.id, body: 'x' })))).toBeTruthy();

    await send(world.clerk, made.id);
    await approve(world.manager, made.id);
    const copy = await as(world.manager, (tx) =>
      runExport(tx, { principal: world.manager.principal, branchCode: BAGHDAD }, {
        key: 'manual_stock_addition',
        format: 'pdf',
        locale: 'en',
        at: '2026-09-20T10:00:00.000Z',
        input: { id: made.additionNo, query: new URLSearchParams() },
      }),
    );
    expect(copy!.status).toBe(200);
    const text = readPdf(copy!.status === 200 ? copy!.body : Buffer.alloc(0)).text;
    for (const expected of [made.additionNo, PANEL, WAREHOUSE, 'BOX', '480,000', '532,500']) expect(text, expected).toContain(expected);
    const denied = await as(outsider, (tx) =>
      runExport(tx, { principal: outsider.principal, branchCode: BAGHDAD }, {
        key: 'manual_stock_addition',
        format: 'pdf',
        locale: 'en',
        at: '2026-09-20T10:00:00.000Z',
        input: { id: made.additionNo, query: new URLSearchParams() },
      }),
    );
    expect(denied!.status).not.toBe(200);
  });

  it('waits in My Approvals for an approver who did not send it — and tells them', async () => {
    const made = await raise();
    await send(world.manager, made.id);
    const forApprover = await as(approver, (tx) => approvalCenter.items(tx, { principal: approver.principal, branchCode: BAGHDAD }));
    const listed = forApprover.items.find((item) => item.documentNo === made.additionNo);
    expect(listed).toMatchObject({ documentType: 'manual_stock_addition', href: `/inventory/manual-additions/${made.additionNo}`, action: 'approve' });
    expect(listed!.amount).toEqual({ value: '532500.0000', currency: 'IQD' });
    const forSender = await as(world.manager, (tx) => approvalCenter.items(tx, { principal: world.manager.principal, branchCode: BAGHDAD }));
    expect(forSender.items.some((item) => item.documentNo === made.additionNo)).toBe(false);

    const { rows } = await ownerPool.query(
      `select recipient_user_id from notification where event_type = 'approval.required' and object_type = 'manual_stock_addition' and object_id = $1`,
      [made.id],
    );
    const told = rows.map((row) => row.recipient_user_id);
    expect(told).toContain(approver.principal.userId);
    expect(told).not.toContain(world.manager.principal.userId);
    expect(told).not.toContain(world.clerk.principal.userId);
  });
});
