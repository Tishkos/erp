/**
 * The purchase invoice, 2026-10-06 — eight things the owner asked for at once.
 *
 *   1  "advance amount make it payable amount" — the share's figure is the
 *      Payable amount, on the form, the record and the printed copy.
 *   2  The supplier's own invoice / receipt number on the form, kept, unique
 *      per supplier (§15), corrected on a draft, found by the register search.
 *   3  The balance of each account the invoice names, read from the ledger.
 *   4  An item is bought only from a supplier linked to it (0408).
 *   5  A customer is created without payment terms, and its sales fall due on
 *      the invoice date.
 *   6  A super user's own draft is approved and posted in one press; nobody
 *      else skips Send for approval, and an automation rule's review holds.
 *   7  The register's Import application filter.
 *   8  New purchase invoices are numbered PUR- (0409); API- numbers still read.
 *
 * On a database of its own (`erp_test_pi`), one trading world for the file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { appPool, ownerPool, rejection } from './setup';
import { linkItemToSupplier } from './item-supplier';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';
import { withScope, type Tx } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as automation from '@/server/services/automation';
import * as items from '@/server/services/items';
import * as orders from '@/server/services/purchase-order';
import * as partners from '@/server/services/partners';
import * as trialBalance from '@/server/services/trial-balance';
import * as documents from '@/server/print/documents';
import { messagesFor } from '@/server/print/i18n';
import { runOnce } from '@/server/services/automation-runner';
import { invoiceRegister } from '@/server/services/screen-registers';
import { filterInvoiceRegister } from '@/server/domain/register-filters';
import { familyOf } from '@/server/domain/whatsapp-do';
import { RETIRED_PREFIXES, planQuery, withRetiredPrefixes } from '@/server/domain/search';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const ON = '2026-05-04';
const INVERTER = 'ITM-INVERTER';
const iqd = (value: string) => parseDecimal(value, 4n);
const qty = (value: string) => parseQuantity(value);

let world: TradingWorld;
let root: ActorContext;
let otherSupplierId: string;

async function superUser(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,'Owner',true)`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD, isSuperUser: true }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const as = <T>(who: ActorContext, fn: (tx: Tx) => Promise<T>) =>
  withScope({ ...scope(who), isSuperUser: who.principal.isSuperUser }, fn);

/** A purchase invoice of `count` panels at 1,000 IQD each, raised by `who`. */
function raise(
  who: ActorContext,
  options: {
    supplierId?: string;
    itemCode?: string;
    count?: string;
    supplierInvoiceNo?: string;
    advanceBasis?: string;
    advancePercent?: string | null;
    advanceAmount?: string | null;
  } = {},
) {
  return as(who, (tx) =>
    ap.create(tx, who, {
      supplierId: options.supplierId ?? world.supplierId,
      supplierInvoiceNo: options.supplierInvoiceNo ?? '',
      branchCode: BAGHDAD,
      invoiceDate: ON,
      ...(options.advanceBasis ? { advanceBasis: options.advanceBasis } : {}),
      ...(options.advancePercent ? { advancePercent: options.advancePercent } : {}),
      ...(options.advanceAmount ? { advanceAmount: options.advanceAmount } : {}),
      lines: [
        {
          itemCode: options.itemCode ?? PANEL,
          quantity: qty(options.count ?? '10'),
          unitPriceIqd: iqd('1000'),
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
}

const statusOf = async (id: string) => (await ownerPool.query(`select status::text as s from ap_invoice where id = $1`, [id])).rows[0].s as string;
const actionsOn = async (id: string) =>
  (await ownerPool.query(`select action, actor_user_id::text as actor from audit_event where object_id = $1 order by id`, [id])).rows as { action: string; actor: string }[];

beforeAll(async () => {
  world = await buildTradingWorld();
  root = await superUser();
  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ('SUP-LONGI','Longi Green',false,true,'active',true) returning id`,
  );
  otherSupplierId = rows[0].id as string;
  // A second item, linked to nobody yet — with its base unit, in one transaction (the check is deferred).
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: made } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking, inventory_account_id, cogs_account_id)
       values ($1,'Hybrid Inverter 10kW',true,'EA','batch',$2,$3) returning id`,
      [INVERTER, world.accounts.inventory, world.accounts.cogs],
    );
    await client.query(`insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator) values ($1,'EA',1,1)`, [made[0].id]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}, 240_000);

// ---------------------------------------------------------------------------
describe('8 · new purchase invoices are numbered PUR-, and API- still reads', () => {
  it('numbers the next invoice PUR-{branch}-{year}-{serial}; the local-goods payable moved to LOC-', async () => {
    const made = await raise(world.clerk);
    expect(made.invoiceNo).toMatch(/^PUR-BGW-2026-\d{6}$/);
    const series = (await ownerPool.query(`select key, prefix from doc_sequence where key in ('AP_INVOICE','PAYABLE_LOCAL_GOODS') order by key`)).rows;
    expect(series).toEqual([
      { key: 'AP_INVOICE', prefix: 'PUR' },
      { key: 'PAYABLE_LOCAL_GOODS', prefix: 'LOC' },
    ]);
  });

  it('steps over a number another series already issued, rather than failing on the one register', async () => {
    const first = await raise(world.clerk);
    const serial = Number(first.invoiceNo.slice(-6));
    const taken = `PUR-BGW-2026-${String(serial + 1).padStart(6, '0')}`;
    // As an old local-goods payable numbered PUR- before 0409 would hold it.
    await ownerPool.query(
      `insert into doc_number_allocation (sequence_key, scope_key, serial, document_no) values ('PAYABLE_LOCAL_GOODS','BGW:2026',$1,$2)`,
      [900000 + serial, taken],
    );
    const next = await raise(world.clerk);
    expect(next.invoiceNo).not.toBe(taken);
    expect(next.invoiceNo).toBe(`PUR-BGW-2026-${String(serial + 2).padStart(6, '0')}`);
  });

  it('reads both prefixes as a purchase invoice — Noah, and the global search', () => {
    expect(familyOf('PUR-BGW-2026-000010')?.key).toBe('ap_invoice');
    expect(familyOf('api-hq-2026-000004')?.key).toBe('ap_invoice');
    expect(RETIRED_PREFIXES.AP_INVOICE).toEqual(['API']);
    const catalog = withRetiredPrefixes([
      { key: 'AP_INVOICE', prefix: 'PUR' },
      { key: 'PAYABLE_LOCAL_GOODS', prefix: 'LOC' },
    ]);
    expect(planQuery('API-12', catalog).series.exact).toEqual(['AP_INVOICE']);
    expect([...planQuery('PUR-12', catalog).series.exact].sort()).toEqual(['AP_INVOICE', 'PAYABLE_LOCAL_GOODS']);
    expect(planQuery('LOC-12', catalog).series.exact).toEqual(['PAYABLE_LOCAL_GOODS']);
  });
});

// ---------------------------------------------------------------------------
describe('2 · the supplier invoice / receipt number', () => {
  it('keeps the number typed; empty, our own number stands in', async () => {
    const typed = await raise(world.clerk, { supplierInvoiceNo: '  RCPT-7781 ' });
    const blank = await raise(world.clerk);
    const rows = (await ownerPool.query(`select invoice_no, supplier_invoice_no from ap_invoice where id in ($1,$2)`, [typed.id, blank.id])).rows;
    expect(rows.find((r) => r.invoice_no === typed.invoiceNo)!.supplier_invoice_no).toBe('RCPT-7781');
    expect(rows.find((r) => r.invoice_no === blank.invoiceNo)!.supplier_invoice_no).toBe(blank.invoiceNo);
  });

  it('refuses a number the same supplier already billed under (§15), and lets another supplier use it', async () => {
    await raise(world.clerk, { supplierInvoiceNo: 'INV-DUP-1' });
    const refused = await rejection(raise(world.clerk, { supplierInvoiceNo: 'INV-DUP-1' }));
    expect(refused).toMatch(/Supplier invoice INV-DUP-1 has already been entered as PUR-BGW-2026-\d{6} \(§15\)/);
    await linkItemToSupplier(PANEL, otherSupplierId);
    const other = await raise(world.clerk, { supplierId: otherSupplierId, supplierInvoiceNo: 'INV-DUP-1' });
    expect(other.invoiceNo).toMatch(/^PUR-/);
  });

  it('is corrected on a draft, held to the same rule, audited; cleared, our number again', async () => {
    const draft = await raise(world.clerk);
    await raise(world.clerk, { supplierInvoiceNo: 'TAKEN-9' });
    await expect(as(world.clerk, (tx) => ap.setSupplierInvoiceNo(tx, world.clerk, draft.id, 'TAKEN-9'))).rejects.toThrow(/already been entered/);
    await as(world.clerk, (tx) => ap.setSupplierInvoiceNo(tx, world.clerk, draft.id, 'RCPT-0042'));
    expect((await ownerPool.query(`select supplier_invoice_no from ap_invoice where id = $1`, [draft.id])).rows[0].supplier_invoice_no).toBe('RCPT-0042');
    expect((await actionsOn(draft.id)).map((a) => a.action)).toContain('ap_invoice.supplier_invoice_no_changed');
    await as(world.clerk, (tx) => ap.setSupplierInvoiceNo(tx, world.clerk, draft.id, ''));
    expect((await ownerPool.query(`select supplier_invoice_no from ap_invoice where id = $1`, [draft.id])).rows[0].supplier_invoice_no).toBe(draft.invoiceNo);
  });

  it('is found by the register search', async () => {
    const made = await raise(world.clerk, { supplierInvoiceNo: 'RECEIPT-55501' });
    const { shown } = await as(world.clerk, (tx) => invoiceRegister(tx, { q: 'receipt-555' }, ON));
    expect(shown.map((row) => row.invoiceNo)).toEqual([made.invoiceNo]);
  });
});

// ---------------------------------------------------------------------------
describe('4 · an item is bought only from a supplier linked to it', () => {
  it('refuses a purchase invoice of an item its supplier is not linked to, naming both and the item page', async () => {
    const refused = await rejection(raise(world.clerk, { itemCode: INVERTER }));
    expect(refused).toMatch(/ITM-INVERTER \(Hybrid Inverter 10kW\) is not linked to SUP-JINKO \(Jinko Solar\)/);
    expect(refused).toContain('/inventory/items/ITM-INVERTER');
  });

  it('refuses the same on a draft line typed in place, and on a purchase order', async () => {
    const draft = await raise(world.clerk);
    await expect(
      as(world.clerk, (tx) => ap.saveLine(tx, world.clerk, draft.id, null, { itemCode: INVERTER, quantity: qty('1'), unitPriceIqd: iqd('500'), warehouseCode: WAREHOUSE })),
    ).rejects.toThrow(/ITM-INVERTER \(Hybrid Inverter 10kW\) is not linked to SUP-JINKO/);
    await expect(
      as(world.manager, (tx) =>
        orders.create(tx, world.manager, {
          supplierId: world.supplierId,
          branchCode: BAGHDAD,
          orderDate: ON,
          lines: [{ lineType: 'inventory_item', itemCode: INVERTER, description: 'Inverter', quantity: qty('1'), uomCode: 'EA', unitPriceIqd: iqd('500'), branchCode: BAGHDAD, warehouseCode: WAREHOUSE }],
        }),
      ),
    ).rejects.toThrow(/is not linked to SUP-JINKO/);
  });

  it('buys it once linked; the supplier code is offered on the line; the register names the supplier', async () => {
    await as(world.manager, (tx) => items.linkSupplier(tx, world.manager, INVERTER, { supplierId: world.supplierId, supplierItemCode: 'JK-INV-10', makeDefault: false }));
    const made = await raise(world.clerk, { itemCode: INVERTER, count: '2' });
    expect(made.invoiceNo).toMatch(/^PUR-/);
    const choices = await as(world.clerk, (tx) => items.invoiceChoices(tx, 'purchase'));
    const inverter = choices.find((choice) => choice.code === INVERTER)!;
    expect(inverter.suppliers).toEqual([expect.objectContaining({ id: world.supplierId, itemCode: 'JK-INV-10' })]);
    const listed = (await as(world.clerk, (tx) => items.listAll(tx))).find((row) => row.code === INVERTER)!;
    expect(listed.supplierNames).toBe('SUP-JINKO · Jinko Solar');
    expect(listed.supplierCount).toBe(1);
  });

  it('removes a supplier with its reason — the row stays, out of use, audited — and the purchase is refused again; relinking restores it', async () => {
    await expect(as(world.manager, (tx) => items.unlinkSupplier(tx, world.manager, INVERTER, world.supplierId, '  '))).rejects.toThrow(/reason/);
    await as(world.manager, (tx) => items.unlinkSupplier(tx, world.manager, INVERTER, world.supplierId, 'Jinko stopped making inverters'));
    const link = (await ownerPool.query(
      `select s.active, s.is_default, s.deactivated_reason, s.deactivated_by::text as by from item_supplier s join item i on i.id = s.item_id where i.code = $1 and s.supplier_id = $2`,
      [INVERTER, world.supplierId],
    )).rows[0];
    expect(link).toMatchObject({ active: false, is_default: false, deactivated_reason: 'Jinko stopped making inverters', by: world.manager.principal.userId });
    const audit = (await ownerPool.query(`select reason from audit_event where action = 'item.supplier_unlinked' and object_id = $1`, [INVERTER])).rows;
    expect(audit.map((row) => row.reason)).toContain('Jinko stopped making inverters');
    expect(await rejection(raise(world.clerk, { itemCode: INVERTER }))).toMatch(/is not linked to SUP-JINKO/);
    await as(world.manager, (tx) => items.linkSupplier(tx, world.manager, INVERTER, { supplierId: world.supplierId, makeDefault: false }));
    expect((await raise(world.clerk, { itemCode: INVERTER })).invoiceNo).toMatch(/^PUR-/);
  });

  it('never deletes a link: the application role holds no DELETE on item_supplier, and a link out of use carries a reason', async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query(`delete from item_supplier`)).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
    await expect(
      ownerPool.query(`update item_supplier set active = false, deactivated_reason = null where supplier_id = $1`, [world.supplierId]),
    ).rejects.toThrow(/item_supplier_deactivated_has_reason/);
  });

  it('links the suppliers chosen on the New item form, the first its default', async () => {
    const made = await as(root, (tx) =>
      items.create(
        tx,
        root,
        { name: 'Battery 5kWh', isStock: true, baseUomCode: 'EA', tracking: 'batch', inventoryAccountId: world.accounts.inventory!, cogsAccountId: world.accounts.cogs! },
        { supplierIds: [otherSupplierId, world.supplierId] },
      ),
    );
    const links = (await ownerPool.query(
      `select bp.code, s.is_default, s.active, s.created_by::text as by from item_supplier s join business_partner bp on bp.id = s.supplier_id join item i on i.id = s.item_id where i.code = $1 order by bp.code`,
      [made.code],
    )).rows;
    expect(links).toEqual([
      { code: 'SUP-JINKO', is_default: false, active: true, by: root.principal.userId },
      { code: 'SUP-LONGI', is_default: true, active: true, by: root.principal.userId },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('6 · a super user approves their own draft in one press', () => {
  it('records the submission and the posting, both audited as the super user, in one step', async () => {
    const draft = await raise(root);
    const outcome = await as(root, (tx) => ap.approveDraft(tx, root, draft.id));
    expect(outcome).toEqual({ posted: true, held: false });
    expect(await statusOf(draft.id)).toBe('posted');
    const row = (await ownerPool.query(`select submitted_by::text as s, posted_by::text as p, journal_entry_id from ap_invoice where id = $1`, [draft.id])).rows[0];
    expect(row).toMatchObject({ s: root.principal.userId, p: root.principal.userId });
    expect(row.journal_entry_id).not.toBeNull();
    const audited = (await actionsOn(draft.id)).filter((a) => ['ap_invoice.submitted', 'ap_invoice.posted'].includes(a.action));
    expect(audited).toEqual([
      { action: 'ap_invoice.submitted', actor: root.principal.userId },
      { action: 'ap_invoice.posted', actor: root.principal.userId },
    ]);
    // A second press finds it posted, and posts nothing twice.
    expect(await rejection(as(root, (tx) => ap.approveDraft(tx, root, draft.id)))).toMatch(/only a draft is approved in one step/);
  });

  it('is a super user\'s own draft alone: a clerk keeps Send for approval, and a super user does not skip somebody else\'s', async () => {
    const mine = await raise(world.clerk);
    expect(await rejection(as(world.clerk, (tx) => ap.approveDraft(tx, world.clerk, mine.id)))).toMatch(/only a super user approves their own draft/);
    expect(await rejection(as(world.manager, (tx) => ap.approveDraft(tx, world.manager, mine.id)))).toMatch(/only a super user/);
    expect(await rejection(as(root, (tx) => ap.approveDraft(tx, root, mine.id)))).toMatch(/raised by somebody else/);
    expect(await statusOf(mine.id)).toBe('draft');
    // The ordinary road is untouched.
    await as(world.clerk, (tx) => ap.submit(tx, world.clerk, mine.id));
    await as(world.manager, (tx) => ap.post(tx, world.manager, mine.id));
    expect(await statusOf(mine.id)).toBe('posted');
  });

  it('stops at Submitted while a rule reviews submitted invoices, and the review still holds the posting', async () => {
    const rule = await as(world.manager, (tx) =>
      automation.createFromTemplate(tx, world.manager, {
        templateCode: 'invoice_over_threshold',
        name: 'Every invoice reviewed',
        params: { thresholdIqd: '1', notifyRole: 'accounting_manager', note: 'Review' },
      }),
    );
    await as(world.manager, (tx) => automation.enable(tx, world.manager, rule.ruleNo));
    try {
      const draft = await raise(root);
      expect(await as(root, (tx) => ap.approveDraft(tx, root, draft.id))).toEqual({ posted: false, held: true });
      expect(await statusOf(draft.id)).toBe('submitted');
      await runOnce();
      const open = (await ownerPool.query(`select count(*)::int as n from workflow_instance where document_type_code = 'ap_invoice' and document_id = $1 and not is_complete`, [draft.id])).rows[0].n;
      expect(open).toBe(1);
      expect(await rejection(as(root, (tx) => ap.post(tx, root, draft.id)))).toMatch(/waiting for the review/);
    } finally {
      await ownerPool.query(`update automation_rule set enabled = false where rule_no = $1`, [rule.ruleNo]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('3 · the balance of each account the invoice names, from the ledger', () => {
  it('reads the payable and the inventory account as the trial balance counts them, signed debit less credit', async () => {
    const payableBefore = await as(world.manager, (tx) => trialBalance.accountBalance(tx, world.accounts.supplier_payable!));
    const stockBefore = await as(world.manager, (tx) => trialBalance.accountBalance(tx, world.accounts.inventory!));
    const draft = await raise(root, { count: '7' });
    await as(root, (tx) => ap.approveDraft(tx, root, draft.id));
    const payable = await as(world.manager, (tx) => trialBalance.accountBalance(tx, world.accounts.supplier_payable!));
    const stock = await as(world.manager, (tx) => trialBalance.accountBalance(tx, world.accounts.inventory!));
    expect(payable).toMatchObject({ code: expect.stringMatching(/^L9/), name: 'Trade Payables', currency: 'IQD', balanceTxn: null });
    expect(iqd(payable!.balanceIqd) - iqd(payableBefore!.balanceIqd)).toBe(-iqd('7000'));
    expect(iqd(stock!.balanceIqd) - iqd(stockBefore!.balanceIqd)).toBe(iqd('7000'));
    // The payable account carries every posted invoice of the file: a credit balance.
    expect(iqd(payable!.balanceIqd) < 0n).toBe(true);
  });

  it('finds the G/L account a bank or cash account is kept on, and answers nothing for a group or an unknown id', async () => {
    expect(await as(world.manager, (tx) => trialBalance.glAccountOfBankCash(tx, world.bankAccountId))).toBe(world.accounts.bank);
    const group = (await ownerPool.query(`select id from chart_of_account where code = 'L000001'`)).rows[0].id as string;
    expect(await as(world.manager, (tx) => trialBalance.accountBalance(tx, group))).toBeNull();
    expect(await as(world.manager, (tx) => trialBalance.accountBalance(tx, randomUUID()))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('1 · the advance\'s figure is the Payable amount', () => {
  it('is called Payable amount in both languages', () => {
    const en = JSON.parse(readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8'));
    const arabic = JSON.parse(readFileSync(join(process.cwd(), 'messages/ar.json'), 'utf8'));
    expect(en.admin.expenses.payable_amount).toBe('Payable amount');
    expect(arabic.admin.expenses.payable_amount).toBe('المبلغ المستحق الدفع');
    expect(en.admin.expenses.supplier_receipt_no).toBe('Supplier invoice / receipt no.');
    // One selection, three choices; no share preset in the words either.
    expect([en.admin.expenses.advance_basis_none, en.admin.expenses.advance_basis_percent, en.admin.expenses.advance_basis_amount]).toEqual([
      'No upfront payment',
      'Payable by percentage',
      'Payable by amount',
    ]);
    expect(en.admin.expenses.advance_hint).not.toMatch(/20/);
    expect(arabic.admin.expenses.advance_hint).not.toMatch(/20/);
  });

  it('prints how it was agreed, the payable amount it comes to and what is left — by percentage and by amount — and the supplier\'s number', async () => {
    const take = async (invoiceNo: string) => {
      const built = await as(world.manager, (tx) =>
        documents.purchaseInvoice({ tx, principal: world.manager.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, invoiceNo),
      );
      return Object.fromEntries(built!.model.fields.map((field) => [field.label, field.value]));
    };
    const byShare = await raise(world.clerk, { count: '10', advanceBasis: 'percent', advancePercent: '20', supplierInvoiceNo: 'RCPT-PRINT-1' });
    const share = await take(byShare.invoiceNo);
    expect(share['Payable in advance']).toBe('Payable by percentage · 20%');
    // 20% of 10 × 1,000 IQD, and the rest.
    expect(share['Payable amount']).toBe('2,000 IQD');
    expect(share['Left to pay']).toBe('8,000 IQD');
    expect(share['Supplier invoice / receipt no.']).toBe('RCPT-PRINT-1');

    const byAmount = await raise(world.clerk, { count: '10', advanceBasis: 'amount', advanceAmount: '2500' });
    const amount = await take(byAmount.invoiceNo);
    expect(amount['Payable in advance']).toBe('Payable by amount · That is 25% of the total');
    expect(amount['Payable amount']).toBe('2,500 IQD');
    expect(amount['Left to pay']).toBe('7,500 IQD');
  });
});

// ---------------------------------------------------------------------------
describe('7 · the register\'s Import application filter', () => {
  const rows = [
    { invoiceNo: 'PUR-1', totalIqd: '10', isImport: true, expenseCategoryCode: null, payableNo: 'IMP-BGW-2026-000001', state: 'unpaid' },
    { invoiceNo: 'PUR-2', totalIqd: '10', isImport: false, expenseCategoryCode: null, payableNo: null, state: 'unpaid' },
  ];
  it('keeps the invoices linked to an import application, or the ones that are not', () => {
    expect(filterInvoiceRegister(rows, { importLink: 'linked' }).map((r) => r.invoiceNo)).toEqual(['PUR-1']);
    expect(filterInvoiceRegister(rows, { importLink: 'unlinked' }).map((r) => r.invoiceNo)).toEqual(['PUR-2']);
    expect(filterInvoiceRegister(rows, { importLink: '' }).map((r) => r.invoiceNo)).toEqual(['PUR-1', 'PUR-2']);
  });

  it('reads the real register: an invoice with no import application is Not linked', async () => {
    const made = await raise(world.clerk, { supplierInvoiceNo: 'UNLINKED-1' });
    const unlinked = await as(world.clerk, (tx) => invoiceRegister(tx, { importLink: 'unlinked' }, ON));
    const linked = await as(world.clerk, (tx) => invoiceRegister(tx, { importLink: 'linked' }, ON));
    expect(unlinked.shown.map((row) => row.invoiceNo)).toContain(made.invoiceNo);
    expect(linked.shown.map((row) => row.invoiceNo)).not.toContain(made.invoiceNo);
  });
});

// ---------------------------------------------------------------------------
describe('5 · a customer is created without payment terms', () => {
  it('is entered with none, and its sales invoice falls due on its own date', async () => {
    const made = await as(world.manager, (tx) => partners.createInRole(tx, world.manager, 'customer', { legalName: `Basra Retail ${randomUUID().slice(0, 6)}` }));
    const row = (await ownerPool.query(`select id, payment_terms_code from business_partner where code = $1`, [made.code])).rows[0];
    expect(row.payment_terms_code).toBeNull();
    const sale = await as(world.manager, (tx) =>
      ar.createDirect(tx, world.manager, {
        customerId: row.id,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        lines: [{ itemCode: PANEL, quantity: qty('1'), unitPriceIqd: iqd('1500'), warehouseCode: WAREHOUSE }],
      }),
    );
    const due = (await ownerPool.query(`select due_date::text as d from ar_invoice where id = $1`, [sale.id])).rows[0].d;
    expect(due).toBe(ON);
  });
});
