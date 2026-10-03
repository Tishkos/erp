/**
 * Phase 07.8 test gate — daily cash position and cash forecast. §17.
 *
 *   - Daily position by account and currency ties to the G/L for the same date
 *   - The forecast draws from all five listed sources; removing one visibly
 *     changes the result
 *   - Forecast by day, week and month are internally consistent
 *   - Foreign-currency exposure is reported by currency, not collapsed to base
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as cash from '@/server/services/cash-forecast';
import * as treasury from '@/server/services/treasury';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';

let manager: ActorContext;
let iqdGlCode: string;
let usdAccountId: string;
let usdGlCode: string;
let suspenseId: string;
let supplierId: string;
let customerId: string;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    `${role}-${(seq += 1)}`,
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

/** A posted movement into a G/L account, with the other leg in suspense. */
async function fund(glCode: string, amountIqd: string, amountUsd: string, on = '2026-01-15') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: gl } = await client.query(`select id from chart_of_account where code = $1`, [
      glCode,
    ]);
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Opening funds','draft',$5,$5,$6) returning id`,
      [`FUND-${(seq += 1)}`, on, periods[0].id, BAGHDAD, amountIqd, manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, $6, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, $6, 'IQD', $5)`,
      [entry[0].id, gl[0].id, amountIqd, suspenseId, BAGHDAD, amountUsd],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, manager.principal.userId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * An open supplier invoice — money the forecast expects to go out.
 *
 * Written directly rather than through the Phase 05 service: the forecast reads
 * due dates and outstanding balances, and building a purchase order, a receipt
 * and a three-way match to produce one due date would test Phase 05 twice and
 * this gate once. §8.2's non-PO justification is supplied because the row would
 * otherwise be one the database is right to refuse.
 */
async function apDue(dueDate: string, totalIqd: string) {
  await ownerPool.query(
    `insert into ap_invoice
       (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date,
        currency, total_iqd, settled_amount_iqd, status, created_by,
        non_po_justification, non_po_approved_by, non_po_approved_at)
     values ($1,$2,$3,$4,'2026-01-05',$5,'IQD',$6,0,'posted',$7,
             'Fixture invoice for the cash forecast gate', $7, now())`,
    [
      `API-${(seq += 1)}`,
      `SUP-INV-${seq}`,
      supplierId,
      BAGHDAD,
      dueDate,
      totalIqd,
      manager.principal.userId,
    ],
  );
}

/**
 * An open customer invoice — money the forecast expects to come in.
 *
 * §7.4 makes an A/R invoice inseparable from the delivery note it bills, so the
 * fixture builds the chain it needs: an order, a pick list, a delivered note,
 * then the invoice. Written directly rather than through the Phase 06 services
 * because what the forecast reads is a due date and an outstanding balance —
 * the sales chain itself is proved in Phase 06's own tests.
 */
async function arExpected(dueDate: string, netIqd: string) {
  const n = (seq += 1);

  const { rows: order } = await ownerPool.query(
    `insert into sales_order (order_no, customer_id, price_list_code, branch_code, order_date,
                              currency, status, created_by)
     values ($1,$2,$3,$4,'2026-01-05','IQD','approved',$5) returning id`,
    [`SO-${n}`, customerId, 'PL-STD', BAGHDAD, manager.principal.userId],
  );

  const { rows: pick } = await ownerPool.query(
    `insert into pick_list (pick_list_no, sales_order_id, warehouse_code, branch_code, pick_date,
                            status, created_by)
     values ($1,$2,$3,$4,'2026-01-05','executed',$5) returning id`,
    [`PL-${n}`, order[0].id, `WH-${BAGHDAD}`, BAGHDAD, manager.principal.userId],
  );

  const { rows: note } = await ownerPool.query(
    `insert into delivery_note (delivery_note_no, sales_order_id, pick_list_id, warehouse_code,
                                branch_code, delivery_date, status, created_by)
     values ($1,$2,$3,$4,$5,'2026-01-05','executed',$6) returning id`,
    [`DN-${n}`, order[0].id, pick[0].id, `WH-${BAGHDAD}`, BAGHDAD, manager.principal.userId],
  );

  await ownerPool.query(
    `insert into ar_invoice
       (invoice_no, customer_id, delivery_note_id, sales_order_id, branch_code, invoice_date,
        due_date, currency, gross_iqd, discount_iqd, net_iqd, allocated_iqd, status, created_by)
     values ($1,$2,$3,$4,$5,'2026-01-05',$6,'IQD',$7,0,$7,0,'posted',$8)`,
    [
      `ARI-${n}`,
      customerId,
      note[0].id,
      order[0].id,
      BAGHDAD,
      dueDate,
      netIqd,
      manager.principal.userId,
    ],
  );
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,1,'January 2026','2026-01-01','2026-01-31'),
            ($1,2,'February 2026','2026-02-01','2026-02-28'),
            ($1,3,'March 2026','2026-03-01','2026-03-31')
     on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: iqd } = await ownerPool.query(
    `select a.code from bank_cash_account b join chart_of_account a on a.id = b.gl_account_id
      where b.account_type = 'bank' limit 1`,
  );
  iqdGlCode = iqd[0].code;

  const { rows: parents } = await ownerPool.query(
    `select id from chart_of_account where code = 'A000001'`,
  );
  const { rows: liabilities } = await ownerPool.query(
    `select id from chart_of_account where code = 'L000001'`,
  );

  // §17 — a second account, in another currency. Everything about the "by
  // currency" gate needs two currencies to be a real question.
  const { rows: usdGl } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
        currency_restriction)
     values ('A9USDBNK','USD Bank Account','asset',$1,false,true,'approved',1,'USD') returning id`,
    [parents[0].id],
  );
  usdGlCode = 'A9USDBNK';

  const { rows: usdAccount } = await ownerPool.query(
    `insert into bank_cash_account
       (code, name, account_type, bank_name, account_number, currency, gl_account_id)
     values ('BNK-USD','Baghdad USD Account','bank','Seed Bank','ACC-USD','USD',$1) returning id`,
    [usdGl[0].id],
  );
  usdAccountId = usdAccount[0].id;

  const { rows: suspense } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
        currency_restriction)
     values ('L9SUSPEN','Funding Suspense',
             (select account_type from chart_of_account where code = 'L000001'),
             $1,false,true,'approved',1,'IQD') returning id`,
    [liabilities[0].id],
  );
  suspenseId = suspense[0].id;

  await ownerPool.query(
    `insert into price_list (code, name, currency, active) values ('PL-STD','Standard','IQD',true)
     on conflict do nothing`,
  );

  const { rows: partners } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, is_customer, status, active)
     values ('SUP-001','Supplier One', true, false, 'active', true),
            ('CUST-001','Al Rasheed Trading', false, true, 'active', true)
     returning id, code`,
  );
  supplierId = partners.find((r) => r.code === 'SUP-001')!.id;
  customerId = partners.find((r) => r.code === 'CUST-001')!.id;
});

// ---------------------------------------------------------------------------

describe('07.8 gate · the daily position ties to the G/L for the same date (§17)', () => {
  it('reports each account at its own G/L balance', async () => {
    await fund(iqdGlCode, '5000', '0');
    await fund(usdGlCode, '1310000', '1000');

    const position = await withScope(scope(manager), (tx) =>
      cash.dailyPosition(tx, manager, '2026-01-31', { branchCode: BAGHDAD }),
    );

    const fromTreasury = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-01-31', { branchCode: BAGHDAD }),
    );

    // One place answers "what is in this account"; the dashboard does not
    // compute a second one.
    expect(position.accounts.map((a) => [a.accountCode, a.balanceIqd])).toEqual(
      fromTreasury.map((a) => [a.accountCode, a.balanceIqd]),
    );
  });

  it('ties to the ledger read independently', async () => {
    await fund(iqdGlCode, '5000', '0');

    const position = await withScope(scope(manager), (tx) =>
      cash.dailyPosition(tx, manager, '2026-01-31', { branchCode: BAGHDAD }),
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join bank_cash_account b on b.gl_account_id = l.account_id
        where e.branch_code = $1 and e.status in ('posted','reversed')
          and e.posting_date <= '2026-01-31'`,
      [BAGHDAD],
    );

    expect(position.totalIqd).toBe(parseDecimal(rows[0].balance, 4n) === 0n ? '0.0000' : position.totalIqd);
    expect(Number(position.totalIqd)).toBe(Number(rows[0].balance));
  });

  it('moves as at a date, not as at today', async () => {
    await fund(iqdGlCode, '5000', '0', '2026-01-15');
    await fund(iqdGlCode, '3000', '0', '2026-02-10');

    const january = await withScope(scope(manager), (tx) =>
      cash.dailyPosition(tx, manager, '2026-01-31', { branchCode: BAGHDAD }),
    );
    const february = await withScope(scope(manager), (tx) =>
      cash.dailyPosition(tx, manager, '2026-02-28', { branchCode: BAGHDAD }),
    );

    expect(Number(january.totalIqd)).toBe(5000);
    expect(Number(february.totalIqd)).toBe(8000);
  });
});

describe('07.8 gate · liquidity by currency, never collapsed to base (§17)', () => {
  it('groups the accounts by the currency they are held in', async () => {
    await fund(iqdGlCode, '5000', '0');
    await fund(usdGlCode, '1310000', '1000');

    const position = await withScope(scope(manager), (tx) =>
      cash.dailyPosition(tx, manager, '2026-01-31', { branchCode: BAGHDAD }),
    );

    expect(position.byCurrency.map((row) => row.currency)).toEqual(['IQD', 'USD']);
    expect(Number(position.byCurrency.find((r) => r.currency === 'IQD')!.balanceIqd)).toBe(5000);
    expect(Number(position.byCurrency.find((r) => r.currency === 'USD')!.balanceIqd)).toBe(1310000);
  });

  it('reports the exposure in the currency it is held in, not converted', async () => {
    await fund(usdGlCode, '1310000', '1000');

    const exposure = await withScope(scope(manager), (tx) =>
      cash.currencyExposure(tx, manager, '2026-01-31', BAGHDAD),
    );

    const usd = exposure.find((row) => row.currency === 'USD');
    expect(usd).toBeDefined();
    // Both figures come from the ledger's own columns (§14.3). Neither is a
    // conversion done at read time, which would answer a question about today's
    // rate rather than about the exposure.
    expect(Number(usd!.balanceIqd)).toBe(1310000);
    expect(Number(usd!.balanceUsd)).toBe(1000);
  });

  it('keeps the currencies apart rather than adding them up', async () => {
    await fund(iqdGlCode, '5000', '0');
    await fund(usdGlCode, '1310000', '1000');

    const exposure = await withScope(scope(manager), (tx) =>
      cash.currencyExposure(tx, manager, '2026-01-31', BAGHDAD),
    );

    expect(exposure).toHaveLength(2);
    expect(exposure.map((row) => row.currency)).toEqual(['IQD', 'USD']);
  });
});

describe('07.8 gate · the forecast and its five sources (§17)', () => {
  it('names §17’s five and §13’s one, and says which can contribute today', async () => {
    const result = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, { from: '2026-02-01', to: '2026-02-28' }),
    );

    /*
     * §17 names five. `investment_calls` was the sixth, added when Phase 13 was
     * built: §13.8 requires the investment cash-flow forecast to feed this one,
     * and a second forecast nobody reconciled against would be worse than a
     * longer list here.
     *
     * The loans are the seventh and eighth (2026-10-03, by direction). A bank
     * loan does two things to a bank account on dates set months ahead — an
     * instalment falls due, and a drawdown arrives — and a forecast that knew
     * neither was a forecast with a hole in it exactly where the certainty is.
     */
    expect(result.sources.map((s) => s.source)).toEqual([
      'ap_due',
      'ar_expected',
      'project_commitments',
      'payroll',
      'transfer_funding',
      'investment_calls',
      'loan_repayments',
      'loan_drawdowns',
    ]);

    // Two of §17's five are not wired yet, and the report says so rather than
    // reporting them as nil. Payroll is, since REQ-HR-001 HR-3; the loans are,
    // since their register holds a schedule and a repayment ledger.
    expect(result.sources.filter((s) => s.available).map((s) => s.source)).toEqual([
      'ap_due',
      'ar_expected',
      'payroll',
      'investment_calls',
      'loan_repayments',
      'loan_drawdowns',
    ]);
    for (const source of result.sources.filter((s) => !s.available)) {
      expect(source.note).toMatch(/Awaits Phase \d+/);
    }
  });

  it('draws A/P out and A/R in, on their due dates', async () => {
    await fund(iqdGlCode, '10000', '0');
    await apDue('2026-02-10', '1500');
    await arExpected('2026-02-20', '4000');

    const result = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, { from: '2026-02-01', to: '2026-02-28', branchCode: BAGHDAD }),
    );

    expect(Number(result.openingIqd)).toBe(10000);
    expect(Number(result.closingIqd)).toBe(12500); // 10,000 − 1,500 + 4,000

    const ap = result.lines.find((l) => l.source === 'ap_due')!;
    const ar = result.lines.find((l) => l.source === 'ar_expected')!;
    expect(Number(ap.outflowIqd)).toBe(1500);
    expect(Number(ar.inflowIqd)).toBe(4000);
  });

  it('visibly changes when a source is removed', async () => {
    await fund(iqdGlCode, '10000', '0');
    await apDue('2026-02-10', '1500');
    await arExpected('2026-02-20', '4000');

    const full = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, { from: '2026-02-01', to: '2026-02-28', branchCode: BAGHDAD }),
    );
    const withoutAp = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, {
        from: '2026-02-01',
        to: '2026-02-28',
        branchCode: BAGHDAD,
        exclude: ['ap_due'],
      }),
    );
    const withoutAr = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, {
        from: '2026-02-01',
        to: '2026-02-28',
        branchCode: BAGHDAD,
        exclude: ['ar_expected'],
      }),
    );

    expect(Number(full.closingIqd)).toBe(12500);
    expect(Number(withoutAp.closingIqd)).toBe(14000);
    expect(Number(withoutAr.closingIqd)).toBe(8500);
    expect(withoutAp.excluded).toEqual(['ap_due']);
  });

  it('leaves out an invoice that has already been paid', async () => {
    await fund(iqdGlCode, '10000', '0');
    await apDue('2026-02-10', '1500');
    await ownerPool.query(
      `update ap_invoice set settled_amount_iqd = total_iqd, status = 'settled'`,
    );

    const result = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, { from: '2026-02-01', to: '2026-02-28', branchCode: BAGHDAD }),
    );
    expect(result.lines).toHaveLength(0);
    expect(Number(result.closingIqd)).toBe(10000);
  });

  it('opens at the real balance the day before the range starts', async () => {
    await fund(iqdGlCode, '10000', '0', '2026-01-15');
    // Money arriving inside the range is a movement, not part of the opening.
    await fund(iqdGlCode, '2000', '0', '2026-02-05');

    const result = await withScope(scope(manager), (tx) =>
      cash.forecast(tx, manager, { from: '2026-02-01', to: '2026-02-28', branchCode: BAGHDAD }),
    );
    expect(Number(result.openingIqd)).toBe(10000);
  });
});

describe('07.8 gate · day, week and month agree with each other (§17)', () => {
  async function threeViews() {
    await fund(iqdGlCode, '10000', '0');
    await apDue('2026-02-03', '500');
    await apDue('2026-02-04', '300');
    await apDue('2026-02-17', '200');
    await arExpected('2026-02-05', '1000');
    await arExpected('2026-02-25', '2000');

    const views = await Promise.all(
      (['day', 'week', 'month'] as const).map((bucket) =>
        withScope(scope(manager), (tx) =>
          cash.forecast(tx, manager, {
            from: '2026-02-01',
            to: '2026-02-28',
            bucket,
            branchCode: BAGHDAD,
          }),
        ),
      ),
    );
    return { day: views[0]!, week: views[1]!, month: views[2]! };
  }

  it('closes at the same figure in all three', async () => {
    const { day, week, month } = await threeViews();

    expect(Number(day.closingIqd)).toBe(12000); // 10,000 − 1,000 + 3,000
    expect(day.closingIqd).toBe(week.closingIqd);
    expect(week.closingIqd).toBe(month.closingIqd);
  });

  it('moves the same money, in different-sized boxes', async () => {
    const { day, week, month } = await threeViews();

    const total = (view: { periods: { inflowIqd: string; outflowIqd: string }[] }) => ({
      in: view.periods.reduce((sum, p) => sum + Number(p.inflowIqd), 0),
      out: view.periods.reduce((sum, p) => sum + Number(p.outflowIqd), 0),
    });

    expect(total(day)).toEqual({ in: 3000, out: 1000 });
    expect(total(week)).toEqual(total(day));
    expect(total(month)).toEqual(total(day));

    // Five movements on five days, three ISO weeks, one month.
    expect(day.periods).toHaveLength(5);
    expect(week.periods.length).toBeLessThan(day.periods.length);
    expect(month.periods).toHaveLength(1);
  });

  it('opens each period where the last one closed', async () => {
    const { day } = await threeViews();

    for (let index = 1; index < day.periods.length; index += 1) {
      expect(day.periods[index]!.openingIqd).toBe(day.periods[index - 1]!.closingIqd);
    }
    expect(day.periods[0]!.openingIqd).toBe(day.openingIqd);
    expect(day.periods.at(-1)!.closingIqd).toBe(day.closingIqd);
  });
});
