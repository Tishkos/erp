/**
 * Receivables (2026-10-04) — the sponsor's validation list, §14, against the
 * real database:
 *
 *   invoice 100,000 → receivable 100,000
 *   partial receipt 40,000 → 60,000 outstanding
 *   full payment → zero outstanding, invoice Paid
 *   5,000,000 received with no invoice → 5,000,000 customer credit
 *   100,000 invoice, 120,000 receipt → 20,000 unapplied credit
 *   due three days ago, unpaid → three days overdue
 *   due 1 Oct, paid 4 Oct → paid three days late
 *   100,000 invoice, 10,000 credit note → 90,000 outstanding
 *   a debit note is owed, ages, and is settled by a receipt
 *   a sales return keeps A/R, stock, revenue and cost consistent
 *   customer subledger = A/R control in the G/L
 *
 * Every figure is read back through the services the screens use — the
 * ageing's `openItems`, the subledger, the reconciliation, the credits
 * register — so a green run means the screens agree with each other.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ar from '@/server/services/ar-invoice';
import * as banks from '@/server/services/bank-cash-accounts';
import * as receipts from '@/server/services/customer-receipt';
import * as notes from '@/server/services/customer-notes';
import * as credits from '@/server/services/customer-credits';
import * as openItems from '@/server/services/open-items';
import * as subledger from '@/server/services/subledger';
import * as sr from '@/server/services/sales-return';
import * as inventory from '@/server/services/inventory';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { assertApplicable, creditOnPosting, daysLate } from '@/server/domain/customer-credits';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const WAREHOUSE = `WH-${BAGHDAD}`;
const AS_OF = '2026-10-20';

const iqd = (value: string) => parseDecimal(value, 4n);
const qty = (value: string) => parseQuantity(value);

let clerk: ActorContext;
let manager: ActorContext;
let customerId: string;
let otherCustomerId: string;
let bankAccountId: string;
let accounts: Record<string, string>;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  for (const code of role.split('+')) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, code]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const as = <T>(ctx: ActorContext, work: Parameters<typeof withScope<T>>[1]) => withScope(scope(ctx), work);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`,
  );

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager+ceo');

  accounts = {};
  const roles = [
    ['inventory', 'A000001', null],
    ['customer_receivable', 'A000001', 'customer'],
    ['bank', 'A000001', null],
    ['customer_clearing', 'L000001', null],
    ['sales_revenue', 'R000001', null],
    ['sales_returns', 'R000001', null],
    ['cogs', 'X000001', null],
  ] as const;
  for (const [index, [role, parent, control]] of roles.entries()) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`${parent.slice(0, 1)}8RC${String(index).padStart(3, '0')}`, `RCV ${role}`, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
    for (const event of [
      'sales.ar_invoice',
      'sales.customer_receipt',
      'sales.customer_credit_memo',
      'sales.customer_credit_note',
      'sales.customer_debit_note',
      'inventory.sales_return',
    ]) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1,$2,$3,true,$4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
    await as(manager, (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }

  // The item and its base unit arrive together: the unit check is deferred to
  // the end of the transaction that creates the item.
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: item } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking, inventory_account_id, cogs_account_id)
       values ($1,'Solar Panel 550W',true,'EA','batch',$2,$3) returning id`,
      [PANEL, accounts.inventory, accounts.cogs],
    );
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator) values ($1,'EA',1,1)`,
      [item[0].id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await ownerPool.query(
    `insert into payment_terms (code, name, basis, due_days) values ('NET30','Net 30','document_date',30)
     on conflict do nothing`,
  );
  const partner = async (code: string, name: string) => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, status, active, payment_terms_code)
       values ($1,$2,true,'active',true,'NET30') returning id`,
      [code, name],
    );
    return rows[0].id as string;
  };
  customerId = await partner('CUST-RCV', 'Al Noor Trading');
  otherCustomerId = await partner('CUST-OTH', 'Dijla Supplies');

  const bank = await as(manager, (tx) =>
    banks.create(tx, manager, 'bank', {
      name: 'Rafidain Current Account',
      bankName: 'Rafidain Bank',
      accountNumber: 'RF-7001',
      currency: 'IQD',
      glAccountId: accounts.bank!,
    }),
  );
  const { rows: banked } = await ownerPool.query(`select id from bank_cash_account where code = $1`, [bank.code]);
  bankAccountId = banked[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  for (const [no, name, from, to] of [
    [8, 'August 2026', '2026-08-01', '2026-08-31'],
    [9, 'September 2026', '2026-09-01', '2026-09-30'],
    [10, 'October 2026', '2026-10-01', '2026-10-31'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [years[0].id, no, name, from, to],
    );
  }
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('ar_invoice','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );

  await as(manager, (tx) =>
    inventory.receive(tx, manager, {
      itemCode: PANEL,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity: qty('1000'),
      unitCostIqd: iqd('4000'),
      movementDate: '2026-08-01',
      kind: 'opening_stock',
      batchNumber: 'B-1',
    }),
  );
});

afterAll(async () => {
  await resetTestData();
});

/** A posted sales invoice for `quantity` panels at `unitPrice`, due when asked. */
async function sell(
  amount: string,
  options: { invoiceDate?: string; dueDate?: string; customer?: string; quantity?: string } = {},
) {
  const quantity = options.quantity ?? '1';
  const unit = (Number(amount) / Number(quantity)).toFixed(4);
  const made = await as(clerk, (tx) =>
    ar.createDirect(tx, clerk, {
      customerId: options.customer ?? customerId,
      branchCode: BAGHDAD,
      invoiceDate: options.invoiceDate ?? '2026-09-01',
      ...(options.dueDate ? { dueDate: options.dueDate } : {}),
      lines: [{ itemCode: PANEL, quantity: qty(quantity), unitPriceIqd: iqd(unit), warehouseCode: WAREHOUSE }],
    }),
  );
  await as(manager, (tx) => ar.approve(tx, manager, made.id));
  await as(manager, (tx) => ar.post(tx, manager, made.id));
  const view = await as(manager, (tx) => ar.view(tx, made.id));
  return { id: made.id, invoiceNo: view.invoiceNo, lineId: view.lines[0]!.id };
}

async function receive(amount: string, receiptDate = '2026-09-10', customer = customerId) {
  const made = await as(clerk, (tx) =>
    receipts.create(tx, clerk, {
      customerId: customer,
      branchCode: BAGHDAD,
      receiptDate,
      bankCashAccountId: bankAccountId,
      amountIqd: iqd(amount),
      bankReference: `TT-${amount}`,
    }),
  );
  await as(manager, (tx) => receipts.approve(tx, manager, made.id));
  await as(manager, (tx) => receipts.post(tx, manager, made.id));
  return made;
}

async function allocate(receiptId: string, invoiceId: string, amount: string) {
  return as(manager, (tx) => receipts.allocate(tx, manager, receiptId, [{ arInvoiceId: invoiceId, amountIqd: iqd(amount) }]));
}

async function note(
  kind: 'credit' | 'debit',
  amount: string,
  options: { invoiceId?: string; noteDate?: string; dueDate?: string } = {},
) {
  const made = await as(clerk, (tx) =>
    notes.create(tx, clerk, {
      kind,
      customerId,
      branchCode: BAGHDAD,
      noteDate: options.noteDate ?? '2026-09-15',
      dueDate: options.dueDate ?? null,
      arInvoiceId: options.invoiceId ?? null,
      amountIqd: iqd(amount),
      reason: kind === 'credit' ? 'Price allowance agreed with the customer' : 'Freight recharged',
    }),
  );
  await as(manager, (tx) => notes.approve(tx, manager, made.id));
  const posted = await as(manager, (tx) => notes.post(tx, manager, made.id));
  return { ...made, ...posted };
}

const items = (asOf = AS_OF, filter: openItems.OpenItemFilter = {}) =>
  as(manager, (tx) => openItems.openItems(tx, manager.principal, 'customer', asOf, { branchCode: BAGHDAD, ...filter }));

const itemOf = async (number: string, asOf = AS_OF) => {
  const found = (await items(asOf)).find((row) => row.invoiceNo === number);
  if (!found) throw new Error(`${number} is not an open item`);
  return found;
};

/** What the customer subledger says the customer owes, in dinars. */
const ledger = async (code = 'CUST-RCV') =>
  Number(
    (
      await as(manager, (tx) => openItems.ledgerBalances(tx, manager.principal, 'customer', AS_OF, { partyCode: code }))
    )[0]?.balanceIqd ?? 0,
  );

const tie = async () => {
  const every = await items();
  const balances = await as(manager, (tx) =>
    openItems.ledgerBalances(tx, manager.principal, 'customer', AS_OF, { branchCode: BAGHDAD }),
  );
  return openItems.reconciliationTotals(openItems.reconcile(every, balances));
};

const controlTies = async () => {
  const rows = await as(manager, (tx) => subledger.reconciliation(tx, AS_OF));
  return rows.filter((row) => row.subledgerType === 'customer');
};

describe('§14 · invoice, receipt, outstanding', () => {
  it('a 100,000 invoice is a 100,000 receivable', async () => {
    const invoice = await sell('100000');
    expect(await ledger()).toBe(100000);
    const item = await itemOf(invoice.invoiceNo);
    expect(Number(item.outstandingIqd)).toBe(100000);
    expect(item.status).toBe('posted');
  });

  it('a 40,000 receipt leaves 60,000 outstanding and the invoice part paid — the receipt alone does not pay it', async () => {
    const invoice = await sell('100000');
    const receipt = await receive('40000');

    // Received, not yet allocated: the invoice is untouched, the money is a credit.
    let item = await itemOf(invoice.invoiceNo);
    expect(Number(item.outstandingIqd)).toBe(100000);
    expect(await ledger()).toBe(60000);

    await allocate(receipt.id, invoice.id, '40000');
    item = await itemOf(invoice.invoiceNo);
    expect(Number(item.totalIqd)).toBe(100000);
    expect(Number(item.paidIqd)).toBe(40000);
    expect(Number(item.outstandingIqd)).toBe(60000);
    expect(item.status).toBe('partially_executed');
    expect(openItems.invoicePositionTotals(await items()).grossIqd).toBe('60000');
  });

  it('a full payment settles it, and a paid invoice is not outstanding', async () => {
    const invoice = await sell('100000');
    const receipt = await receive('100000');
    await allocate(receipt.id, invoice.id, '100000');
    const item = await itemOf(invoice.invoiceNo);
    expect(Number(item.outstandingIqd)).toBe(0);
    expect(item.status).toBe('settled');
    const outstanding = await items(AS_OF, { outstandingOnly: true });
    expect(outstanding.map((row) => row.invoiceNo)).not.toContain(invoice.invoiceNo);
    expect(await ledger()).toBe(0);
  });
});

describe('§14 · credits and advances', () => {
  it('5,000,000 received with no invoice is a 5,000,000 credit — and no invoice is invented', async () => {
    await receive('5000000');
    const register = await as(manager, (tx) => credits.register(tx, { customerId }));
    expect(register).toHaveLength(1);
    expect(register[0]!.kind).toBe('receipt');
    expect(Number(register[0]!.unappliedIqd)).toBe(5000000);
    expect(await items()).toHaveLength(0);
    expect(await ledger()).toBe(-5000000);
  });

  it('keeps the advance apart from the invoice: gross 100,000, credits 5,000,000, net -4,900,000', async () => {
    await sell('100000');
    await receive('5000000');
    const position = openItems.invoicePositionTotals(await items());
    const totals = await tie();
    expect(Number(position.grossIqd)).toBe(100000);
    expect(Number(totals.unappliedCreditsIqd)).toBe(5000000);
    expect(Number(totals.ledgerIqd)).toBe(-4900000);
    expect(totals.ties).toBe(true);
  });

  it('applies the advance to a real invoice later, through the receipt’s own allocation', async () => {
    const invoice = await sell('100000');
    const receipt = await receive('5000000');
    await as(manager, (tx) =>
      credits.apply(tx, manager, {
        source: { kind: 'receipt', id: receipt.id },
        target: { kind: 'invoice', id: invoice.id },
        amountIqd: iqd('100000'),
      }),
    );
    expect((await itemOf(invoice.invoiceNo)).status).toBe('settled');
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from customer_receipt_allocation where customer_receipt_id = $1`,
      [receipt.id],
    );
    expect(rows[0].n).toBe(1);
    const register = await as(manager, (tx) => credits.register(tx, { customerId }));
    expect(Number(register[0]!.unappliedIqd)).toBe(4900000);
  });

  it('an overpayment leaves the difference as unapplied credit', async () => {
    const invoice = await sell('100000');
    const receipt = await receive('120000');
    await allocate(receipt.id, invoice.id, '100000');
    const register = await as(manager, (tx) => credits.register(tx, { customerId }));
    expect(Number(register[0]!.unappliedIqd)).toBe(20000);
    expect(Number((await tie()).unappliedCreditsIqd)).toBe(20000);
  });

  it('refuses to apply more than the credit holds, or one customer’s credit to another’s invoice', async () => {
    const invoice = await sell('100000');
    const other = await sell('50000', { customer: otherCustomerId });
    const receipt = await receive('30000');
    await expect(
      as(manager, (tx) =>
        credits.apply(tx, manager, {
          source: { kind: 'receipt', id: receipt.id },
          target: { kind: 'invoice', id: invoice.id },
          amountIqd: iqd('40000'),
        }),
      ),
    ).rejects.toThrow(/left to apply/);
    await expect(
      as(manager, (tx) =>
        credits.apply(tx, manager, {
          source: { kind: 'receipt', id: receipt.id },
          target: { kind: 'invoice', id: other.id },
          amountIqd: iqd('10000'),
        }),
      ),
    ).rejects.toThrow(/different customers/);
  });
});

describe('§14 · ageing and lateness', () => {
  it('an unpaid invoice due three days ago is three days overdue', async () => {
    const invoice = await sell('100000', { invoiceDate: '2026-09-17', dueDate: '2026-10-17' });
    const item = await itemOf(invoice.invoiceNo);
    expect(item.daysOverdue).toBe(3);
    expect(item.bucket).toBe('1-30');
  });

  it('due 1 Oct, paid 4 Oct: paid three days late — counted from the money, not the matching', async () => {
    const invoice = await sell('100000', { invoiceDate: '2026-09-01', dueDate: '2026-10-01' });
    const receipt = await receive('100000', '2026-10-04');
    await allocate(receipt.id, invoice.id, '100000');
    const item = await itemOf(invoice.invoiceNo);
    expect(item.lastPaymentDate).toBe('2026-10-04');
    expect(item.daysLateAtLastPayment).toBe(3);
    expect(item.dueDate).toBe('2026-10-01');
  });
});

describe('§14 · credit notes and debit notes', () => {
  it('a 10,000 credit note against a 100,000 invoice leaves 90,000 outstanding', async () => {
    const invoice = await sell('100000');
    const credit = await note('credit', '10000', { invoiceId: invoice.id });
    expect(credit.appliedIqd).toBe(iqd('10000'));

    const item = await itemOf(invoice.invoiceNo);
    expect(Number(item.outstandingIqd)).toBe(90000);
    expect(Number(item.creditsAppliedIqd)).toBe(10000);
    expect(item.credits.map((row) => row.documentNo)).toEqual([credit.noteNo]);
    expect(await ledger()).toBe(90000);

    const { rows } = await ownerPool.query(
      `select a.id = $2 as receivable, l.debit_iqd::numeric debit, l.credit_iqd::numeric credit
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [credit.journalEntryId, accounts.customer_receivable],
    );
    expect(rows).toEqual([
      { receivable: false, debit: '10000.0000', credit: '0.0000' },
      { receivable: true, debit: '0.0000', credit: '10000.0000' },
    ]);
  });

  it('a debit note is owed, ages from its own due date, and is settled by a receipt', async () => {
    const debit = await note('debit', '25000', { noteDate: '2026-09-01' });
    const item = await itemOf(debit.noteNo);
    expect(item.documentKind).toBe('debit_note');
    expect(item.dueDate).toBe('2026-10-01');
    expect(Number(item.outstandingIqd)).toBe(25000);
    expect(item.daysOverdue).toBe(19);
    expect(await ledger()).toBe(25000);

    const receipt = await receive('25000', '2026-10-05');
    await as(manager, (tx) =>
      credits.apply(tx, manager, {
        source: { kind: 'receipt', id: receipt.id },
        target: { kind: 'debit_note', id: debit.id },
        amountIqd: iqd('25000'),
      }),
    );
    const settled = await itemOf(debit.noteNo);
    expect(Number(settled.outstandingIqd)).toBe(0);
    expect(Number(settled.paidIqd)).toBe(25000);
    expect(settled.daysLateAtLastPayment).toBe(4);
    expect(settled.status).toBe('settled');
    expect(await ledger()).toBe(0);
    expect((await tie()).ties).toBe(true);
  });

  it('a credit note with no invoice is the customer’s credit, and can settle a debit note', async () => {
    const debit = await note('debit', '8000');
    const credit = await note('credit', '8000');
    expect(credit.appliedIqd).toBe(0n);
    const before = await as(manager, (tx) => credits.register(tx, { customerId }));
    expect(before.map((row) => row.documentNo)).toEqual([credit.noteNo]);

    await as(manager, (tx) =>
      credits.apply(tx, manager, {
        source: { kind: 'credit_note', id: credit.id },
        target: { kind: 'debit_note', id: debit.id },
        amountIqd: iqd('8000'),
      }),
    );
    expect(await as(manager, (tx) => credits.register(tx, { customerId }))).toHaveLength(0);
    expect(Number((await itemOf(debit.noteNo)).creditsAppliedIqd)).toBe(8000);
  });

  it('reverses a note nothing rests on, and refuses one that has been applied', async () => {
    const invoice = await sell('100000');
    const applied = await note('credit', '10000', { invoiceId: invoice.id });
    await expect(
      as(manager, (tx) => notes.reverse(tx, manager, applied.id, { reason: 'Raised in error' })),
    ).rejects.toThrow(/has been applied/);

    const debit = await note('debit', '5000');
    expect(await ledger()).toBe(95000);
    await as(manager, (tx) => notes.reverse(tx, manager, debit.id, { reason: 'Charged twice' }));
    expect(await ledger()).toBe(90000);
    expect((await items()).map((row) => row.invoiceNo)).not.toContain(debit.noteNo);
  });

  it('refuses a note against another customer’s invoice', async () => {
    const other = await sell('50000', { customer: otherCustomerId });
    await expect(note('credit', '1000', { invoiceId: other.id })).rejects.toThrow(/different customer/);
  });
});

describe('§14 · sales return, reconciliation', () => {
  it('a return reduces A/R, puts the stock back, and the memo is credited on the invoice', async () => {
    const invoice = await sell('100000', { quantity: '10' });
    const onHand = async () =>
      Number((await as(manager, (tx) => inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD))).onHand) / 1_000_000;
    const before = await onHand();

    const created = await as(clerk, (tx) =>
      sr.request(tx, clerk, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-09-20',
        reason: 'Two panels damaged on arrival',
        offsetKind: 'receivable',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('2') }],
      }),
    );
    const view = await as(manager, (tx) => sr.view(tx, created.id));
    await as(manager, (tx) =>
      sr.receiveGoods(tx, manager, created.id, {
        receivedOn: '2026-09-20',
        lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: qty('2') }],
      }),
    );
    await as(manager, (tx) =>
      sr.inspect(tx, manager, created.id, [
        {
          salesReturnLineId: view.lines[0]!.id,
          acceptedQuantity: qty('2'),
          disposition: 'saleable',
          destinationWarehouseCode: WAREHOUSE,
        },
      ]),
    );
    const settled = await as(manager, (tx) => sr.acceptAndSettle(tx, manager, created.id));

    expect(await onHand()).toBe(before + 2);
    const item = await itemOf(invoice.invoiceNo);
    expect(Number(item.outstandingIqd)).toBe(80000);
    expect(item.credits.map((row) => row.documentNo)).toEqual([settled.creditMemoNo]);
    expect(await ledger()).toBe(80000);
    expect((await tie()).ties).toBe(true);
  });

  it('the customer subledger equals the A/R control account', async () => {
    const invoice = await sell('100000');
    const receipt = await receive('130000');
    await allocate(receipt.id, invoice.id, '100000');
    await note('debit', '12000');
    await note('credit', '2000');
    const rows = await controlTies();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.difference), row.accountCode).toBe(0);
    }
    const control = rows.find((row) => row.accountCode.startsWith('A8RC'));
    expect(Number(control!.subledgerBalance)).toBe(100000 - 130000 + 12000 - 2000);
  });
});

describe('the pure rules', () => {
  it('counts lateness from the due date and never below zero', () => {
    expect(daysLate('2026-10-01', '2026-10-04')).toBe(3);
    expect(daysLate('2026-10-01', '2026-09-28')).toBe(0);
  });

  it('applies a credit note to its invoice only as far as the invoice still owes', () => {
    expect(creditOnPosting(10000n, 90000n)).toBe(10000n);
    expect(creditOnPosting(10000n, 4000n)).toBe(4000n);
    expect(creditOnPosting(10000n, 0n)).toBe(0n);
  });

  it('refuses a non-positive, over-credit or over-settled application', () => {
    const base = { sourceNo: 'C', targetNo: 'I', remainingIqd: 100n, outstandingIqd: 50n, sameCustomer: true };
    expect(() => assertApplicable({ ...base, amountIqd: 0n })).toThrow(/positive/);
    expect(() => assertApplicable({ ...base, amountIqd: 60n })).toThrow(/still owed/);
    expect(() => assertApplicable({ ...base, remainingIqd: 10n, amountIqd: 20n })).toThrow(/left to apply/);
    expect(() => assertApplicable({ ...base, sameCustomer: false, amountIqd: 10n })).toThrow(/different customers/);
    expect(() => assertApplicable({ ...base, amountIqd: 50n })).not.toThrow();
  });
});
