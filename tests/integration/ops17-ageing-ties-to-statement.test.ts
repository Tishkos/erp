/**
 * The ageing and the statement must agree — both sides, always.
 *
 * The sponsor found them disagreeing about one customer: the statement said
 * 700,000 was owed and Receivables Ageing showed nothing outstanding. Neither
 * report was lying. They were reading different things:
 *
 *   the statement   reads `subledger_entry`, written beside every journal
 *   the ageing      read `ar_invoice`, the document layer
 *
 * so anything reaching a control account without an invoice behind it — an
 * opening balance, a write-off, a correction, or a receipt whose credit was
 * mapped to the wrong account — appeared on one and not the other. Two
 * authoritative-looking screens, no way to tell which to believe.
 *
 * What is asserted here is the identity that makes them one report:
 *
 *     ledger balance  =  what the open invoices account for
 *                     +  what nothing accounts for
 *
 * The right-hand side is what the ageing now shows and totals. So the ageing's
 * total *is* the statement's closing balance, by construction, and a gap
 * between them is a visible row rather than a silent difference.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as journal from '@/server/services/journal';
import * as openItems from '@/server/services/open-items';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import * as statement from '@/server/services/partner-statement';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const AS_OF = '2026-09-30';
const WINDOW = { from: '2026-01-01', to: '2026-12-31' } as const;

let manager: ActorContext;
let approver: ActorContext;
let bank: string;
let receivables: string;
let payables: string;
let revenue: string;
let expense: string;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Accounting Manager',
  ]);
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
    [id],
  );
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function account(
  rootCode: string,
  name: string,
  controlAccount?: 'customer' | 'supplier',
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    rootCode,
  ]);
  const made = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, {
      name,
      currencyRestriction: 'IQD',
      parentId: rows[0].id,
      ...(controlAccount ? { controlAccount } : {}),
    }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, made.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, made.id));
  return made.id;
}

async function partner(code: string, name: string, side: 'customer' | 'supplier') {
  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status)
     values ($1, $2, $3, $4, 'active') returning id`,
    [code, name, side === 'customer', side === 'supplier'],
  );
  return { code, id: rows[0].id as string };
}

/** One posted journal, with the party named on whichever line needs it. */
async function post(
  on: string,
  description: string,
  lines: Array<{ account: string; debit?: string; credit?: string; party?: string }>,
) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: on,
      postingDate: on,
      description,
    }),
  );
  for (const line of lines) {
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: line.account,
        ...(line.debit ? { debit: line.debit } : {}),
        ...(line.credit ? { credit: line.credit } : {}),
        dimensions: {
          department: 'FIN',
          ...(line.party ? { business_partner: line.party } : {}),
        },
      } as never),
    );
  }
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  return entry;
}

/**
 * An invoice row in the document layer.
 *
 * Inserted rather than driven through the sales pipeline on purpose: what is
 * under test is the arithmetic tying two reports together, not the pipeline,
 * which has its own suites. The journal that would accompany it is posted
 * separately, so each case can put the document layer and the ledger
 * deliberately in step or deliberately out of it.
 */
async function arInvoice(
  no: string,
  customerId: string,
  net: string,
  allocated: string,
  status: string,
  dueDate = '2026-06-01',
) {
  await ownerPool.query(
    `insert into ar_invoice
       (id, invoice_no, customer_id, branch_code, invoice_date, due_date,
        gross_iqd, discount_iqd, net_iqd, allocated_iqd, status, created_by)
     values (gen_random_uuid(), $1, $2, $3, '2026-05-01'::date, $4::date, $5, 0, $5, $6, $7, $8)`,
    [no, customerId, BAGHDAD, dueDate, net, allocated, status, manager.principal.userId],
  );
}

async function apInvoice(
  no: string,
  supplierId: string,
  total: string,
  settled: string,
  status: string,
  dueDate = '2026-06-01',
) {
  await ownerPool.query(
    // `non_po_justification` and its approval because this fixture has no
    // purchase order behind it — the check constraint is right to insist, and
    // saying so here is cheaper than raising an order the test never reads.
    `insert into ap_invoice
       (id, invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date,
        total_iqd, settled_amount_iqd, status, created_by,
        non_po_justification, non_po_approved_by, non_po_approved_at)
     values (gen_random_uuid(), $1, $1 || '-SUP', $2, $3, '2026-05-01'::date, $4::date, $5, $6, $7, $8,
             'Reconciliation fixture', $8, now())`,
    [no, supplierId, BAGHDAD, dueDate, total, settled, status, manager.principal.userId],
  );
}

/** The whole reconciliation for one side, as the screen assembles it. */
async function reconciliation(side: openItems.Side, partyCode?: string, asOf = AS_OF) {
  return withScope(scope(manager), async (tx) => {
    const narrow = { branchCode: BAGHDAD, ...(partyCode ? { partyCode } : {}) };
    const items = await openItems.openItems(tx, manager.principal, side, asOf, {
      ...narrow,
      outstandingOnly: true,
    });
    /*
     * Every invoice, as the screen does.
     *
     * The filter decides which rows are listed, never which invoices count as
     * accounted for. Reconciling against the outstanding-only set would
     * attribute a settled invoice's charge and payment to the journals, and
     * the report would double-count inside the very figures meant to prove it
     * does not.
     */
    const everyItem = await openItems.openItems(tx, manager.principal, side, asOf, narrow);
    const balances = await openItems.ledgerBalances(tx, manager.principal, side, asOf, narrow);
    const rows = openItems.reconcile(everyItem, balances);
    return { items, rows, totals: openItems.reconciliationTotals(rows) };
  });
}

const closingOf = (side: 'customer' | 'supplier', code: string) =>
  withScope(scope(manager), (tx) => statement.statementFor(tx, side, code, WINDOW)).then((s) =>
    Number(s.closing),
  );

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );
  manager = await createManager();
  approver = await createManager();
  await withScope(scope(manager), (tx) =>
    periods.createFiscalYear(tx, manager, {
      code: 'FY2026',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    }),
  );
  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: '2026-01-01',
    }),
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('journal_entry','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );

  bank = await account('A000001', 'Bank');
  receivables = await account('A000001', 'Accounts Receivable', 'customer');
  payables = await account('L000001', 'Accounts Payable', 'supplier');
  revenue = await account('R000001', 'Sales');
  expense = await account('X000001', 'Purchases');
});

// ---------------------------------------------------------------------------

describe('ops 17 · a debt raised by journal is still a debt', () => {
  /**
   * The sponsor's own case, in their figures.
   *
   * *"INV-1001: 1,200,000 → 500,000 paid → 700,000 outstanding … therefore
   * the customer currently owes 700,000 IQD."*
   */
  it('shows the sponsor’s 700,000 on the ageing, not nothing', async () => {
    const customer = await partner('CUST-001', 'Al Noor Trading', 'customer');

    await post('2026-03-01', 'Invoice INV-1001', [
      { account: receivables, debit: '1200000.0000', party: customer.code },
      { account: revenue, credit: '1200000.0000' },
    ]);
    await post('2026-04-15', 'Receipt against INV-1001', [
      { account: bank, debit: '500000.0000' },
      { account: receivables, credit: '500000.0000', party: customer.code },
    ]);

    const closing = await closingOf('customer', customer.code);
    expect(closing, 'the statement, unchanged').toBe(700_000);

    const { rows, totals } = await reconciliation('customer');
    expect(Number(totals.ledgerIqd)).toBe(700_000);
    // No invoice document exists, so the document layer accounts for none of
    // it — and the whole of it is reported rather than silently dropped.
    expect(Number(totals.documentsIqd)).toBe(0);
    expect(Number(totals.unexplainedIqd)).toBe(700_000);

    const mine = rows.find((row) => row.partyCode === customer.code)!;
    expect(Number(mine.ledgerIqd)).toBe(700_000);
    // The whole of it is a non-invoice debit — a debt the journals raised and
    // no document explains — reported net, with the day the account first
    // moved, so a credit controller knows how long it has been sitting.
    expect(Number(mine.unexplainedIqd)).toBe(700_000);
    expect(Number(mine.otherNonInvoiceDebitIqd)).toBe(700_000);
    expect(mine.oldestDate).toBe('2026-03-01');
  });

  it('the ageing total is the statement’s closing balance, to the dinar', async () => {
    const customer = await partner('CUST-001', 'Al Noor Trading', 'customer');

    await post('2026-03-01', 'Invoice INV-1001', [
      { account: receivables, debit: '1200000.0000', party: customer.code },
      { account: revenue, credit: '1200000.0000' },
    ]);
    await post('2026-04-15', 'Receipt against INV-1001', [
      { account: bank, debit: '500000.0000' },
      { account: receivables, credit: '500000.0000', party: customer.code },
    ]);

    // A second invoice, this one a real document, raised and settled in full.
    await arInvoice('INV-HQ-2026-000022', customer.id, '10000.0000', '10000.0000', 'settled');
    await post('2026-09-27', 'A/R invoice INV-HQ-2026-000022', [
      { account: receivables, debit: '10000.0000', party: customer.code },
      { account: revenue, credit: '10000.0000' },
    ]);
    await post('2026-09-30', 'Customer receipt RCT-HQ-2026-000001', [
      { account: bank, debit: '10000.0000' },
      { account: receivables, credit: '10000.0000', party: customer.code },
    ]);

    const closing = await closingOf('customer', customer.code);
    const { totals } = await reconciliation('customer');

    expect(closing).toBe(700_000);
    expect(Number(totals.ledgerIqd)).toBe(closing);
    // The settled invoice contributes nothing to what is *owed* — it is paid.
    expect(Number(totals.documentsIqd)).toBe(0);
    expect(Number(totals.unexplainedIqd)).toBe(700_000);

    /*
     * And the settled invoice does not bleed into the journal row.
     *
     * The ledger moved by 1,210,000 and 510,000 across the four entries; the
     * settled invoice accounts for 10,000 of each and nets to nothing, so the
     * unexplained balance must be the journals' own 700,000 — not the gross.
     * Getting this wrong would double-count the invoice inside the very
     * report that is meant to prove nothing is double-counted.
     */
    const mine = (await reconciliation('customer')).rows.find(
      (row) => row.partyCode === customer.code,
    )!;
    expect(Number(mine.unexplainedIqd)).toBe(700_000);
  });

  it('reports nothing unexplained when every movement has an invoice behind it', async () => {
    const customer = await partner('CUST-002', 'Tidy Books Ltd', 'customer');

    await arInvoice('INV-TIDY-1', customer.id, '1000.0000', '400.0000', 'partially_executed');
    await post('2026-05-01', 'A/R invoice INV-TIDY-1', [
      { account: receivables, debit: '1000.0000', party: customer.code },
      { account: revenue, credit: '1000.0000' },
    ]);
    await post('2026-05-20', 'Receipt against INV-TIDY-1', [
      { account: bank, debit: '400.0000' },
      { account: receivables, credit: '400.0000', party: customer.code },
    ]);

    const closing = await closingOf('customer', customer.code);
    const { totals } = await reconciliation('customer');

    expect(closing).toBe(600);
    expect(Number(totals.documentsIqd), 'the invoice knows about all of it').toBe(600);
    expect(Number(totals.unexplainedIqd)).toBe(0);
    expect(totals.ties).toBe(true);
    expect(Number(totals.ledgerIqd)).toBe(closing);
  });

  it('catches a receipt that never reached the control account', async () => {
    const customer = await partner('CUST-003', 'Lost Receipt Co', 'customer');

    // The invoice reaches the ledger and the document layer agree.
    await arInvoice('INV-LOST-1', customer.id, '5000.0000', '5000.0000', 'settled');
    await post('2026-05-01', 'A/R invoice INV-LOST-1', [
      { account: receivables, debit: '5000.0000', party: customer.code },
      { account: revenue, credit: '5000.0000' },
    ]);

    /*
     * …and the receipt does not. This is the defect exactly: the invoice is
     * marked settled, so the document layer says nothing is owed, while the
     * 5,000 is still sitting on the customer's control account because the
     * receipt credited somewhere else entirely.
     *
     * The old ageing reported "nothing outstanding" and was believed. This
     * one reports the 5,000 as a non-invoice debit row of its own — which is
     * the report doing its job: the figure a reader must chase is on the
     * page, not silently absent.
     */
    const closing = await closingOf('customer', customer.code);
    const { totals } = await reconciliation('customer');

    expect(closing).toBe(5_000);
    expect(Number(totals.documentsIqd)).toBe(0);
    expect(Number(totals.unexplainedIqd)).toBe(5_000);
    expect(
      Number(totals.otherNonInvoiceDebitsIqd),
      'and it shows the 5,000 rather than reporting nought',
    ).toBe(5_000);
    expect(Number(totals.ledgerIqd)).toBe(closing);
  });
});

describe('ops 17 · the same holds for what we owe', () => {
  it('shows a payable raised by journal, and ties to the supplier statement', async () => {
    const supplier = await partner('SUP-001', 'Baghdad Cables', 'supplier');

    await post('2026-03-01', 'Purchase INV-9001', [
      { account: expense, debit: '800000.0000' },
      { account: payables, credit: '800000.0000', party: supplier.code },
    ]);
    await post('2026-04-15', 'Payment against INV-9001', [
      { account: payables, debit: '300000.0000', party: supplier.code },
      { account: bank, credit: '300000.0000' },
    ]);

    const closing = await closingOf('supplier', supplier.code);
    const { rows, totals } = await reconciliation('supplier');

    // Credit-normal: the supplier statement ends positive when we owe them.
    expect(closing).toBe(500_000);
    expect(Number(totals.ledgerIqd)).toBe(closing);
    expect(Number(totals.documentsIqd)).toBe(0);
    expect(Number(totals.unexplainedIqd)).toBe(500_000);
    const mine = rows.find((row) => row.partyCode === supplier.code)!;
    expect(Number(mine.otherNonInvoiceDebitIqd)).toBe(500_000);
    expect(mine.oldestDate).toBe('2026-03-01');
  });

  it('reports nothing unexplained when the purchase invoice accounts for it', async () => {
    const supplier = await partner('SUP-002', 'Tidy Supplies', 'supplier');

    await apInvoice('API-TIDY-1', supplier.id, '2000.0000', '750.0000', 'partially_executed');
    await post('2026-05-01', 'A/P invoice API-TIDY-1', [
      { account: expense, debit: '2000.0000' },
      { account: payables, credit: '2000.0000', party: supplier.code },
    ]);
    await post('2026-05-20', 'Payment against API-TIDY-1', [
      { account: payables, debit: '750.0000', party: supplier.code },
      { account: bank, credit: '750.0000' },
    ]);

    const closing = await closingOf('supplier', supplier.code);
    const { totals } = await reconciliation('supplier');

    expect(closing).toBe(1_250);
    expect(Number(totals.documentsIqd)).toBe(1_250);
    expect(Number(totals.unexplainedIqd)).toBe(0);
    expect(totals.ties).toBe(true);
  });
});

describe('ops 17 · a reversal takes both sides down together', () => {
  /*
   * The case that would silently break the tie.
   *
   * A reversed invoice leaves `OPEN_STATUSES`, so the document layer forgets
   * it. If the ledger did not forget it too, the difference would appear as
   * an unexplained balance for a debt that no longer exists — a report
   * chasing a customer for an invoice somebody deliberately cancelled.
   *
   * It holds because `journal.reverse` mirrors the subledger movements in the
   * same transaction, so both sides reach nought at the same moment.
   */
  it('leaves nothing owing and nothing unexplained', async () => {
    const customer = await partner('CUST-005', 'Cancelled Order Ltd', 'customer');

    const entry = await post('2026-05-01', 'Invoice raised in error', [
      { account: receivables, debit: '9000.0000', party: customer.code },
      { account: revenue, credit: '9000.0000' },
    ]);

    const before = await closingOf('customer', customer.code);
    expect(before).toBe(9_000);

    await withScope(scope(manager), (tx) =>
      journal.reverse(tx, manager, entry.id, { reason: 'Raised against the wrong customer' }),
    );

    const after = await closingOf('customer', customer.code);
    // The reversal is dated the day it is made (§14.6) — after the suite's
    // 30 September as-of. As at 30 September the debt genuinely stood, so
    // the reconciliation is read to the end of the year, the same window
    // the statement's closing balance is read over.
    const { totals } = await reconciliation('customer', customer.code, WINDOW.to);

    expect(after, 'the statement forgets it').toBe(0);
    expect(Number(totals.ledgerIqd), 'and so does the ageing').toBe(0);
    expect(Number(totals.unexplainedIqd), 'with nothing left over to explain').toBe(0);
    expect(totals.ties).toBe(true);
  });
});

describe('ops 17 · the ageing bands tie too', () => {
  it('keeps what no invoice explains beside the bands, and the two tie to the statement', async () => {
    const customer = await partner('CUST-004', 'Mixed Ltd', 'customer');

    // One invoice, overdue by about four months.
    await arInvoice('INV-MIX-1', customer.id, '1000.0000', '0.0000', 'posted', '2026-06-01');
    await post('2026-05-01', 'A/R invoice INV-MIX-1', [
      { account: receivables, debit: '1000.0000', party: customer.code },
      { account: revenue, credit: '1000.0000' },
    ]);
    // …and an opening balance journalled in, older still.
    await post('2026-01-05', 'Opening balance', [
      { account: receivables, debit: '4000.0000', party: customer.code },
      { account: revenue, credit: '4000.0000' },
    ]);

    const { items, totals } = await reconciliation('customer');
    const banded = openItems
      .ageing(items)
      .reduce((sum, band) => sum + Number(band.amountIqd), 0);

    const closing = await closingOf('customer', customer.code);
    expect(closing).toBe(5_000);
    // The bands age the invoices; the opening balance is never aged — it is
    // its own non-invoice row. Added up by hand, the two still come to the
    // statement's closing balance, which is the check a reader actually
    // performs on a printed ageing.
    expect(banded).toBe(1_000);
    expect(Number(totals.otherNonInvoiceDebitsIqd)).toBe(4_000);
    expect(
      banded + Number(totals.otherNonInvoiceDebitsIqd) - Number(totals.unappliedCreditsIqd),
    ).toBe(closing);
    expect(totals.ties).toBe(true);
  });
});
