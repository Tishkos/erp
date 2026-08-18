/**
 * Phase 07.2 and 07.3 test gates — payment proposal, payment batch and
 * maker-checker. §15 and §17.
 *
 * 07.2
 *   - The proposal excludes unapproved, blocked-supplier and already-paid items
 *   - Proposal totals never exceed available cash for the selected account
 *   - Execution confirmation updates every source invoice and advance in one
 *     transaction
 *   - A failed or returned payment reverts the source items to open and is
 *     reported
 *
 * 07.3
 *   - The same user cannot create and approve a high-risk payment
 *   - The same user cannot approve and execute a high-risk payment
 *   - A payment to an unverified beneficiary bank account is blocked
 *   - A bank detail changed after approval but before execution re-triggers
 *     verification
 *   - Every maker-checker step is in the audit trail with actor and timestamp
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as ap from '@/server/services/ap-invoice';
import * as adv from '@/server/services/supplier-advance';
import * as run from '@/server/services/payment-run';
import * as treasury from '@/server/services/treasury';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

/** Maker, checker and executor — §17 wants three different people. */
let maker: ActorContext;
let checker: ActorContext;
let executor: ActorContext;

let supplierId: string;
let blockedSupplierId: string;
let bankAccountId: string;
let bankGlCode: string;
let accounts: Record<string, string>;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
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

/** Approved, active beneficiary details — §17's precondition for paying at all. */
async function approveBankDetails(partnerId: string, accountNumber = 'IQ00-1111') {
  const { rows } = await ownerPool.query(
    `insert into partner_bank_account
       (partner_id, bank_name, account_number, currency, approval_status, is_active,
        created_by, approved_by, approved_at)
     values ($1,'Rafidain Bank',$2,'IQD','approved',true,$3,$4,now()) returning id`,
    [partnerId, accountNumber, maker.principal.userId, checker.principal.userId],
  );
  return rows[0].id as string;
}

/**
 * Money in the paying account's G/L account, so a run has something to spend.
 *
 * One transaction: §02's balance check is DEFERRED to COMMIT, and a header
 * committed on its own is a journal with no lines.
 */
async function fund(amount: string, on = '2026-02-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: gl } = await client.query(`select id from chart_of_account where code = $1`, [
      bankGlCode,
    ]);
    const { rows: suspense } = await client.query(
      `select id from chart_of_account where code = 'L9SUSPEN'`,
    );
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Opening funds','draft',$5,$5,$6) returning id`,
      [
        `FUND-${(seq += 1)}`,
        on,
        periods[0].id,
        BAGHDAD,
        amount,
        checker.principal.userId,
      ],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, gl[0].id, amount, suspense[0].id, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, checker.principal.userId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Network Cable 2m',true,'EA','batch') returning id`,
      [CABLE],
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

  // §17's three hands. The executor is a second manager rather than an officer
  // because executing a batch *posts* the payments it contains, and Phase 05
  // made posting a supplier payment a manager's act. §17 asks for three
  // different people, not three different roles.
  maker = await createUser('accounting_officer');
  checker = await createUser('accounting_manager');
  executor = await createUser('accounting_manager');

  const { rows: partners } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','Supplier One',   true, 'active',  true),
            ('SUP-002','Supplier Two',   true, 'blocked', true)
     returning id, code`,
  );
  supplierId = partners.find((r) => r.code === 'SUP-001')!.id;
  blockedSupplierId = partners.find((r) => r.code === 'SUP-002')!.id;

  const { rows: bank } = await ownerPool.query(
    `select b.id, a.code as gl_code
       from bank_cash_account b
       join chart_of_account a on a.id = b.gl_account_id
      where b.branch_code = $1 limit 1`,
    [BAGHDAD],
  );
  bankAccountId = bank[0].id;
  bankGlCode = bank[0].gl_code;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,1,'January 2026','2026-01-01','2026-01-31'),
            ($1,2,'February 2026','2026-02-01','2026-02-28'),
            ($1,3,'March 2026','2026-03-01','2026-03-31'),
            ($1,4,'April 2026','2026-04-01','2026-04-30')
     on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [checker.principal.userId],
  );

  accounts = {};
  for (const [role, parent, name, control] of [
    ['inventory', 'A000001', 'Inventory', null],
    ['supplier_advance', 'A000001', 'Supplier Advances', null],
    ['bank', 'A000001', 'Bank Mapping Fallback', null],
    ['grni', 'L000001', 'Goods Received Not Invoiced', null],
    ['supplier_payable', 'L000001', 'Trade Payables', 'supplier'],
    ['return_clearing', 'L000001', 'Return Clearing', null],
    ['suspense', 'L000001', 'Funding Suspense', null],
    ['expense', 'X000001', 'Service and Expense Cost', null],
    ['purchase_variance', 'X000001', 'Purchase Price Variance', null],
  ] as const) {
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
        role === 'suspense' ? 'L9SUSPEN' : `${parent.slice(0, 1)}9${String(role.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        control,
      ],
    );
    accounts[role] = rows[0].id;

    for (const event of [
      'inventory.goods_receipt',
      'purchasing.ap_invoice',
      'purchasing.supplier_advance_payment',
      'purchasing.supplier_advance_settlement',
      'purchasing.supplier_payment',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, checker.principal.userId],
      );
    }
  }

  for (const documentType of ['ap_invoice', 'supplier_advance', 'supplier_payment']) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
      [documentType],
    );
  }

  await withScope(scope(checker), (tx) =>
    coa.setRequiredDimensions(tx, checker, accounts.purchase_variance!, []),
  );

  await approveBankDetails(supplierId);
});

/** An order, received and invoiced — a real open payable. */
async function openInvoice(
  options: { quantity?: string; dueDate?: string; supplier?: string } = {},
) {
  const quantity = qty(options.quantity ?? '100');
  const who = options.supplier ?? supplierId;

  const order = await withScope(scope(maker), (tx) =>
    po.create(tx, maker, {
      supplierId: who,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines: [
        {
          lineType: 'inventory_item',
          itemCode: CABLE,
          description: 'Network Cable 2m',
          quantity,
          uomCode: 'EA',
          unitPriceIqd: price('10'),
          branchCode: BAGHDAD,
          warehouseCode: `WH-${BAGHDAD}`,
        },
      ],
    }),
  );
  await withScope(scope(maker), (tx) => po.submit(tx, maker, order.id));
  await withScope(scope(checker), (tx) => po.approve(tx, checker, order.id));

  const { rows: poLines } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1`,
    [order.id],
  );

  const receipt = await withScope(scope(maker), (tx) =>
    gr.create(tx, maker, {
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLines[0].id, quantity, batchNumber: `B-${(seq += 1)}` }],
    }),
  );
  await withScope(scope(maker), (tx) => gr.submit(tx, maker, receipt.id));
  await withScope(scope(checker), (tx) => gr.post(tx, checker, receipt.id));

  const invoice = await withScope(scope(maker), (tx) =>
    ap.create(tx, maker, {
      supplierId: who,
      supplierInvoiceNo: `SUP-INV-${(seq += 1)}`,
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      invoiceDate: '2026-02-10',
      dueDate: options.dueDate ?? '2026-02-20',
      lines: [{ purchaseOrderLineId: poLines[0].id, quantity, unitPriceIqd: price('10') }],
    }),
  );
  await withScope(scope(maker), (tx) => ap.submit(tx, maker, invoice.id));
  await withScope(scope(checker), (tx) => ap.post(tx, checker, invoice.id));

  return { ...invoice, orderId: order.id, poLineId: poLines[0].id as string };
}

/** A draft A/P invoice — approved by nobody, so no debt exists yet. */
async function unapprovedInvoice() {
  const quantity = qty('10');
  const order = await withScope(scope(maker), (tx) =>
    po.create(tx, maker, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines: [
        {
          lineType: 'inventory_item',
          itemCode: CABLE,
          description: 'Network Cable 2m',
          quantity,
          uomCode: 'EA',
          unitPriceIqd: price('10'),
          branchCode: BAGHDAD,
          warehouseCode: `WH-${BAGHDAD}`,
        },
      ],
    }),
  );
  await withScope(scope(maker), (tx) => po.submit(tx, maker, order.id));
  await withScope(scope(checker), (tx) => po.approve(tx, checker, order.id));

  const { rows: poLines } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1`,
    [order.id],
  );
  const receipt = await withScope(scope(maker), (tx) =>
    gr.create(tx, maker, {
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLines[0].id, quantity, batchNumber: `B-${(seq += 1)}` }],
    }),
  );
  await withScope(scope(maker), (tx) => gr.submit(tx, maker, receipt.id));
  await withScope(scope(checker), (tx) => gr.post(tx, checker, receipt.id));

  return withScope(scope(maker), (tx) =>
    ap.create(tx, maker, {
      supplierId,
      supplierInvoiceNo: `SUP-DRAFT-${(seq += 1)}`,
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      invoiceDate: '2026-02-10',
      dueDate: '2026-02-20',
      lines: [{ purchaseOrderLineId: poLines[0].id, quantity, unitPriceIqd: price('10') }],
    }),
  );
}

async function proposal(cashCeilingIqd?: bigint) {
  return withScope(scope(maker), (tx) =>
    run.buildProposal(tx, maker, {
      branchCode: BAGHDAD,
      bankCashAccountId: bankAccountId,
      proposalDate: '2026-02-25',
      payDate: '2026-02-25',
      ...(cashCeilingIqd === undefined ? {} : { cashCeilingIqd }),
    }),
  );
}

/** Proposal → approved → batch, ready for the maker-checker tests. */
async function batchReadyToApprove(cashCeilingIqd?: bigint) {
  const built = await proposal(cashCeilingIqd);
  await withScope(scope(checker), (tx) => run.approveProposal(tx, checker, built.id));
  const batch = await withScope(scope(maker), (tx) =>
    run.createBatch(tx, maker, { proposalId: built.id, paymentDate: '2026-02-25' }),
  );
  return { built, batch };
}

// ---------------------------------------------------------------------------
// 07.2 · the proposal
// ---------------------------------------------------------------------------

describe('07.2 gate · the proposal includes only eligible approved items (§15)', () => {
  it('includes a posted, due invoice from an active supplier', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '100' });

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    expect(view.selected.map((row) => row.reference)).toContain(invoice.invoiceNo);
  });

  it('excludes an unapproved invoice, and says it is not a debt yet', async () => {
    await fund('100000');
    const draft = await unapprovedInvoice();

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    const row = view.excluded.find((one) => one.reference === draft.invoiceNo);
    expect(row?.inclusion).toBe('excluded_unapproved');
    expect(row?.reason).toMatch(/not a debt until it is approved and posted/);
  });

  it('excludes a blocked supplier rather than dropping it silently (§15)', async () => {
    await fund('100000');
    await approveBankDetails(blockedSupplierId, 'IQ00-2222');

    // The debt was raised while they were in good standing; the block came
    // later. That is the case worth testing — a supplier blocked before the
    // order could never have got this far (§6).
    await ownerPool.query(`update business_partner set status = 'active' where id = $1`, [
      blockedSupplierId,
    ]);
    const invoice = await openInvoice({ supplier: blockedSupplierId });
    await ownerPool.query(`update business_partner set status = 'blocked' where id = $1`, [
      blockedSupplierId,
    ]);

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    const row = view.excluded.find((one) => one.reference === invoice.invoiceNo);
    expect(row?.inclusion).toBe('excluded_blocked');
    expect(row?.reason).toMatch(/authorised override/);
  });

  it('excludes an invoice that has already been paid', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '50' });

    // Pay it through a first run, then propose again.
    const first = await batchReadyToApprove();
    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, first.batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: first.batch.id, bankInstructionRef: 'TRF-001' }),
    );

    const second = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, second.id));

    expect(view.selected.map((row) => row.reference)).not.toContain(invoice.invoiceNo);
    expect(view.deferred.map((row) => row.reference)).not.toContain(invoice.invoiceNo);
  });

  it('excludes a supplier with no approved bank details (§17)', async () => {
    await fund('100000');
    // SUP-002 is blocked *and* has no details; use a third, clean supplier.
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_supplier, status, active)
       values ('SUP-003','Supplier Three', true, 'active', true) returning id`,
    );
    const invoice = await openInvoice({ supplier: rows[0].id });

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    const row = view.excluded.find((one) => one.reference === invoice.invoiceNo);
    expect(row?.inclusion).toBe('excluded_no_bank_details');
  });

  it('records every candidate it considered, refused ones included', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    await unapprovedInvoice();

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    expect(view.selected.length + view.deferred.length + view.excluded.length).toBeGreaterThanOrEqual(2);
    for (const row of [...view.deferred, ...view.excluded]) {
      expect(row.reason).toBeTruthy();
    }
  });
});

describe('07.2 gate · proposal totals never exceed available cash (§15)', () => {
  it('defers what does not fit, and says so', async () => {
    await fund('1500');
    await openInvoice({ quantity: '100' }); // 1,000
    await openInvoice({ quantity: '100' }); // 1,000

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    expect(Number(view.proposal.selectedTotalIqd)).toBeLessThanOrEqual(1500);
    expect(view.selected).toHaveLength(1);
    expect(view.deferred).toHaveLength(1);
    expect(view.deferred[0]!.reason).toMatch(/does not fit/);
  });

  it('honours a ceiling below the real balance — Treasury may hold money back', async () => {
    await fund('100000');
    await openInvoice({ quantity: '100' });

    const built = await proposal(price('500'));
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    expect(view.proposal.availableFundsIqd).toBe('500.0000');
    expect(view.selected).toHaveLength(0);
  });

  it('cannot be made to select more than it had — the database refuses', async () => {
    await fund('1000');
    await openInvoice({ quantity: '100' });
    const built = await proposal();

    await expect(
      ownerPool.query(
        `update payment_proposal set selected_total_iqd = available_funds_iqd + 1 where id = $1`,
        [built.id],
      ),
    ).rejects.toThrow(/payment_proposal_within_available_cash/);
  });

  it('an approved batch commits its cash, so a second run cannot spend it twice', async () => {
    await fund('2500');
    await openInvoice({ quantity: '100' }); // 1,000
    await openInvoice({ quantity: '100' }); // 1,000

    const first = await batchReadyToApprove(price('1000'));
    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, first.batch.id));

    const [position] = await withScope(scope(maker), (tx) =>
      treasury.balances(tx, maker, '2026-02-25', { accountCode: null }),
    );

    expect(Number(position!.committedIqd)).toBe(1000);
    expect(Number(position!.availableIqd)).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// 07.3 · maker-checker
// ---------------------------------------------------------------------------

describe('07.3 gate · creator, approver and executor are different users (§17)', () => {
  it('every payment is high-risk until Finance sets a threshold (D13)', async () => {
    await fund('100000');
    await openInvoice({ quantity: '1' });

    const { batch } = await batchReadyToApprove();
    expect(batch.highRisk).toBe(true);
  });

  it('refuses the same user creating and approving', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    // The maker is an officer, so give them approval rights and try anyway:
    // the refusal must come from §17, not from the permission check.
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
      maker.principal.userId,
      'accounting_manager',
    ]);
    const elevated: ActorContext = {
      principal: await withScope(scope(maker), (tx) =>
        authz.loadPrincipal(tx, maker.principal.userId),
      ),
      branchCode: BAGHDAD,
    };

    expect(
      await rejection(withScope(scope(elevated), (tx) => run.approveBatch(tx, elevated, batch.id))),
    ).toMatch(/cannot have raised and approved/);
  });

  it('refuses the same user approving and executing', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    expect(
      await rejection(
        withScope(scope(checker), (tx) =>
          run.executeBatch(tx, checker, { batchId: batch.id, bankInstructionRef: 'TRF-X' }),
        ),
      ),
    ).toMatch(/cannot have approved and executed/);
  });

  it('refuses the same user creating and executing — the pair people forget', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    expect(
      await rejection(
        withScope(scope(maker), (tx) =>
          run.executeBatch(tx, maker, { batchId: batch.id, bankInstructionRef: 'TRF-Y' }),
        ),
      ),
    ).toMatch(/cannot have raised and executed/);
  });

  it('accepts three different people', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    const result = await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-OK' }),
    );

    expect(result.paymentIds).toHaveLength(1);
  });

  it('will not let the database hold a high-risk batch with two hats on one head', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await expect(
      ownerPool.query(`update payment_batch set approved_by = created_by, approved_at = now() where id = $1`, [
        batch.id,
      ]),
    ).rejects.toThrow(/payment_batch_maker_checker/);
  });

  it('will not let a batch be executed with no approval at all', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await expect(
      ownerPool.query(
        `update payment_batch set executed_by = $2, executed_at = now() where id = $1`,
        [batch.id, executor.principal.userId],
      ),
    ).rejects.toThrow(/payment_batch_executed_after_approval/);
  });
});

describe('07.3 gate · beneficiary bank details (§17, §15)', () => {
  it('blocks a payment to unverified details', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await ownerPool.query(
      `update partner_bank_account set is_active = false where partner_id = $1`,
      [supplierId],
    );

    expect(
      await rejection(withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id))),
    ).toMatch(/not active/);
  });

  it('re-triggers verification when the details change after approval (§15)', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    // Phase 03 froze the payable fields of an *approved* set, so changing them
    // means un-approving first. That is the whole sequence a change takes, and
    // it must leave the payment unpayable at the end of it.
    await ownerPool.query(
      `update partner_bank_account set approval_status = 'draft', is_active = false
        where partner_id = $1`,
      [supplierId],
    );
    await ownerPool.query(
      `update partner_bank_account set account_number = 'IQ00-9999' where partner_id = $1`,
      [supplierId],
    );

    expect(
      await rejection(
        withScope(scope(executor), (tx) =>
          run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-Z' }),
        ),
      ),
    ).toMatch(/not been independently approved/);
  });

  it('catches a change that was itself re-approved between approval and payment', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    // The dangerous case, and the one the revision exists for: the details are
    // un-approved, redirected, and approved again. Every row now looks valid —
    // approved, active, the same record the batch line points at — and the money
    // would still be going somewhere nobody signed for.
    await ownerPool.query(
      `update partner_bank_account set approval_status = 'draft', is_active = false
        where partner_id = $1`,
      [supplierId],
    );
    await ownerPool.query(
      `update partner_bank_account set account_number = 'IQ00-9999' where partner_id = $1`,
      [supplierId],
    );
    await ownerPool.query(
      `update partner_bank_account
          set approval_status = 'approved', is_active = true, approved_by = $2, approved_at = now()
        where partner_id = $1`,
      [supplierId, checker.principal.userId],
    );

    const { rows: check } = await ownerPool.query(
      `select approval_status, is_active from partner_bank_account where partner_id = $1`,
      [supplierId],
    );
    expect(check[0]).toMatchObject({ approval_status: 'approved', is_active: true });

    expect(
      await rejection(
        withScope(scope(executor), (tx) =>
          run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-W' }),
        ),
      ),
    ).toMatch(/changed after this payment was approved/);
  });

  it('bumps the revision in the database, never from the application', async () => {
    const { rows: before } = await ownerPool.query(
      `select revision from partner_bank_account where partner_id = $1`,
      [supplierId],
    );

    await ownerPool.query(`update partner_bank_account set revision = 99 where partner_id = $1`, [
      supplierId,
    ]);

    const { rows: after } = await ownerPool.query(
      `select revision from partner_bank_account where partner_id = $1`,
      [supplierId],
    );
    expect(after[0].revision).toBe(before[0].revision);
  });

  it('un-approves details the moment a payable field changes', async () => {
    // The account holder's *name* is not one of the fields Phase 03 froze, so
    // it can still be edited on an approved set — and redirecting a payment by
    // changing whose name is on the account is the same fraud by a quieter
    // route. The revision trigger closes it.
    await ownerPool.query(
      `update partner_bank_account set account_holder = 'Somebody Else' where partner_id = $1`,
      [supplierId],
    );

    const { rows } = await ownerPool.query(
      `select approval_status, is_active, approved_by, revision
         from partner_bank_account where partner_id = $1`,
      [supplierId],
    );

    expect(rows[0].approval_status).toBe('draft');
    expect(rows[0].is_active).toBe(false);
    expect(rows[0].approved_by).toBeNull();
    expect(rows[0].revision).toBe(2);
  });

  it('still refuses to edit the frozen fields of an approved set (§15, Phase 03)', async () => {
    await expect(
      ownerPool.query(
        `update partner_bank_account set account_number = 'IQ00-7777' where partner_id = $1`,
        [supplierId],
      ),
    ).rejects.toThrow(/Approved bank details cannot be edited/);
  });
});

// ---------------------------------------------------------------------------
// 07.2 · execution, failure and return
// ---------------------------------------------------------------------------

describe('07.2 gate · execution updates every source item in one transaction (§15)', () => {
  it('settles the invoice, posts the payment and credits the paying account', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '100' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-100' }),
    );

    const { rows: after } = await ownerPool.query(
      `select status, settled_amount_iqd from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(after[0].status).toBe('settled');
    expect(Number(after[0].settled_amount_iqd)).toBe(1000);

    // §17 — the credit landed in the account the money actually left.
    const { rows: credited } = await ownerPool.query(
      `select a.code
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.description like 'Supplier payment%' and l.credit_iqd > 0`,
    );
    expect(credited.map((row) => row.code)).toContain(bankGlCode);
  });

  it('pays an approved advance as Dr Supplier Advance / Cr Bank (Appendix C)', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '10' });

    const advance = await withScope(scope(maker), (tx) =>
      adv.request(tx, maker, {
        purchaseOrderId: invoice.orderId,
        branchCode: BAGHDAD,
        requestDate: '2026-02-12',
        amountIqd: price('300'),
        reason: 'Deposit before shipment',
      }),
    );
    await withScope(scope(checker), (tx) => adv.approve(tx, checker, advance.id));

    const { batch } = await batchReadyToApprove();
    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-ADV' }),
    );

    const { rows } = await ownerPool.query(
      `select status, paid_date from supplier_advance where id = $1`,
      [advance.id],
    );
    expect(rows[0].status).toBe('posted');
    expect(rows[0].paid_date).not.toBeNull();
  });

  it('leaves nothing behind when one line cannot pay', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '100' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    // Break the payable mapping the payment posting needs.
    await ownerPool.query(
      `delete from posting_rule where event_type = 'purchasing.supplier_payment' and line_role = 'supplier_payable'`,
    );

    await rejection(
      withScope(scope(executor), (tx) =>
        run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-FAIL' }),
      ),
    );

    const { rows } = await ownerPool.query(
      `select status, settled_amount_iqd from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(rows[0].status).toBe('posted');
    expect(Number(rows[0].settled_amount_iqd)).toBe(0);

    const { rows: batchAfter } = await ownerPool.query(
      `select status from payment_batch where id = $1`,
      [batch.id],
    );
    expect(batchAfter[0].status).toBe('approved');
  });

  it('refuses to send without the bank instruction reference (§17)', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();
    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    expect(
      await rejection(
        withScope(scope(executor), (tx) =>
          run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: '   ' }),
        ),
      ),
    ).toMatch(/instruction reference/);
  });
});

describe('07.2 gate · a failed or returned payment reverts the source items (§17)', () => {
  it('reverts an unsent line without touching the ledger', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    const { rows: lines } = await ownerPool.query(
      `select id from payment_batch_line where batch_id = $1`,
      [batch.id],
    );

    await withScope(scope(executor), (tx) =>
      run.reportFailure(tx, executor, {
        batchLineId: lines[0].id,
        reason: 'The bank rejected the beneficiary name.',
      }),
    );

    const { rows: after } = await ownerPool.query(
      `select status, settled_amount_iqd from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(after[0].status).toBe('posted');
    expect(Number(after[0].settled_amount_iqd)).toBe(0);
  });

  it('reverses a returned payment and opens the invoice again', async () => {
    await fund('100000');
    const invoice = await openInvoice({ quantity: '100' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-RET' }),
    );

    const { rows: lines } = await ownerPool.query(
      `select id from payment_batch_line where batch_id = $1`,
      [batch.id],
    );

    await withScope(scope(checker), (tx) =>
      run.reportFailure(tx, checker, {
        batchLineId: lines[0].id,
        reason: 'Returned by the correspondent bank — account closed.',
        reversalDate: '2026-02-28',
      }),
    );

    const { rows: after } = await ownerPool.query(
      `select status, settled_amount_iqd from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(after[0].status).toBe('posted');
    expect(Number(after[0].settled_amount_iqd)).toBe(0);

    const { rows: payment } = await ownerPool.query(
      `select status from supplier_payment order by created_at desc limit 1`,
    );
    expect(payment[0].status).toBe('reversed');
  });

  it('puts the bank balance back where it was', async () => {
    await fund('100000');
    await openInvoice({ quantity: '100' });

    const before = await withScope(scope(maker), (tx) =>
      treasury.balances(tx, maker, '2026-12-31', { accountCode: null }),
    );

    const { batch } = await batchReadyToApprove();
    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-BAL' }),
    );

    const { rows: lines } = await ownerPool.query(
      `select id from payment_batch_line where batch_id = $1`,
      [batch.id],
    );
    await withScope(scope(checker), (tx) =>
      run.reportFailure(tx, checker, {
        batchLineId: lines[0].id,
        reason: 'Returned unpaid.',
        reversalDate: '2026-02-28',
      }),
    );

    const after = await withScope(scope(maker), (tx) =>
      treasury.balances(tx, maker, '2026-12-31', { accountCode: null }),
    );

    expect(after[0]!.balanceIqd).toBe(before[0]!.balanceIqd);
  });

  it('reports every failure and return with its reason', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    const { rows: lines } = await ownerPool.query(
      `select id from payment_batch_line where batch_id = $1`,
      [batch.id],
    );
    await withScope(scope(executor), (tx) =>
      run.reportFailure(tx, executor, {
        batchLineId: lines[0].id,
        reason: 'IBAN rejected at the bank.',
      }),
    );

    const report = await withScope(scope(maker), (tx) => run.failureReport(tx, BAGHDAD));

    expect(report).toHaveLength(1);
    expect(report[0]!.status).toBe('failed');
    expect(report[0]!.failureReason).toMatch(/IBAN rejected/);
  });

  it('refuses a failure with no reason', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    const { rows: lines } = await ownerPool.query(
      `select id from payment_batch_line where batch_id = $1`,
      [batch.id],
    );

    expect(
      await rejection(
        withScope(scope(executor), (tx) =>
          run.reportFailure(tx, executor, { batchLineId: lines[0].id, reason: '  ' }),
        ),
      ),
    ).toMatch(/needs a reason/);
  });
});

// ---------------------------------------------------------------------------
// 07.3 · the audit trail
// ---------------------------------------------------------------------------

describe('07.3 gate · every maker-checker step is audited with actor and time (§17)', () => {
  it('records the proposal, the batch, the approval and the execution', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { built, batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));
    await withScope(scope(executor), (tx) =>
      run.executeBatch(tx, executor, { batchId: batch.id, bankInstructionRef: 'TRF-AUD' }),
    );

    const { rows } = await ownerPool.query(
      `select action, actor_user_id, occurred_at
         from audit_event
        where object_id in ($1, $2)
        order by occurred_at`,
      [built.id, batch.id],
    );

    const byAction = new Map(rows.map((row) => [row.action, row]));

    expect([...byAction.keys()]).toEqual(
      expect.arrayContaining([
        'payment_proposal.built',
        'payment_proposal.approved',
        'payment_batch.created',
        'payment_batch.approved',
        'payment_batch.executed',
      ]),
    );

    expect(byAction.get('payment_batch.created')!.actor_user_id).toBe(maker.principal.userId);
    expect(byAction.get('payment_batch.approved')!.actor_user_id).toBe(checker.principal.userId);
    expect(byAction.get('payment_batch.executed')!.actor_user_id).toBe(executor.principal.userId);

    for (const row of rows) expect(row.occurred_at).toBeInstanceOf(Date);
  });

  it('records which revision of the beneficiary details the approver saw', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await withScope(scope(checker), (tx) => run.approveBatch(tx, checker, batch.id));

    const { rows } = await ownerPool.query(
      `select after_value from audit_event where action = 'payment_batch.approved' and object_id = $1`,
      [batch.id],
    );

    expect(rows[0].after_value.beneficiaryRevisions[0].revision).toBe(1);

    const { rows: lines } = await ownerPool.query(
      `select approved_beneficiary_revision from payment_batch_line where batch_id = $1`,
      [batch.id],
    );
    expect(lines[0].approved_beneficiary_revision).toBe(1);
  });

  it('records the threshold that was in force, not the one in force later (D13)', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const { batch } = await batchReadyToApprove();

    await ownerPool.query(
      `update payment_risk_policy set high_risk_threshold_iqd = 999999999 where branch_code is null`,
    );

    const { rows } = await ownerPool.query(
      `select high_risk, risk_threshold_iqd from payment_batch where id = $1`,
      [batch.id],
    );
    expect(rows[0].high_risk).toBe(true);
    expect(Number(rows[0].risk_threshold_iqd)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

describe('§15 and §17 · what the database will not allow', () => {
  it('refuses a batch line that is not a selected item of its proposal', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    await openInvoice({ quantity: '10' });
    // A ceiling that fits exactly one, so the other is deferred and therefore
    // has no business being in the batch.
    const { batch } = await batchReadyToApprove(price('100'));

    const { rows: deferred } = await ownerPool.query(
      `select i.ap_invoice_id
         from payment_proposal_item i
         join payment_batch b on b.proposal_id = i.proposal_id
        where b.id = $1 and i.inclusion = 'deferred_funds'
        limit 1`,
      [batch.id],
    );
    expect(deferred).toHaveLength(1);

    const { rows: bank } = await ownerPool.query(
      `select id from partner_bank_account where partner_id = $1 limit 1`,
      [supplierId],
    );

    await expect(
      ownerPool.query(
        `insert into payment_batch_line
           (batch_id, line_no, supplier_id, ap_invoice_id, partner_bank_account_id, amount_iqd)
         values ($1, 99, $2, $3, $4, 1)`,
        [batch.id, supplierId, deferred[0].ap_invoice_id, bank[0].id],
      ),
    ).rejects.toThrow(/not a selected item of the proposal/);
  });

  it('refuses a proposal whose header total does not match its items', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const built = await proposal();

    await expect(
      ownerPool.query(
        `update payment_proposal_item set outstanding_iqd = outstanding_iqd + 1
          where proposal_id = $1 and inclusion = 'selected'`,
        [built.id],
      ),
    ).rejects.toThrow(/but its items total/);
  });

  it('refuses an exclusion with no reason', async () => {
    await fund('100000');
    await unapprovedInvoice();
    const built = await proposal();

    await expect(
      ownerPool.query(
        `update payment_proposal_item set reason = null
          where proposal_id = $1 and inclusion <> 'selected'`,
        [built.id],
      ),
    ).rejects.toThrow(/payment_proposal_item_reason_present/);
  });

  it('will not let the same invoice sit in two live batches', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const first = await batchReadyToApprove();

    const { rows: lines } = await ownerPool.query(
      `select supplier_id, ap_invoice_id, partner_bank_account_id, amount_iqd
         from payment_batch_line where batch_id = $1`,
      [first.batch.id],
    );

    await expect(
      ownerPool.query(
        `insert into payment_batch_line
           (batch_id, line_no, supplier_id, ap_invoice_id, partner_bank_account_id, amount_iqd)
         values ($1, 2, $2, $3, $4, $5)`,
        [
          first.batch.id,
          lines[0].supplier_id,
          lines[0].ap_invoice_id,
          lines[0].partner_bank_account_id,
          lines[0].amount_iqd,
        ],
      ),
    ).rejects.toThrow(/payment_batch_line_invoice_live_uniq/);
  });

  it('refuses a batch raised from a proposal nobody approved', async () => {
    await fund('100000');
    await openInvoice({ quantity: '10' });
    const built = await proposal();

    expect(
      await rejection(
        withScope(scope(maker), (tx) =>
          run.createBatch(tx, maker, { proposalId: built.id, paymentDate: '2026-02-25' }),
        ),
      ),
    ).toMatch(/comes from an approved proposal/);
  });

  it('refuses a batch from a proposal that selected nothing', async () => {
    await fund('100000');
    await unapprovedInvoice();
    const built = await proposal();
    await withScope(scope(checker), (tx) => run.approveProposal(tx, checker, built.id));

    expect(
      await rejection(
        withScope(scope(maker), (tx) =>
          run.createBatch(tx, maker, { proposalId: built.id, paymentDate: '2026-02-25' }),
        ),
      ),
    ).toMatch(/selected nothing/);
  });

  it('records the total the proposal reports, and it equals its selected items', async () => {
    await fund('100000');
    await openInvoice({ quantity: '30' });
    await openInvoice({ quantity: '20' });

    const built = await proposal();
    const view = await withScope(scope(maker), (tx) => run.viewProposal(tx, built.id));

    const sum = view.selected.reduce((total, row) => total + parseDecimal(row.outstandingIqd, 4n), 0n);
    expect(view.proposal.selectedTotalIqd).toBe(toDecimalString(sum, 4n));
  });
});
