/**
 * Phase 05 exit gate — the §26 critical UAT scenario, end to end.
 *
 * > *"External supplier Excel → Purchase Order → partial receipt → Three-Way
 * > Match → A/P Invoice → payment → bank reconciliation → G/L"*
 *
 * §27's Release 4 acceptance is *"source documents, supplier ledger and G/L
 * reconcile"*, and that is a claim about the **chain**, not about the links.
 * Every sub-phase has its own gate; each proves one document behaves. None of
 * them proves that a pallet of cable can be ordered from a spreadsheet, arrive
 * in two deliveries, be invoiced, matched, paid, and leave the ledger balanced
 * with nothing stranded in a clearing account.
 *
 * That is what this file does: one purchase, followed all the way through, with
 * the books checked at every step.
 *
 * The bank-reconciliation leg is Phase 07 (§17) and is not run here — the phase
 * plan says to complete it during that phase.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as ap from '@/server/services/ap-invoice';
import * as pay from '@/server/services/supplier-payment';
import * as inventory from '@/server/services/inventory';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';
import { valuation } from '@domain/fifo';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const CONDUIT = 'ITM-CONDUIT';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let buyer: ActorContext;
let warehouse: ActorContext;
let finance: ActorContext;
let supplierId: string;
let bankAccountId: string;
let accounts: Record<string, string>;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  // 'accounting_manager+ceo' is a manager who also holds the CEO's invoice
  // approval (Operations build, blocks 4 and 5).
  for (const code of role.split('+')) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, code]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

/** Every posting role Phase 05 touches, mapped by role (§3.3). */
const ROLES = [
  ['inventory', 'A000001', 'Inventory'],
  ['bank', 'A000001', 'Bank'],
  ['grni', 'L000001', 'Goods Received Not Invoiced'],
  ['supplier_payable', 'L000001', 'Trade Payables'],
  ['purchase_variance', 'X000001', 'Purchase Price Variance'],
] as const;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  for (const code of [CABLE, CONDUIT]) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ($1,$2,true,'EA','batch') returning id`,
        [code, code === CABLE ? 'Network Cable 2m' : 'Conduit 20mm'],
      );
      await client.query(
        `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
         values ($1,'EA',1,1)`,
        [rows[0].id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  buyer = await createUser('accounting_officer');
  warehouse = await createUser('accounting_manager+ceo');
  finance = await createUser('accounting_manager+ceo');

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-BAGHDAD','Baghdad Electrical Supplies', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  const { rows: bank } = await ownerPool.query(
    `select id from bank_cash_account where branch_code = $1 limit 1`,
    [BAGHDAD],
  );
  bankAccountId = bank[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,2,'February 2026','2026-02-01','2026-02-28'),
            ($1,3,'March 2026','2026-03-01','2026-03-31')
     on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [finance.principal.userId],
  );

  accounts = {};
  for (const [role, parent, name] of ROLES) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [
        `${parent.slice(0, 1)}9${String(role.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        role === 'supplier_payable' ? 'supplier' : null,
      ],
    );
    accounts[role] = rows[0].id;

    for (const event of [
      'inventory.goods_receipt',
      'purchasing.ap_invoice',
      'purchasing.supplier_payment',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, finance.principal.userId],
      );
    }
  }

  for (const documentType of ['ap_invoice', 'supplier_payment']) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
      [documentType],
    );
  }

  await withScope({ userId: finance.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.setRequiredDimensions(tx, finance, accounts.purchase_variance!, []),
  );
});

/** Total debits less credits on one account, in whole IQD. */
async function balanceOf(role: string): Promise<number> {
  const { rows } = await ownerPool.query(
    `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0) as balance
       from journal_line where account_id = $1`,
    [accounts[role]],
  );
  return Number(rows[0].balance);
}

/** §17 — the G/L balance of the bank account the payment actually came from. */
async function payingAccountBalance(): Promise<number> {
  const { rows } = await ownerPool.query(
    `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0) as balance
       from journal_line l
       join bank_cash_account b on b.gl_account_id = l.account_id
      where b.id = $1`,
    [bankAccountId],
  );
  return Number(rows[0].balance);
}

// ---------------------------------------------------------------------------

describe('Phase 05 exit gate · the §26 scenario, end to end', () => {
  it('carries one purchase from a supplier spreadsheet to a settled ledger', async () => {
    // ── 1 · The supplier's Excel ────────────────────────────────────────────
    //
    // §8.2: quotations are collected outside the ERP and the buyer pastes the
    // approved lines in. Two items, tab-separated, exactly as a spreadsheet
    // gives them.
    // Columns, in the order the grid pastes them: item code, description,
    // quantity, unit of measure, unit price.
    const pasted = po.parsePastedLines(
      [
        `${CABLE}\tNetwork Cable 2m\t100\tEA\t10.0000`,
        `${CONDUIT}\tConduit 20mm\t50\tEA\t25.0000`,
      ].join('\n'),
      { branchCode: BAGHDAD, warehouseCode: `WH-${BAGHDAD}` },
    );

    expect(pasted.errors).toEqual([]);
    expect(pasted.lines).toHaveLength(2);

    const validated = await withScope(scope(buyer), (tx) =>
      po.validateLines(tx, pasted.lines),
    );
    expect(validated).toEqual([]);

    // ── 2 · The Purchase Order ─────────────────────────────────────────────
    const order = await withScope(scope(buyer), (tx) =>
      po.create(tx, buyer, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: pasted.lines,
      }),
    );
    await withScope(scope(buyer), (tx) => po.submit(tx, buyer, order.id));
    await withScope(scope(warehouse), (tx) => po.approve(tx, warehouse, order.id));

    // Appendix B — an approved order is a commitment and nothing more. Not one
    // dinar has moved.
    expect(await balanceOf('inventory')).toBe(0);
    expect(await balanceOf('grni')).toBe(0);
    expect(await balanceOf('supplier_payable')).toBe(0);

    const { rows: poLines } = await ownerPool.query(
      `select id, item_code from purchase_order_line where purchase_order_id = $1 order by line_no`,
      [order.id],
    );
    const cableLine = poLines.find((r) => r.item_code === CABLE)!.id as string;
    const conduitLine = poLines.find((r) => r.item_code === CONDUIT)!.id as string;

    // ── 3 · A partial delivery ─────────────────────────────────────────────
    //
    // 40 of the 100 cables and all 50 conduits. §8.4's ordinary case.
    const firstReceipt = await withScope(scope(buyer), (tx) =>
      gr.create(tx, buyer, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        supplierDeliveryNote: 'DN-88213',
        lines: [
          { purchaseOrderLineId: cableLine, quantity: qty('40'), batchNumber: 'CB-2026-02' },
          { purchaseOrderLineId: conduitLine, quantity: qty('50'), batchNumber: 'CD-2026-02' },
        ],
      }),
    );
    await withScope(scope(buyer), (tx) => gr.submit(tx, buyer, firstReceipt.id));
    const firstPosted = await withScope(scope(warehouse), (tx) =>
      gr.post(tx, warehouse, firstReceipt.id),
    );

    // Appendix C — Dr Inventory / Cr GRNI, at the ordered price:
    // 40 × 10 + 50 × 25 = 1,650.
    expect(await balanceOf('inventory')).toBe(1650);
    expect(await balanceOf('grni')).toBe(-1650);
    expect(firstPosted.orderStatus).toBe('partially_executed');

    // The stock is there, and the FIFO layers say what it cost.
    const layers = await withScope(scope(warehouse), (tx) =>
      inventory.layersOf(tx, CABLE, `WH-${BAGHDAD}`),
    );
    expect(valuation(layers)).toBe(price('400'));

    // ── 4 · The supplier's invoice for what arrived ─────────────────────────
    const invoice = await withScope(scope(finance), (tx) =>
      ap.create(tx, finance, {
        supplierId,
        supplierInvoiceNo: 'BES-2026-4471',
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        invoiceDate: '2026-02-10',
        dueDate: '2026-03-12',
        lines: [
          { purchaseOrderLineId: cableLine, quantity: qty('40'), unitPriceIqd: price('10') },
          { purchaseOrderLineId: conduitLine, quantity: qty('50'), unitPriceIqd: price('25') },
        ],
      }),
    );

    // ── 5 · Three-way match ────────────────────────────────────────────────
    //
    // Order, delivery and invoice all say the same thing, so there is nothing
    // for a manager to decide.
    expect(invoice.matchStatus).toBe('matched');
    expect(await withScope(scope(finance), (tx) => ap.exceptionQueue(tx))).toHaveLength(0);

    await withScope(scope(finance), (tx) => ap.submit(tx, finance, invoice.id));
    await withScope(scope(warehouse), (tx) => ap.post(tx, warehouse, invoice.id));

    // GRNI is cleared exactly, because receipt and invoice both used the
    // ordered price. Inventory is untouched — the invoice does not revalue
    // stock (§9.2).
    expect(await balanceOf('grni')).toBe(0);
    expect(await balanceOf('inventory')).toBe(1650);
    expect(await balanceOf('supplier_payable')).toBe(-1650);
    expect(await balanceOf('purchase_variance')).toBe(0);

    // The supplier ledger moved with the control account, in one transaction.
    const { rows: sub } = await ownerPool.query(
      `select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) as balance, party_code
         from subledger_entry where control_account_id = $1 group by party_code`,
      [accounts.supplier_payable],
    );
    expect(sub).toHaveLength(1);
    expect(sub[0].party_code).toBe('SUP-BAGHDAD');
    expect(Number(sub[0].balance)).toBe(1650);

    // ── 6 · The invoice appears in the ageing and the payment proposal ──────
    const ageing = await withScope(scope(finance), (tx) => pay.ageing(tx, '2026-03-20'));
    expect(ageing).toHaveLength(1);
    expect(ageing[0]!.bucket).toBe('1-30');
    expect(ageing[0]!.supplierCode).toBe('SUP-BAGHDAD');

    const proposal = await withScope(scope(finance), (tx) =>
      pay.paymentProposal(tx, '2026-03-20'),
    );
    expect(proposal.eligible).toHaveLength(1);
    expect(proposal.eligibleTotalIqd).toBe(price('1650'));
    expect(proposal.blocked).toHaveLength(0);

    // ── 7 · Payment ────────────────────────────────────────────────────────
    const payment = await withScope(scope(finance), (tx) =>
      pay.create(tx, finance, {
        supplierId,
        bankCashAccountId: bankAccountId,
        branchCode: BAGHDAD,
        paymentDate: '2026-03-15',
        amountIqd: price('1650'),
        reference: 'TRF-990214',
      }),
    );
    await withScope(scope(warehouse), (tx) => pay.post(tx, warehouse, payment.id));
    await withScope(scope(warehouse), (tx) =>
      pay.allocate(tx, warehouse, {
        supplierPaymentId: payment.id,
        apInvoiceId: invoice.id,
        amountIqd: price('1650'),
      }),
    );

    // ── 8 · The books ──────────────────────────────────────────────────────
    //
    // §27 Release 4: "source documents, supplier ledger and G/L reconcile."
    expect(await balanceOf('supplier_payable')).toBe(0);
    // The money left the account the payment named, so that is where the credit
    // is — not the `bank` mapping, which a payment from a second account would
    // credit just as wrongly (§17).
    expect(await payingAccountBalance()).toBe(-1650);
    expect(await balanceOf('inventory')).toBe(1650);
    expect(await balanceOf('grni')).toBe(0);

    // Nothing left owing, and nothing left in the ageing.
    expect(await withScope(scope(finance), (tx) => pay.ageing(tx, '2026-03-20'))).toHaveLength(0);

    // The supplier ledger agrees with its control account, still.
    const { rows: after } = await ownerPool.query(
      `select
         (select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) from journal_line where account_id = $1) as gl,
         (select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) from subledger_entry where control_account_id = $1) as sub`,
      [accounts.supplier_payable],
    );
    expect(Number(after[0].gl)).toBe(0);
    expect(Number(after[0].sub)).toBe(0);

    // Every journal this scenario wrote balances, in every currency (§14.8).
    const { rows: unbalanced } = await ownerPool.query(
      `select journal_entry_id
         from journal_line
        group by journal_entry_id
       having sum(debit_iqd) <> sum(credit_iqd)`,
    );
    expect(unbalanced).toEqual([]);

    // And the stock still ties to the layers that carry its cost (§9.9).
    const cable = await withScope(scope(warehouse), (tx) =>
      inventory.layersOf(tx, CABLE, `WH-${BAGHDAD}`),
    );
    const conduit = await withScope(scope(warehouse), (tx) =>
      inventory.layersOf(tx, CONDUIT, `WH-${BAGHDAD}`),
    );
    expect(valuation(cable) + valuation(conduit)).toBe(price('1650'));

    // ── 9 · What is still open ─────────────────────────────────────────────
    //
    // Sixty cables never arrived. The order says so, and nothing about the
    // money pretends otherwise.
    const open = await withScope(scope(buyer), (tx) => gr.outstanding(tx, order.id));
    const cableOutstanding = open.find((line) => line.itemCode === CABLE)!;
    expect(cableOutstanding.outstanding).toBe(qty('60'));
    expect(cableOutstanding.received).toBe(qty('40'));
  });

  it('keeps a blocked supplier out of the proposal without hiding them', async () => {
    // The same purchase, invoiced and due — then the supplier is blocked.
    const order = await withScope(scope(buyer), (tx) =>
      po.create(tx, buyer, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [
          {
            lineType: 'inventory_item',
            itemCode: CABLE,
            description: 'Network Cable 2m',
            quantity: qty('10'),
            uomCode: 'EA',
            unitPriceIqd: price('10'),
            branchCode: BAGHDAD,
            warehouseCode: `WH-${BAGHDAD}`,
          },
        ],
      }),
    );
    await withScope(scope(buyer), (tx) => po.submit(tx, buyer, order.id));
    await withScope(scope(warehouse), (tx) => po.approve(tx, warehouse, order.id));

    const { rows: poLines } = await ownerPool.query(
      `select id from purchase_order_line where purchase_order_id = $1`,
      [order.id],
    );

    const receipt = await withScope(scope(buyer), (tx) =>
      gr.create(tx, buyer, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        lines: [
          { purchaseOrderLineId: poLines[0].id, quantity: qty('10'), batchNumber: 'CB-X' },
        ],
      }),
    );
    await withScope(scope(buyer), (tx) => gr.submit(tx, buyer, receipt.id));
    await withScope(scope(warehouse), (tx) => gr.post(tx, warehouse, receipt.id));

    const invoice = await withScope(scope(finance), (tx) =>
      ap.create(tx, finance, {
        supplierId,
        supplierInvoiceNo: 'BES-BLOCKED',
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        invoiceDate: '2026-02-10',
        dueDate: '2026-03-01',
        lines: [
          { purchaseOrderLineId: poLines[0].id, quantity: qty('10'), unitPriceIqd: price('10') },
        ],
      }),
    );
    await withScope(scope(finance), (tx) => ap.submit(tx, finance, invoice.id));
    await withScope(scope(warehouse), (tx) => ap.post(tx, warehouse, invoice.id));

    await ownerPool.query(`update business_partner set status = 'blocked' where id = $1`, [
      supplierId,
    ]);

    const proposal = await withScope(scope(finance), (tx) =>
      pay.paymentProposal(tx, '2026-03-20'),
    );

    // §15 — not eligible, and not invisible either. A proposal that silently
    // dropped them would leave Finance wondering why a supplier they expected
    // to pay was missing, and "somebody blocked them" is the most useful thing
    // on the report.
    expect(proposal.eligible).toHaveLength(0);
    expect(proposal.blocked).toHaveLength(1);
    expect(proposal.blocked[0]!.supplierStatus).toBe('blocked');
    expect(proposal.blockedTotalIqd).toBe(price('100'));
  });

  it('leaves nothing due out of the proposal that is not yet due', async () => {
    const order = await withScope(scope(buyer), (tx) =>
      po.create(tx, buyer, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [
          {
            lineType: 'inventory_item',
            itemCode: CABLE,
            description: 'Network Cable 2m',
            quantity: qty('10'),
            uomCode: 'EA',
            unitPriceIqd: price('10'),
            branchCode: BAGHDAD,
            warehouseCode: `WH-${BAGHDAD}`,
          },
        ],
      }),
    );
    await withScope(scope(buyer), (tx) => po.submit(tx, buyer, order.id));
    await withScope(scope(warehouse), (tx) => po.approve(tx, warehouse, order.id));

    const { rows: poLines } = await ownerPool.query(
      `select id from purchase_order_line where purchase_order_id = $1`,
      [order.id],
    );
    const receipt = await withScope(scope(buyer), (tx) =>
      gr.create(tx, buyer, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        lines: [
          { purchaseOrderLineId: poLines[0].id, quantity: qty('10'), batchNumber: 'CB-Y' },
        ],
      }),
    );
    await withScope(scope(buyer), (tx) => gr.submit(tx, buyer, receipt.id));
    await withScope(scope(warehouse), (tx) => gr.post(tx, warehouse, receipt.id));

    const invoice = await withScope(scope(finance), (tx) =>
      ap.create(tx, finance, {
        supplierId,
        supplierInvoiceNo: 'BES-FUTURE',
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        invoiceDate: '2026-02-10',
        dueDate: '2026-03-25',
        lines: [
          { purchaseOrderLineId: poLines[0].id, quantity: qty('10'), unitPriceIqd: price('10') },
        ],
      }),
    );
    await withScope(scope(finance), (tx) => ap.submit(tx, finance, invoice.id));
    await withScope(scope(warehouse), (tx) => ap.post(tx, warehouse, invoice.id));

    // Due on the 25th, proposed on the 20th. Paying early is a decision, not a
    // default — and it is still in the ageing, as `current`.
    const proposal = await withScope(scope(finance), (tx) =>
      pay.paymentProposal(tx, '2026-03-20'),
    );
    expect(proposal.eligible).toHaveLength(0);
    expect(proposal.blocked).toHaveLength(0);

    const ageing = await withScope(scope(finance), (tx) => pay.ageing(tx, '2026-03-20'));
    expect(ageing).toHaveLength(1);
    expect(ageing[0]!.bucket).toBe('current');
  });
});
