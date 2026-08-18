/**
 * Phase 06.11 test gate — A/R subledger, ageing, statements and collections.
 * §16, §22.
 *
 *   - A/R ageing ties to the G/L control account for every test period
 *   - Customer statements reconcile to A/R ageing and G/L control (§16 acc. 4)
 *   - Statements show both transaction currency and base-currency equivalent
 *   - Write-offs, refunds and credit notes require controlled approval (§16 acc. 5)
 *   - Days sales outstanding computes per the documented formula (§22, D12)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as so from '@/server/services/sales-order';
import * as pick from '@/server/services/pick-list';
import * as dn from '@/server/services/delivery-note';
import * as ar from '@/server/services/ar-invoice';
import * as receipts from '@/server/services/customer-receipt';
import * as reports from '@/server/services/ar-reports';
import * as collections from '@/server/services/ar-collections';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const LIST = 'PL-RETAIL';
const TERMS = 'NET30';
const WAREHOUSE = `WH-${BAGHDAD}`;
const CONTROL = 'A9TRADER';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let salesUser: ActorContext;
let manager: ActorContext;
let customerId: string;
let cashAccountId: string;

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

async function attachment(fileName: string, contentType = 'image/jpeg'): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into attachment
       (id, object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
        scan_status, scanned_at, uploaded_by, branch_code)
     values ($1, 'delivery_note', $2, $3, $4, 2048, $5, $6, 'clean', now(), $7, $8)`,
    [
      id,
      id,
      fileName,
      contentType,
      createHash('sha256').update(id).digest('hex'),
      `pod/${id}`,
      manager.principal.userId,
      BAGHDAD,
    ],
  );
  return id;
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

  salesUser = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into payment_terms (code, name, basis, due_days) values ($1,'Net 30','document_date',30)`,
    [TERMS],
  );
  await ownerPool.query(
    `insert into price_list (code, name, currency, active) values ($1,'Retail','IQD',true)`,
    [LIST],
  );
  const { rows: items } = await ownerPool.query(`select id from item where code = $1`, [CABLE]);
  await ownerPool.query(
    `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
     values ($1,$2,'EA',20.0000,'2026-01-01')`,
    [LIST, items[0].id],
  );

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner
       (code, legal_name, is_customer, status, active, price_list_code, credit_limit_iqd,
        payment_terms_code)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true, $1, 100000000.0000, $2)
     returning id`,
    [LIST, TERMS],
  );
  customerId = partner[0].id;

  const { rows: cash } = await ownerPool.query(
    `select id from bank_cash_account where branch_code = $1 limit 1`,
    [BAGHDAD],
  );
  cashAccountId = cash[0].id;

  // Accounts first, deduplicated: several events map to the same account, and
  // an upsert inside the rule loop returns nothing on the second pass.
  for (const [code, name, parent, control] of [
    ['A9INVENT', 'Inventory', 'A000001', null],
    ['X9COGS', 'Cost of Goods Sold', 'X000001', null],
    [CONTROL, 'Trade Receivables', 'A000001', 'customer'],
    ['R9REVENU', 'Sales Revenue', 'R000001', null],
    ['A9BANK', 'Bank Current Account', 'A000001', null],
    ['L9CLEAR', 'Customer Clearing', 'L000001', null],
    ['X9BADDBT', 'Bad Debt Expense', 'X000001', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = $1`,
      [parent],
    );
    await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1, $2,
               (select account_type from chart_of_account where code = $3),
               $4, false, true, 'approved', 1, 'IQD', $5)`,
      [code, name, parent, parents[0].id, control],
    );
  }

  for (const [event, role, code] of [
    ['inventory.delivery', 'inventory', 'A9INVENT'],
    ['inventory.delivery', 'cogs', 'X9COGS'],
    ['inventory.opening_stock', 'inventory', 'A9INVENT'],
    ['inventory.opening_stock', 'cogs', 'X9COGS'],
    ['sales.ar_invoice', 'customer_receivable', CONTROL],
    ['sales.ar_invoice', 'sales_revenue', 'R9REVENU'],
    ['sales.customer_receipt', 'bank_cash', 'A9BANK'],
    ['sales.customer_receipt', 'customer_receivable', CONTROL],
    ['sales.customer_receipt', 'customer_clearing', 'L9CLEAR'],
    ['sales.ar_write_off', 'bad_debt_expense', 'X9BADDBT'],
    ['sales.ar_write_off', 'customer_receivable', CONTROL],
  ] as const) {
    const { rows: account } = await ownerPool.query(
      `select id from chart_of_account where code = $1`,
      [code],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ($1, $2, $3, true, $4)
       on conflict do nothing`,
      [event, role, account[0].id, manager.principal.userId],
    );
  }

  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('SALES','Sales',false)
     on conflict (code) do nothing`,
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1000.00000000,'2026-01-01',$1)
     on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: years } = await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on)
     values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31') returning id`,
  );
  for (const [no, name, from, to] of [
    [1, 'January 2026', '2026-01-01', '2026-01-31'],
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
    [4, 'April 2026', '2026-04-01', '2026-04-30'],
    [5, 'May 2026', '2026-05-01', '2026-05-31'],
    [6, 'June 2026', '2026-06-01', '2026-06-30'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1, $2, $3, $4, $5)`,
      [years[0].id, no, name, from, to],
    );
  }

  await withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: CABLE,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity: qty('10000'),
      unitCostIqd: price('6'),
      movementDate: '2026-01-05',
      kind: 'opening_stock',
      batchNumber: 'B-1',
    }),
  );
});

/** A posted invoice dated `on`, for `quantity` at the list's 20 each. */
async function invoiceOn(on: string, quantity: bigint) {
  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      orderDate: on,
      departmentCode: 'SALES',
      businessLineCode: 'PRODUCT_SALES',
      lines: [
        { itemCode: CABLE, quantity, uomCode: 'EA', warehouseCode: WAREHOUSE, branchCode: BAGHDAD },
      ],
    }),
  );
  await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));

  const outstanding = await withScope(scope(manager), (tx) =>
    pick.outstandingFor(tx, order.id, WAREHOUSE),
  );
  const sheet = await withScope(scope(manager), (tx) =>
    pick.create(tx, manager, {
      salesOrderId: order.id,
      warehouseCode: WAREHOUSE,
      pickDate: on,
      lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity }],
    }),
  );
  await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));
  const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
  await withScope(scope(manager), (tx) =>
    pick.pick(tx, manager, sheet.id, [
      {
        pickListLineId: view.lines[0]!.id,
        quantity,
        units: [{ batchNumber: 'B-1', quantity }],
      },
    ]),
  );

  const note = await withScope(scope(manager), (tx) =>
    dn.create(tx, manager, { pickListId: sheet.id, deliveryDate: on }),
  );
  await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));
  const signature = await attachment('signature.png', 'image/png');
  const photo = await attachment('van.jpg');
  await withScope(scope(manager), (tx) =>
    dn.recordProofOfDelivery(tx, manager, note.id, {
      recipientName: 'Ahmed Kareem',
      signatureAttachmentId: signature,
      photoAttachmentIds: [photo],
      receivedAt: new Date(`${on}T09:30:00Z`),
    }),
  );
  await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));

  const invoice = await withScope(scope(salesUser), (tx) =>
    ar.create(tx, salesUser, { deliveryNoteId: note.id }),
  );
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));

  return invoice;
}

// ---------------------------------------------------------------------------

describe('06.11 gate · the ageing ties to the G/L control account (§16, §22)', () => {
  it('agrees across ageing, subledger and control for every period', async () => {
    await invoiceOn('2026-01-10', qty('50')); // 1,000, due 9 Feb
    await invoiceOn('2026-03-10', qty('30')); // 600, due 9 Apr
    await invoiceOn('2026-05-10', qty('20')); // 400, due 9 Jun

    for (const asOf of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      const result = await withScope(scope(manager), (tx) =>
        reports.reconcile(tx, manager.principal, asOf, CONTROL),
      );

      // The three are the same open items looked at three ways, so the gate is
      // that they agree — and the difference is reported either way, because a
      // reconciliation nobody can debug is not a reconciliation.
      expect(result.ageingVsSubledgerIqd, asOf).toBe('0.0000');
      expect(result.subledgerVsControlIqd, asOf).toBe('0.0000');
      expect(result.reconciles, asOf).toBe(true);
    }
  });

  it('still ties after a receipt has settled part of it', async () => {
    const first = await invoiceOn('2026-01-10', qty('50'));
    await invoiceOn('2026-03-10', qty('30'));

    const receipt = await withScope(scope(manager), (tx) =>
      receipts.create(tx, manager, {
        customerId,
        branchCode: BAGHDAD,
        receiptDate: '2026-04-01',
        bankCashAccountId: cashAccountId,
        amountIqd: price('600'),
      }),
    );
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, receipt.id, [
        { arInvoiceId: first.id, amountIqd: price('600') },
      ]),
    );

    const result = await withScope(scope(manager), (tx) =>
      reports.reconcile(tx, manager.principal, '2026-04-30', CONTROL),
    );

    expect(result.reconciles).toBe(true);
    // 1,000 + 600 invoiced, 600 received.
    expect(result.ageingTotalIqd).toBe('1000.0000');
  });

  it('buckets by the due date, not the invoice date', async () => {
    // Invoiced 10 January on 30-day terms, so due 9 February. On 20 February it
    // is 11 days overdue — 1–30, not 31–60 as an invoice-date ageing would say.
    await invoiceOn('2026-01-10', qty('50'));

    const rows = await withScope(scope(manager), (tx) =>
      reports.ageing(tx, manager.principal, '2026-02-20'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.days1to30).toBe('1000.0000');
    expect(rows[0]!.days31to60).toBe('0.0000');
    expect(rows[0]!.total).toBe('1000.0000');
  });

  it('treats the day an invoice falls due as current', async () => {
    await invoiceOn('2026-01-10', qty('50')); // due 2026-02-09

    const onDue = await withScope(scope(manager), (tx) =>
      reports.ageing(tx, manager.principal, '2026-02-09'),
    );
    expect(onDue[0]!.current).toBe('1000.0000');

    const dayAfter = await withScope(scope(manager), (tx) =>
      reports.ageing(tx, manager.principal, '2026-02-10'),
    );
    expect(dayAfter[0]!.current).toBe('0.0000');
    expect(dayAfter[0]!.days1to30).toBe('1000.0000');
  });
});

// ---------------------------------------------------------------------------

describe('06.11 gate · statements reconcile and show both currencies (§16)', () => {
  it('reconciles the statement to the ageing and the control account', async () => {
    await invoiceOn('2026-01-10', qty('50'));
    await invoiceOn('2026-03-10', qty('30'));

    const lines = await withScope(scope(manager), (tx) =>
      reports.statement(tx, manager.principal, 'CUST-001', {
        from: '2026-01-01',
        to: '2026-05-31',
      }),
    );

    const closing = parseDecimal(lines[lines.length - 1]!.runningBalanceIqd, 4n);

    const reconciliation = await withScope(scope(manager), (tx) =>
      reports.reconcile(tx, manager.principal, '2026-05-31', CONTROL),
    );

    // §16 acceptance 4 — the statement's closing balance, the ageing total and
    // the control account are one number seen three ways.
    expect(closing).toBe(parseDecimal(reconciliation.ageingTotalIqd, 4n));
    expect(closing).toBe(parseDecimal(reconciliation.controlAccountIqd, 4n));
  });

  it('shows the transaction currency and the base-currency equivalent', async () => {
    await invoiceOn('2026-01-10', qty('50'));

    const lines = await withScope(scope(manager), (tx) =>
      reports.statement(tx, manager.principal, 'CUST-001', {
        from: '2026-01-01',
        to: '2026-01-31',
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]!.currency).toBe('IQD');
    expect(lines[0]!.amountIqd).toBe('1000.0000');
    // The USD equivalent at the historical rate the journal recorded — 1,000
    // IQD per USD in this fixture — never a conversion done at report time.
    expect(Number(lines[0]!.amountUsd)).toBe(1);
  });

  it('shows receipts as credits and keeps a running balance', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    const receipt = await withScope(scope(manager), (tx) =>
      receipts.create(tx, manager, {
        customerId,
        branchCode: BAGHDAD,
        receiptDate: '2026-01-20',
        bankCashAccountId: cashAccountId,
        amountIqd: price('400'),
      }),
    );
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, receipt.id, [
        { arInvoiceId: invoice.id, amountIqd: price('400') },
      ]),
    );

    const lines = await withScope(scope(manager), (tx) =>
      reports.statement(tx, manager.principal, 'CUST-001', {
        from: '2026-01-01',
        to: '2026-01-31',
      }),
    );

    expect(lines.map((l) => l.documentType)).toEqual(['ar_invoice', 'customer_receipt']);
    expect(lines[0]!.runningBalanceIqd).toBe('1000.0000');
    expect(lines[1]!.amountIqd).toBe('-400.0000');
    expect(lines[1]!.runningBalanceIqd).toBe('600.0000');
  });
});

// ---------------------------------------------------------------------------

describe('06.11 gate · write-offs require controlled approval (§16 acc. 5)', () => {
  it('needs the higher approval above the threshold — which defaults to zero', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    const writeOff = await withScope(scope(manager), (tx) =>
      collections.create(tx, manager, {
        arInvoiceId: invoice.id,
        writeOffDate: '2026-06-01',
        amountIqd: price('1000'),
        reasonCode: 'UNCOLLECTABLE',
      }),
    );

    // Zero threshold puts everything above the line, which is the safe reading
    // of a figure Finance has not set (D12).
    expect(writeOff.aboveThreshold).toBe(true);

    // An officer holds `approve` on nothing here; the manager holds `configure`.
    expect(
      await rejection(
        withScope(scope(salesUser), (tx) => collections.approve(tx, salesUser, writeOff.id)),
      ),
    ).toMatch(/is not granted/);

    await withScope(scope(manager), (tx) => collections.approve(tx, manager, writeOff.id));
  });

  it('records the threshold that was in force, not today’s', async () => {
    await ownerPool.query(
      `update ar_write_off_policy set threshold_iqd = 5000 where branch_code is null`,
    );

    const invoice = await invoiceOn('2026-01-10', qty('50'));
    const writeOff = await withScope(scope(manager), (tx) =>
      collections.create(tx, manager, {
        arInvoiceId: invoice.id,
        writeOffDate: '2026-06-01',
        amountIqd: price('1000'),
        reasonCode: 'SMALL_BALANCE',
      }),
    );

    expect(writeOff.aboveThreshold).toBe(false);

    // Finance tightens the policy afterwards.
    await ownerPool.query(
      `update ar_write_off_policy set threshold_iqd = 100 where branch_code is null`,
    );

    const { rows } = await ownerPool.query(
      `select threshold_at_approval_iqd, above_threshold from ar_write_off where id = $1`,
      [writeOff.id],
    );

    // "What rule was this approved under?" has an answer.
    expect(rows[0].threshold_at_approval_iqd).toBe('5000.0000');
    expect(rows[0].above_threshold).toBe(false);
  });

  it('insists on a reason code from the configured list (§16)', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          collections.create(tx, manager, {
            arInvoiceId: invoice.id,
            writeOffDate: '2026-06-01',
            amountIqd: price('1000'),
            reasonCode: 'BECAUSE-I-SAID-SO',
          }),
        ),
      ),
    ).toMatch(/is not an active write-off reason/);
  });

  it('cannot forgive more than is owed', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          collections.create(tx, manager, {
            arInvoiceId: invoice.id,
            writeOffDate: '2026-06-01',
            amountIqd: price('2000'),
            reasonCode: 'UNCOLLECTABLE',
          }),
        ),
      ),
    ).toMatch(/more than the .* still owed/);
  });

  it('posts Dr Bad Debt Expense / Cr Customer A/R and closes the invoice', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    const writeOff = await withScope(scope(manager), (tx) =>
      collections.create(tx, manager, {
        arInvoiceId: invoice.id,
        writeOffDate: '2026-06-01',
        amountIqd: price('1000'),
        reasonCode: 'UNCOLLECTABLE',
      }),
    );
    await withScope(scope(manager), (tx) => collections.approve(tx, manager, writeOff.id));
    const posted = await withScope(scope(manager), (tx) =>
      collections.post(tx, manager, writeOff.id),
    );

    const { rows } = await ownerPool.query(
      `select a.name, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [posted.journalEntryId],
    );

    expect(rows[0].name).toBe('Bad Debt Expense');
    expect(Number(rows[0].debit_iqd)).toBe(1000);
    expect(rows[1].name).toBe('Trade Receivables');
    expect(Number(rows[1].credit_iqd)).toBe(1000);

    // The debt is gone, so it leaves the ageing — and the reconciliation still
    // ties, because the write-off moved the control account too.
    const ageing = await withScope(scope(manager), (tx) =>
      reports.ageing(tx, manager.principal, '2026-06-30'),
    );
    expect(ageing).toEqual([]);

    const reconciliation = await withScope(scope(manager), (tx) =>
      reports.reconcile(tx, manager.principal, '2026-06-30', CONTROL),
    );
    expect(reconciliation.reconciles).toBe(true);
  });

  it('refuses a write-off beyond the balance written straight to the table (§7.7)', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    expect(
      await rejection(
        ownerPool.query(
          `insert into ar_write_off
             (write_off_no, ar_invoice_id, customer_id, branch_code, write_off_date,
              amount_iqd, reason_code, created_by)
           values ('WOF-FORGED', $1, $2, $3, '2026-06-01', 9999, 'UNCOLLECTABLE', $4)`,
          [invoice.id, customerId, BAGHDAD, manager.principal.userId],
        ),
      ),
    ).toMatch(/more than the .* still owed/);
  });
});

// ---------------------------------------------------------------------------

describe('06.11 gate · DSO computes per the documented formula (§22, D12)', () => {
  it('computes over a stated period from A/R and credit sales', async () => {
    // 1,000 invoiced in January, nothing paid. April: closing A/R 1,000,
    // April credit sales 600, April is 30 days → 50 days.
    await invoiceOn('2026-01-10', qty('50'));
    await invoiceOn('2026-04-10', qty('30'));

    const result = await withScope(scope(manager), (tx) =>
      reports.daysSalesOutstandingFor(tx, manager.principal, {
        from: '2026-04-01',
        to: '2026-04-30',
      }),
    );

    expect(result.closingReceivableIqd).toBe('1600.0000');
    expect(result.creditSalesIqd).toBe('600.0000');
    expect(result.days).toBe('80');
  });

  it('reports that a period with no credit sales has no answer', async () => {
    await invoiceOn('2026-01-10', qty('50'));

    const result = await withScope(scope(manager), (tx) =>
      reports.daysSalesOutstandingFor(tx, manager.principal, {
        from: '2026-05-01',
        to: '2026-05-31',
      }),
    );

    // Zero days would say the company collects instantly — the opposite of what
    // an empty period means. So it says nothing, and says why.
    expect(result.days).toBeNull();
    expect(result.note).toMatch(/no credit sales/);
  });
});

// ---------------------------------------------------------------------------

describe('06.11 · the collections worklist (§16)', () => {
  it('lists overdue items oldest first, with any promise against them', async () => {
    const older = await invoiceOn('2026-01-10', qty('50')); // due 9 Feb
    await invoiceOn('2026-03-10', qty('30')); // due 9 Apr

    await withScope(scope(manager), (tx) =>
      collections.recordPromise(tx, manager, {
        customerId,
        arInvoiceId: older.id,
        branchCode: BAGHDAD,
        promisedOn: '2026-05-15',
        amountIqd: price('1000'),
        promisedBy: 'Mr Kareem, accounts',
      }),
    );

    const worklist = await withScope(scope(manager), (tx) =>
      reports.collectionsWorklist(tx, manager.principal, '2026-05-01'),
    );

    expect(worklist).toHaveLength(2);
    expect(worklist[0]!.invoiceNo).toBe(
      (await withScope(scope(manager), (tx) => ar.view(tx, older.id))).invoiceNo,
    );
    expect(Number(worklist[0]!.daysOverdue)).toBe(81);
    expect(worklist[0]!.promisedOn).toBe('2026-05-15');
  });

  it('keeps the collections history — a call log that can be edited proves nothing (§5.4)', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    const activity = await withScope(scope(manager), (tx) =>
      collections.recordActivity(tx, manager, {
        customerId,
        arInvoiceId: invoice.id,
        branchCode: BAGHDAD,
        occurredOn: '2026-03-01',
        activityKind: 'call',
        note: 'Spoke to accounts; invoice is with their finance director.',
      }),
    );

    expect(
      await rejection(
        ownerPool.query(`update collection_activity set note = 'Nobody called' where id = $1`, [
          activity.id,
        ]),
      ),
    ).toMatch(/append-only/);

    expect(
      await rejection(
        ownerPool.query(`delete from collection_activity where id = $1`, [activity.id]),
      ),
    ).toMatch(/append-only/);
  });

  it('records a promise kept and a promise broken, because the ratio is the point', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50'));

    const kept = await withScope(scope(manager), (tx) =>
      collections.recordPromise(tx, manager, {
        customerId,
        arInvoiceId: invoice.id,
        branchCode: BAGHDAD,
        promisedOn: '2026-03-01',
        amountIqd: price('500'),
      }),
    );
    const broken = await withScope(scope(manager), (tx) =>
      collections.recordPromise(tx, manager, {
        customerId,
        arInvoiceId: invoice.id,
        branchCode: BAGHDAD,
        promisedOn: '2026-04-01',
        amountIqd: price('500'),
      }),
    );

    await withScope(scope(manager), (tx) =>
      collections.resolvePromise(tx, manager, kept.id, 'kept', 'Paid on the day'),
    );
    await withScope(scope(manager), (tx) =>
      collections.resolvePromise(tx, manager, broken.id, 'broken', 'No payment received'),
    );

    const history = await withScope(scope(manager), (tx) =>
      collections.historyFor(tx, customerId),
    );

    expect(history.promises.map((p) => p.status).sort()).toEqual(['broken', 'kept']);
  });

  it('expects cash on the promised date rather than the due date (§16)', async () => {
    const invoice = await invoiceOn('2026-01-10', qty('50')); // due 9 Feb

    await withScope(scope(manager), (tx) =>
      collections.recordPromise(tx, manager, {
        customerId,
        arInvoiceId: invoice.id,
        branchCode: BAGHDAD,
        promisedOn: '2026-05-15',
        amountIqd: price('1000'),
      }),
    );

    const expected = await withScope(scope(manager), (tx) =>
      collections.expectedCollection(tx, manager, '2026-05-01', '2026-05-31'),
    );

    // A customer who has said they will pay on the 15th is better information
    // than a due date that has already passed.
    expect(expected).toHaveLength(1);
    expect(expected[0]!.expectedOn).toBe('2026-05-15');
    expect(expected[0]!.fromPromise).toBe(true);
  });
});
