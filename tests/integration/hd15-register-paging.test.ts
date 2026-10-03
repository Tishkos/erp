/**
 * REQ-HARDEN-001 G5 / HD15 — every register pages at 50 with a true count.
 *
 * For each of the eight registers that used to stop silently at 200 rows or
 * read every row and filter in JavaScript: 55 documents are written straight
 * into the table (the documents' own life cycles are covered by their own
 * suites; this one is about the read), then
 *
 *   · page 1 holds 50 rows and the total is the true 55,
 *   · page 2 holds the other 5, none of them on page 1,
 *   · a page past the end is the last page,
 *   · the screen's filter (status, view, search) narrows the rows and the
 *     total together — the count is over the filtered set, not the table.
 *
 * Every read runs as the application role through the services' own screen
 * reads, so RLS and the SQL predicates are the ones the screens use.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as contracts from '@/server/services/recurring-contracts';
import * as customs from '@/server/services/customs-pd';
import * as goodsReceipts from '@/server/services/goods-receipt';
import * as loans from '@/server/services/loans';
import * as orders from '@/server/services/purchase-order';
import * as serviceReceipts from '@/server/services/service-receipt';
import * as shipments from '@/server/services/shipments';
import { REGISTER_PAGE_SIZE, type RegisterPage } from '@/server/services/register-page';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const N = 55;
const SWIFT = 'PM-HD15';

let world: TradingWorld;
let payableId: string;
let userId: string;

const read = <T>(fn: (tx: Tx) => Promise<T>) =>
  withScope(scope(world.manager), fn);

/** Page 1, page 2 and a page past the end, held to the true count. */
async function pagesOf<T extends { id: string }>(
  fetch: (page: number) => Promise<RegisterPage<T>>,
  total: number,
): Promise<void> {
  const first = await fetch(1);
  expect(first.pageSize).toBe(REGISTER_PAGE_SIZE);
  expect(first.total).toBe(total);
  expect(first.pages).toBe(Math.ceil(total / REGISTER_PAGE_SIZE));
  expect(first.rows).toHaveLength(Math.min(total, REGISTER_PAGE_SIZE));

  const second = await fetch(2);
  expect(second.page).toBe(2);
  expect(second.total).toBe(total);
  expect(second.rows).toHaveLength(total - REGISTER_PAGE_SIZE);

  const seen = new Set(first.rows.map((row) => row.id));
  for (const row of second.rows) expect(seen.has(row.id)).toBe(false);

  const past = await fetch(99);
  expect(past.page).toBe(first.pages);
  expect(past.rows.map((row) => row.id)).toEqual(second.rows.map((row) => row.id));
}

beforeAll(async () => {
  world = await buildTradingWorld();
  userId = world.manager.principal.userId;
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'HD15-0001',
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity('10'),
          unitPriceIqd: parseDecimal('10000', 4n),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  payableId = rows[0].payable_id;
}, 120_000);

describe('HD15 · purchase orders', () => {
  it('pages at 50 with the true count, and the status filter narrows both', async () => {
    // 30 approved, 25 drafts.
    await ownerPool.query(
      `insert into purchase_order (order_no, supplier_id, branch_code, order_date, created_by, status)
       select 'PO-HD15-' || lpad(g::text, 4, '0'), $1, $2, '2026-09-01', $3,
              (case when g <= 30 then 'approved' else 'draft' end)::document_status
         from generate_series(1, $4::int) g`,
      [world.supplierId, BAGHDAD, userId, N],
    );
    const { rows } = await ownerPool.query(`select count(*)::int as n from purchase_order`);
    const total = rows[0].n as number;
    expect(total).toBeGreaterThanOrEqual(N);
    await pagesOf((page) => read((tx) => orders.listForScreen(tx, { page })), total);

    const drafts = await read((tx) => orders.listForScreen(tx, { status: 'draft' }));
    const { rows: draftCount } = await ownerPool.query(
      `select count(*)::int as n from purchase_order where status = 'draft'`,
    );
    expect(drafts.total).toBe(draftCount[0].n);
    expect(drafts.total).toBeLessThan(total);
    expect(drafts.rows.every((row) => row.status === 'draft')).toBe(true);
  });
});

describe('HD15 · goods receipts', () => {
  it('pages at 50 with the true count, and the status filter narrows both', async () => {
    const { rows: order } = await ownerPool.query(
      `insert into purchase_order (order_no, supplier_id, branch_code, order_date, created_by, status)
       values ('PO-HD15-GRN', $1, $2, '2026-09-01', $3, 'approved') returning id`,
      [world.supplierId, BAGHDAD, userId],
    );
    await ownerPool.query(
      `insert into goods_receipt (receipt_no, purchase_order_id, branch_code, receipt_date, created_by, status)
       select 'GRN-HD15-' || lpad(g::text, 4, '0'), $1, $2, '2026-09-02', $3,
              (case when g <= 15 then 'submitted' else 'draft' end)::document_status
         from generate_series(1, $4::int) g`,
      [order[0].id, BAGHDAD, userId, N],
    );
    await pagesOf((page) => read((tx) => goodsReceipts.listForScreen(tx, { page })), N);

    const submitted = await read((tx) => goodsReceipts.listForScreen(tx, { status: 'submitted' }));
    expect(submitted.total).toBe(15);
    expect(submitted.rows).toHaveLength(15);
    expect(submitted.rows.every((row) => row.status === 'submitted')).toBe(true);
  });
});

describe('HD15 · service receipts', () => {
  it('pages at 50 with the true count, and the inbox (submitted) is counted on its own', async () => {
    await ownerPool.query(
      `insert into service_receipt (receipt_no, payable_id, department_code, branch_code, service_date, created_by, status)
       select 'SRV-HD15-' || lpad(g::text, 4, '0'), $1, 'FIN', $2, '2026-09-03', $3,
              (case when g <= 20 then 'submitted' else 'draft' end)::document_status
         from generate_series(1, $4::int) g`,
      [payableId, BAGHDAD, userId, N],
    );
    await pagesOf((page) => read((tx) => serviceReceipts.listForScreen(tx, { page })), N);

    const inbox = await read((tx) => serviceReceipts.listForScreen(tx, { status: 'submitted' }));
    expect(inbox.total).toBe(20);
    expect(inbox.pages).toBe(1);
    expect(inbox.rows.every((row) => row.status === 'submitted')).toBe(true);
  });
});

describe('HD15 · recurring contracts', () => {
  it('pages at 50 by contract number with the true count, and the status filter narrows both', async () => {
    await ownerPool.query(
      `insert into recurring_contract (contract_no, supplier_id, department_code, branch_code, expense_category_code,
          description, currency, amount_per_period_txn, frequency, start_date, created_by, status)
       select 'RC-HD15-' || lpad(g::text, 4, '0'), $1, 'FIN', $2, 'rent', 'Office rent', 'IQD', 1000000,
              'monthly', '2026-01-01', $3, case when g <= 15 then 'active' else 'draft' end
         from generate_series(1, $4::int) g`,
      [world.supplierId, BAGHDAD, userId, N],
    );
    await pagesOf((page) => read((tx) => contracts.listForScreen(tx, { page })), N);

    const first = await read((tx) => contracts.listForScreen(tx, { page: 1 }));
    expect(first.rows[0]!.contractNo).toBe('RC-HD15-0001');
    expect(first.rows[49]!.contractNo).toBe('RC-HD15-0050');
    expect(first.rows[0]!.amountPerPeriodTxn).toBe('1000000.0000');

    const active = await read((tx) => contracts.listForScreen(tx, { status: 'active' }));
    expect(active.total).toBe(15);
    expect(active.rows.every((row) => row.status === 'active')).toBe(true);
  });
});

describe('HD15 · PDs', () => {
  it('pages at 50 with the true count; the view and the search are in the query', async () => {
    // 40 against the import, 15 holding (no import yet).
    await ownerPool.query(
      `insert into customs_pd (pd_no, payable_id, branch_code, registration_date, expiry_date, status_date, created_by)
       select 'HD15' || lpad(g::text, 4, '0'), case when g <= 40 then $1::uuid end, $2,
              '2026-09-01', date '2026-10-01' + g, '2026-09-01', $3
         from generate_series(1, $4::int) g`,
      [payableId, BAGHDAD, userId, N],
    );
    await pagesOf((page) => read((tx) => customs.listForScreen(tx, { view: 'all', page })), N);
    await pagesOf((page) => read((tx) => customs.listForScreen(tx, { view: 'live', page })), N);

    // The soonest to expire first.
    const first = await read((tx) => customs.listForScreen(tx, { view: 'all' }));
    expect(first.rows[0]!.pdNo).toBe('HD150001');

    const holding = await read((tx) => customs.listForScreen(tx, { view: 'holding' }));
    expect(holding.total).toBe(15);
    expect(holding.rows.every((row) => row.payableNo === null)).toBe(true);
    const final = await read((tx) => customs.listForScreen(tx, { view: 'final' }));
    expect(final.total).toBe(0);

    const searched = await read((tx) => customs.listForScreen(tx, { view: 'all', search: 'hd15001' }));
    expect(searched.total).toBe(10); // HD150010 … HD150019
    expect(searched.rows).toHaveLength(10);
    const literal = await read((tx) => customs.listForScreen(tx, { view: 'all', search: '%' }));
    expect(literal.total).toBe(0);

    // The unpaged read the payable page uses still returns the import's PDs.
    const own = await read((tx) => customs.list(tx, { payableId, view: 'all' }));
    expect(own).toHaveLength(40);
  });
});

describe('HD15 · bank loans', () => {
  it('pages at 50 with the true count; the view and the search are in the query', async () => {
    // 52 drafts (open), 3 cancelled (closed).
    await ownerPool.query(
      `insert into bank_loan (loan_no, bank_code, bank_cash_account_id, branch_code, currency, principal_txn, principal_iqd,
          commission_treatment_code, net_proceeds_txn, instalment_count, frequency, first_due_date, created_by,
          status, closed_reason)
       select 'LN-HD15-' || lpad(g::text, 4, '0'), 'BNK-0002', $1, $2, 'IQD', 1000000, 1000000,
              'paid_separately', 1000000, 1, 'monthly', '2026-12-01', $3,
              case when g <= 52 then 'draft' else 'cancelled' end,
              case when g <= 52 then null else 'Withdrawn' end
         from generate_series(1, $4::int) g`,
      [world.bankAccountId, BAGHDAD, userId, N],
    );
    await pagesOf((page) => read((tx) => loans.listForScreen(tx, { view: 'all', page })), N);
    await pagesOf((page) => read((tx) => loans.listForScreen(tx, { view: 'open', page })), 52);

    const closed = await read((tx) => loans.listForScreen(tx, { view: 'closed' }));
    expect(closed.total).toBe(3);
    expect(closed.rows.every((row) => row.status === 'cancelled' && row.outstandingTxn === '0.0000')).toBe(true);
    const overdue = await read((tx) => loans.listForScreen(tx, { view: 'overdue' }));
    expect(overdue.total).toBe(0);

    const searched = await read((tx) => loans.listForScreen(tx, { view: 'all', search: 'LN-HD15-005' }));
    expect(searched.total).toBe(6); // 0050 … 0055
    expect(searched.rows).toHaveLength(6);
  });
});

describe('HD15 · payment applications', () => {
  it('pages at 50 with the true count, longest-waiting first; the view and the search are in the query', async () => {
    await ownerPool.query(
      `insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`,
      [SWIFT],
    );
    // 40 drafts, 12 approved, 3 sent on different days.
    await ownerPool.query(
      `insert into payment_application (application_no, payable_id, branch_code, supplier_id, payment_method_code,
          bank_cash_account_id, currency, amount_txn, amount_iqd, created_by, status, application_date)
       select 'PA-HD15-' || lpad(g::text, 4, '0'), $1, $2, $3, $4, $5, 'IQD', 1000, 1000, $6,
              case when g <= 40 then 'draft' when g <= 52 then 'approved' else 'sent' end,
              case g when 53 then date '2026-09-10' when 54 then date '2026-09-01' when 55 then date '2026-09-05' end
         from generate_series(1, $7::int) g`,
      [payableId, BAGHDAD, world.supplierId, SWIFT, world.bankAccountId, userId, N],
    );
    await pagesOf((page) => read((tx) => applications.listForScreen(tx, { page })), N);

    // §21.7 — the longest-waiting SWIFT first, as the in-memory sort had it.
    const first = await read((tx) => applications.listForScreen(tx, { page: 1 }));
    expect(first.rows.slice(0, 3).map((row) => row.applicationNo)).toEqual([
      'PA-HD15-0054',
      'PA-HD15-0055',
      'PA-HD15-0053',
    ]);
    expect(first.rows[0]!.daysWaiting).toBeGreaterThan(first.rows[1]!.daysWaiting!);
    expect(first.rows[3]!.daysWaiting).toBeNull();

    const toSend = await read((tx) => applications.listForScreen(tx, { statuses: ['approved'] }));
    expect(toSend.total).toBe(12);
    expect(toSend.rows.every((row) => row.status === 'approved')).toBe(true);

    const searched = await read((tx) => applications.listForScreen(tx, { search: 'pa-hd15-002' }));
    expect(searched.total).toBe(10);

    // The unpaged read the payable page uses still returns every application of the import.
    const own = await read((tx) => applications.list(tx, { payableId }));
    expect(own).toHaveLength(N);
  });
});

describe('HD15 · shipments (B/Ls)', () => {
  it('pages at 50 with the true count, newest first; the search is in the query', async () => {
    await ownerPool.query(
      `insert into bill_of_lading (payable_id, branch_code, bl_no, bl_date, created_by)
       select $1, $2, 'BL-HD15-' || lpad(g::text, 4, '0'), date '2026-08-01' + g, $3
         from generate_series(1, $4::int) g`,
      [payableId, BAGHDAD, userId, N],
    );
    await pagesOf((page) => read((tx) => shipments.listBlsForScreen(tx, { page })), N);

    const first = await read((tx) => shipments.listBlsForScreen(tx, { page: 1 }));
    expect(first.rows[0]!.blNo).toBe('BL-HD15-0055');

    const searched = await read((tx) => shipments.listBlsForScreen(tx, { search: 'BL-HD15-001' }));
    expect(searched.total).toBe(10);
    expect(searched.rows).toHaveLength(10);

    // The import's own read is unpaged.
    const own = await read((tx) => shipments.listBls(tx, { payableId }));
    expect(own).toHaveLength(N);
  });
});
