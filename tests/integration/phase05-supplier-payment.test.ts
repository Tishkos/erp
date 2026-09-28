/**
 * Phase 05.9 and 05.10 test gates — A/P ageing, statements and supplier
 * payment, §15 and Appendix C.
 *
 * 05.9
 *   - A/P ageing by supplier, currency, branch and due bucket ties to the G/L
 *     control account
 *   - A payment exceeding the available balance is rejected
 *   - A blocked supplier cannot be paid without an authorised, audited override
 *   - Unapplied credit and advance balances are visible, not netted away
 *   - Supplier statement reconciliation identifies unmatched items
 *
 * 05.10
 *   - Payment allocates to specific invoices and updates ageing immediately
 *   - Allocation history is retained
 *   - The A/P subledger reconciles to the G/L control account after payment
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
import * as pay from '@/server/services/supplier-payment';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const AS_OF = '2026-04-01';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
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

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager+ceo');

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','Supplier One', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  const { rows: bank } = await ownerPool.query(
    `select id from bank_cash_account where account_type = 'bank' limit 1`,
  );
  bankAccountId = bank[0].id;

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
    [manager.principal.userId],
  );

  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['supplier_advance', 'A000001', 'Supplier Advances'],
    ['bank', 'A000001', 'Bank'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
    ['return_clearing', 'L000001', 'Return Clearing'],
    ['expense', 'X000001', 'Service and Expense Cost'],
    ['purchase_variance', 'X000001', 'Purchase Price Variance'],
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
      'purchasing.supplier_advance_payment',
      'purchasing.supplier_advance_settlement',
      'purchasing.supplier_payment',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
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

  await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.setRequiredDimensions(tx, manager, accounts.purchase_variance!, []),
  );
});

let seq = 0;

/** An order, received and invoiced — a real open item. */
async function openInvoice(
  options: { quantity?: string; dueDate?: string; invoiceDate?: string } = {},
) {
  const quantity = qty(options.quantity ?? '100');

  const order = await withScope(scope(clerk), (tx) =>
    po.create(tx, clerk, {
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
  await withScope(scope(clerk), (tx) => po.submit(tx, clerk, order.id));
  await withScope(scope(manager), (tx) => po.approve(tx, manager, order.id));

  const { rows: poLines } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1`,
    [order.id],
  );

  const receipt = await withScope(scope(clerk), (tx) =>
    gr.create(tx, clerk, {
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLines[0].id, quantity, batchNumber: `B-${(seq += 1)}` }],
    }),
  );
  await withScope(scope(clerk), (tx) => gr.submit(tx, clerk, receipt.id));
  await withScope(scope(manager), (tx) => gr.post(tx, manager, receipt.id));

  const invoice = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SUP-INV-${seq}`,
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      invoiceDate: options.invoiceDate ?? '2026-02-10',
      dueDate: options.dueDate ?? '2026-03-10',
      lines: [{ purchaseOrderLineId: poLines[0].id, quantity, unitPriceIqd: price('10') }],
    }),
  );
  await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, invoice.id));
  await withScope(scope(manager), (tx) => ap.post(tx, manager, invoice.id));

  return { ...invoice, orderId: order.id, poLineId: poLines[0].id as string };
}

async function payment(amountIqd: bigint, overrides: Partial<pay.CreatePaymentInput> = {}) {
  return withScope(scope(clerk), (tx) =>
    pay.create(tx, clerk, {
      supplierId,
      bankCashAccountId: bankAccountId,
      branchCode: BAGHDAD,
      paymentDate: '2026-03-15',
      amountIqd,
      reference: `TRF-${(seq += 1)}`,
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('05.10 gate · payment allocates to specific invoices', () => {
  it('reduces the invoice and the payment together', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));

    const result = await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('600'),
      }),
    );

    expect(result.invoiceOutstanding).toBe(price('400'));
    expect(result.paymentUnallocated).toBe(price('400'));
  });

  it('settles the invoice when the last dinar is allocated', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));

    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('1000'),
      }),
    );

    const { rows } = await ownerPool.query(`select status from ap_invoice where id = $1`, [
      invoice.id,
    ]);
    expect(rows[0].status).toBe('settled');
  });

  it('updates the ageing in the same transaction (§15 criterion 3)', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));

    const before = await withScope(scope(manager), (tx) => pay.ageing(tx, AS_OF));
    expect(before).toHaveLength(1);

    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('1000'),
      }),
    );

    // The ageing reads the invoices themselves, so there is no cache to refresh
    // and no window in which the two disagree.
    expect(await withScope(scope(manager), (tx) => pay.ageing(tx, AS_OF))).toHaveLength(0);
  });

  it('spreads one payment across several invoices', async () => {
    const first = await openInvoice({ quantity: '40' });
    const second = await openInvoice({ quantity: '60' });
    const made = await payment(price('1000'));

    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: first.id,
        amountIqd: price('400'),
      }),
    );
    const result = await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: second.id,
        amountIqd: price('600'),
      }),
    );

    expect(result.paymentUnallocated).toBe(0n);
  });

  it('refuses the same payment against the same invoice twice', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));

    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('400'),
      }),
    );

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        pay.allocate(tx, manager, {
          supplierPaymentId: made.id,
          apInvoiceId: invoice.id,
          amountIqd: price('100'),
        }),
      ),
    );
    expect(error).toMatch(/already allocated to invoice/);
  });

  it('refuses at the database too', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));
    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('400'),
      }),
    );

    await expect(
      ownerPool.query(
        `insert into supplier_payment_allocation
           (supplier_payment_id, ap_invoice_id, amount_iqd, allocated_by)
         values ($1,$2,100,$3)`,
        [made.id, invoice.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/supplier_payment_allocation_pair_uniq/);
  });
});

// ---------------------------------------------------------------------------

describe('05.9 gate · a payment exceeding the available balance is rejected', () => {
  it('refuses more than the invoice owes', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('5000'));

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        pay.allocate(tx, manager, {
          supplierPaymentId: made.id,
          apInvoiceId: invoice.id,
          amountIqd: price('1200'),
        }),
      ),
    );
    expect(error).toMatch(/exceed the invoice balance/);
    expect(error).toMatch(/paid down to zero/);
  });

  it('refuses more than the payment holds', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('300'));

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        pay.allocate(tx, manager, {
          supplierPaymentId: made.id,
          apInvoiceId: invoice.id,
          amountIqd: price('400'),
        }),
      ),
    );
    expect(error).toMatch(/exceed the payment balance/);
    expect(error).toMatch(/money that left the bank/);
  });

  it('counts what an advance already settled', async () => {
    const invoice = await openInvoice();

    // 400 of the 1,000 already discharged by an advance.
    const advance = await withScope(scope(clerk), (tx) =>
      adv.request(tx, clerk, {
        purchaseOrderId: invoice.orderId,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('400'),
      }),
    );
    await withScope(scope(manager), (tx) => adv.approve(tx, manager, advance.id));
    await withScope(scope(manager), (tx) => adv.pay(tx, manager, advance.id, '2026-02-03'));
    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('400'),
        settlementDate: '2026-02-11',
      }),
    );

    const made = await payment(price('1000'));
    const error = await rejection(
      withScope(scope(manager), (tx) =>
        pay.allocate(tx, manager, {
          supplierPaymentId: made.id,
          apInvoiceId: invoice.id,
          amountIqd: price('700'),
        }),
      ),
    );
    // 600 left, not 1,000: the advance and the payment draw on the same debt.
    expect(error).toMatch(/exceed the invoice balance of 600/);
  });

  it('refuses to pay an invoice that has not posted', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));

    await ownerPool.query(`update ap_invoice set status = 'draft' where id = $1`, [invoice.id]);

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        pay.allocate(tx, manager, {
          supplierPaymentId: made.id,
          apInvoiceId: invoice.id,
          amountIqd: price('100'),
        }),
      ),
    );
    expect(error).toMatch(/allocated to approved open items/);
  });
});

// ---------------------------------------------------------------------------

describe('05.9 gate · a blocked supplier needs an authorised, audited override', () => {
  async function block(status = 'blocked') {
    await ownerPool.query(`update business_partner set status = $1 where id = $2`, [
      status,
      supplierId,
    ]);
  }

  it('refuses the payment outright', async () => {
    await block();
    const error = await rejection(payment(price('1000')));

    expect(error).toMatch(/SUP-001 is blocked, so it cannot be paid/);
    expect(error).toMatch(/A manager may override the block with a reason/);
  });

  it('refuses an on-hold supplier too', async () => {
    await block('on_hold');
    expect(await rejection(payment(price('1000')))).toMatch(/is on hold, so it cannot be paid/);
  });

  it('allows it with an override, a reason and a second person', async () => {
    await block();
    const made = await payment(price('1000'), {
      blockedOverrideBy: manager.principal.userId,
      blockedOverrideReason: 'Court-ordered settlement; Legal instructed payment on 14 March.',
    });

    const { rows } = await ownerPool.query(
      `select blocked_override_by, blocked_override_at, blocked_override_reason
         from supplier_payment where id = $1`,
      [made.id],
    );
    expect(rows[0].blocked_override_by).toBe(manager.principal.userId);
    expect(rows[0].blocked_override_at).not.toBeNull();
    expect(rows[0].blocked_override_reason).toMatch(/Court-ordered/);
  });

  it('refuses an override with no reason', async () => {
    await block();
    const error = await rejection(
      payment(price('1000'), { blockedOverrideBy: manager.principal.userId }),
    );
    expect(error).toMatch(/needs a reason/);
  });

  it('refuses the raiser waiving the block themselves (§5.2)', async () => {
    await block();
    const error = await rejection(
      payment(price('1000'), {
        blockedOverrideBy: clerk.principal.userId,
        blockedOverrideReason: 'Fine by me',
      }),
    );
    expect(error).toMatch(/cannot also be the one who waives the block/);
  });

  it('records the override in the audit trail (§5.4)', async () => {
    await block();
    const made = await payment(price('1000'), {
      blockedOverrideBy: manager.principal.userId,
      blockedOverrideReason: 'Legal instructed payment.',
    });

    const { rows } = await ownerPool.query(
      `select reason, after_value from audit_event
        where object_id = $1 and action = 'supplier_payment.created'`,
      [made.id],
    );
    expect(rows[0].reason).toMatch(/Legal instructed/);
    expect(rows[0].after_value.blockedOverride).toBe(true);
    expect(rows[0].after_value.supplierStatus).toBe('blocked');
  });

  it('refuses at the database an override recorded without a reason', async () => {
    const made = await payment(price('1000'));
    await expect(
      ownerPool.query(
        `update supplier_payment set blocked_override_by = $1, blocked_override_at = now()
          where id = $2`,
        [manager.principal.userId, made.id],
      ),
    ).rejects.toThrow(/supplier_payment_override_complete/);
  });
});

// ---------------------------------------------------------------------------

describe('05.9 gate · the ageing ties to the G/L control account', () => {
  it('agrees with Trade Payables to the dinar', async () => {
    await openInvoice({ quantity: '40' });
    await openInvoice({ quantity: '60' });

    const invoice = await openInvoice({ quantity: '100' });
    const made = await payment(price('1000'));
    await withScope(scope(manager), (tx) => pay.post(tx, manager, made.id));
    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('1000'),
      }),
    );

    const rows = await withScope(scope(manager), (tx) => pay.ageing(tx, AS_OF));
    const ageingTotal = rows.reduce(
      (total, row) => total + parseDecimal(row.outstandingIqd, 4n),
      0n,
    );

    const { rows: gl } = await ownerPool.query(
      `select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) as balance
         from journal_line where account_id = $1`,
      [accounts.supplier_payable],
    );

    // §27 Release 4: "source documents, supplier ledger and G/L reconcile."
    expect(Number(gl[0].balance)).toBe(Number(ageingTotal / 10_000n));
  });

  it('buckets by the due date, not the invoice date', async () => {
    // 90-day terms: not overdue on day 60, whatever the invoice date says.
    await openInvoice({ quantity: '10', dueDate: '2026-05-11' }); // ahead — current
    await openInvoice({ quantity: '10', dueDate: '2026-03-20' }); // 12 days late
    await openInvoice({ quantity: '10', dueDate: '2026-02-10', invoiceDate: '2026-01-05' }); // 50

    const rows = await withScope(scope(manager), (tx) => pay.ageing(tx, AS_OF));
    const buckets = rows.map((row) => row.bucket).sort();

    expect(buckets).toEqual(['1-30', '31-60', 'current']);
  });

  it('carries supplier, branch and currency on every row', async () => {
    await openInvoice();
    const rows = await withScope(scope(manager), (tx) => pay.ageing(tx, AS_OF));

    expect(rows[0]!.supplierCode).toBe('SUP-001');
    expect(rows[0]!.branchCode).toBe(BAGHDAD);
    expect(rows[0]!.currency).toBe('IQD');
  });

  it('forecasts what is about to be needed', async () => {
    await openInvoice({ quantity: '10', dueDate: '2026-04-20' });
    await openInvoice({ quantity: '10', dueDate: '2026-03-01' });

    const forecast = await withScope(scope(manager), (tx) => pay.cashRequirement(tx, AS_OF));
    expect(forecast.overdue).toBe(price('100'));
    expect(forecast['0-30']).toBe(price('100'));
  });
});

// ---------------------------------------------------------------------------

describe('05.9 gate · unapplied balances stay visible, not netted away', () => {
  it('shows advances, credits and unallocated payments separately', async () => {
    const invoice = await openInvoice();

    const advance = await withScope(scope(clerk), (tx) =>
      adv.request(tx, clerk, {
        purchaseOrderId: invoice.orderId,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('700'),
      }),
    );
    await withScope(scope(manager), (tx) => adv.approve(tx, manager, advance.id));
    await withScope(scope(manager), (tx) => adv.pay(tx, manager, advance.id, '2026-02-03'));

    const made = await payment(price('500'));
    await withScope(scope(manager), (tx) => pay.post(tx, manager, made.id));

    const account = await withScope(scope(manager), (tx) =>
      pay.supplierAccount(tx, supplierId, AS_OF),
    );

    // Netting these into one balance is the number people ask for and the one
    // nobody can act on: it cannot say whether to chase, apply or pay.
    expect(account.outstandingIqd).toBe(price('1000'));
    expect(account.unappliedAdvanceIqd).toBe(price('700'));
    expect(account.unallocatedPaymentIqd).toBe(price('500'));
  });

  it('drops an advance from the unapplied list once it is consumed', async () => {
    const invoice = await openInvoice();
    const advance = await withScope(scope(clerk), (tx) =>
      adv.request(tx, clerk, {
        purchaseOrderId: invoice.orderId,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('400'),
      }),
    );
    await withScope(scope(manager), (tx) => adv.approve(tx, manager, advance.id));
    await withScope(scope(manager), (tx) => adv.pay(tx, manager, advance.id, '2026-02-03'));
    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('400'),
        settlementDate: '2026-02-11',
      }),
    );

    const account = await withScope(scope(manager), (tx) =>
      pay.supplierAccount(tx, supplierId, AS_OF),
    );
    expect(account.unappliedAdvanceIqd).toBe(0n);
    expect(account.outstandingIqd).toBe(price('600'));
  });
});

// ---------------------------------------------------------------------------

describe('05.9 gate · statement reconciliation finds the unmatched items', () => {
  it('separates agreed, differing and one-sided items', async () => {
    const first = await openInvoice({ quantity: '40' });
    const second = await openInvoice({ quantity: '60' });
    const { rows } = await ownerPool.query(
      `select id, supplier_invoice_no from ap_invoice order by invoice_no`,
    );
    const numbers = rows.map((r) => r.supplier_invoice_no as string);
    void first;
    void second;

    const result = await withScope(scope(manager), (tx) =>
      pay.reconcileStatement(
        tx,
        supplierId,
        [
          // Agreed.
          { supplierInvoiceNo: numbers[0]!, amountIqd: price('400') },
          // They think we owe more.
          { supplierInvoiceNo: numbers[1]!, amountIqd: price('700') },
          // On their statement and not on our books at all.
          { supplierInvoiceNo: 'THEIRS-ONLY', amountIqd: price('250') },
        ],
        AS_OF,
      ),
    );

    expect(result.matched.map((r) => r.supplierInvoiceNo)).toEqual([numbers[0]]);
    expect(result.differing).toHaveLength(1);
    expect(result.differing[0]!.oursIqd).toBe(price('600'));
    expect(result.differing[0]!.theirsIqd).toBe(price('700'));
    expect(result.onlyOnTheirs.map((r) => r.supplierInvoiceNo)).toEqual(['THEIRS-ONLY']);
    expect(result.onlyOnOurs).toHaveLength(0);
  });

  it('reports an invoice the supplier has forgotten', async () => {
    await openInvoice();
    const result = await withScope(scope(manager), (tx) =>
      pay.reconcileStatement(tx, supplierId, [], AS_OF),
    );

    expect(result.onlyOnOurs).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('05.10 gate · the ledger reconciles after payment', () => {
  it('posts Dr Supplier A/P / Cr Bank (Appendix C)', async () => {
    await openInvoice();
    const made = await payment(price('1000'));
    const posted = await withScope(scope(manager), (tx) => pay.post(tx, manager, made.id));

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [posted.journalEntryId],
    );
    // "Cr Bank" means *the account the money left*, which is the G/L account
    // mapped to the bank account named on the payment — not whichever account
    // the `bank` posting rule points at. With one bank account the two are the
    // same; with two, a mapping would credit the wrong one every time (§17).
    const { rows: paying } = await ownerPool.query(
      `select gl_account_id from bank_cash_account where id = $1`,
      [bankAccountId],
    );

    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    expect(Number(byAccount.get(accounts.supplier_payable)?.debit_iqd)).toBe(1000);
    expect(Number(byAccount.get(paying[0].gl_account_id)?.credit_iqd)).toBe(1000);
  });

  it('leaves the control account at zero when everything is paid', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('1000'));
    await withScope(scope(manager), (tx) => pay.post(tx, manager, made.id));
    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('1000'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) as balance
         from journal_line where account_id = $1`,
      [accounts.supplier_payable],
    );
    expect(Number(rows[0].balance)).toBe(0);
  });

  it('keeps the A/P subledger and the control account in step (§15 criterion 5)', async () => {
    const invoice = await openInvoice();
    const made = await payment(price('600'));
    await withScope(scope(manager), (tx) => pay.post(tx, manager, made.id));
    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: invoice.id,
        amountIqd: price('600'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select
         (select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) from journal_line where account_id = $1) as gl,
         (select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) from subledger_entry where control_account_id = $1) as sub`,
      [accounts.supplier_payable],
    );
    expect(Number(rows[0].gl)).toBe(Number(rows[0].sub));
    expect(Number(rows[0].gl)).toBe(400);
  });

  it('keeps the allocation history (Appendix C)', async () => {
    const first = await openInvoice({ quantity: '40' });
    const second = await openInvoice({ quantity: '60' });
    const made = await payment(price('1000'));

    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: first.id,
        amountIqd: price('400'),
      }),
    );
    await withScope(scope(manager), (tx) =>
      pay.allocate(tx, manager, {
        supplierPaymentId: made.id,
        apInvoiceId: second.id,
        amountIqd: price('600'),
      }),
    );

    const history = await withScope(scope(manager), (tx) =>
      pay.allocationHistory(tx, made.id),
    );
    expect(history).toHaveLength(2);
    expect(history.map((h) => Number(h.amountIqd))).toEqual([400, 600]);

    // And from the invoice's side: "was this invoice paid, and by which payment?"
    const payments = await withScope(scope(manager), (tx) => pay.paymentsFor(tx, first.id));
    expect(payments).toHaveLength(1);
    expect(payments[0]!.paymentNo).toBeTruthy();
  });

  it('refuses a payment from an account in another currency (§17)', async () => {
    const { rows } = await ownerPool.query(
      `insert into bank_cash_account
         (code, name, account_type, bank_name, account_number, currency, gl_account_id)
       values ('BANK-USD','USD Account','bank','Seed Bank','ACC-USD','USD',$1) returning id`,
      [accounts.bank],
    );

    const error = await rejection(
      payment(price('1000'), { bankCashAccountId: rows[0].id }),
    );
    expect(error).toMatch(/holds USD and this payment is in IQD/);
  });
});
