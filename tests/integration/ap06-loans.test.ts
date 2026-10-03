/**
 * REQ-AP-001 Stage 6 — loans (§15.6, §15.7).
 *
 *   A14 (REQ-APP-001)  A loan of 1,000,000 at 2 % deducted at disbursement
 *        credits 980,000 to the account, books 1,000,000 liability and 20,000
 *        commission; a 4-instalment quarterly schedule is generated with the
 *        last absorbing rounding; funding two applications 600,000 / 400,000
 *        allocates commission 12,000 / 8,000.
 *
 * Plus: maker-checker and the CEO above the account's limit; the loan
 * subledger reconciles per loan; a draw only on a disbursed loan, in its
 * currency, from its account, within its room; a rejected application gives
 * its draw back; repayments in order post Dr liability / interest / commission
 * Cr bank and the last one closes the loan; the sweep marks due and overdue
 * and tells the funded imports once; paid-separately commission; cancel with
 * a reason, never after disbursement; nothing deleted.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as customs from '@/server/services/customs-pd';
import * as loans from '@/server/services/loans';
import * as sweep from '@/server/services/payables-sweep';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';
import { fundBank } from './hr-funds';

let world: TradingWorld;
let payableId: string;
let payeeId: string;
const SWIFT = 'PM-T001';
const RAFIDAIN = 'BNK-0005';
const iqd = (value: string) => parseDecimal(value, 4n);

const LOAN_EVENTS = ['treasury.loan_disbursement', 'treasury.loan_repayment', 'treasury.loan_commission'];

/** The loan accounts and their mappings, as an administrator sets them. */
async function loanAccounts() {
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['loan_liability', 'L000001', 'Bank Loans', 'loan'],
    ['landed_cost_clearing', 'A000001', 'Landed Cost Clearing', null],
    ['bank_commission', 'X000001', 'Bank Commission', null],
    ['loan_interest', 'X000001', 'Loan Interest', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`${parent.slice(0, 1)}7${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id, control],
    );
    world.accounts[role] = rows[0].id;
    for (const event of LOAN_EVENTS) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1,$2,$3,true,$4) on conflict do nothing`,
        [event, role, rows[0].id, world.manager.principal.userId],
      );
    }
    await withScope(scope(world.manager), (tx) => coa.setRequiredDimensions(tx, world.manager, rows[0].id, []));
  }
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('bank_loan','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement='optional'`,
  );
}

async function userWith(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Loan Tester')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** An import of `units` panels at 10,000 IQD, its PD validated. */
async function importOf(reference: string, units = '100') {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity(units),
          unitPriceIqd: iqd('10000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  return rows[0].payable_id as string;
}

type LoanInput = Partial<loans.CreateLoanInput>;
const createLoan = (input: LoanInput = {}, by = world.clerk) =>
  withScope(scope(by), (tx) =>
    loans.create(tx, by, {
      bankCode: RAFIDAIN,
      bankCashAccountId: world.bankAccountId,
      principalTxn: iqd('1000000'),
      commissionPct: '2',
      commissionTreatmentCode: 'deducted_at_disbursement',
      instalmentCount: 4,
      frequency: 'quarterly',
      firstDueDate: '2026-12-31',
      onDate: '2026-09-01',
      ...input,
    }),
  );
const approveLoan = (id: string, by = world.manager) => withScope(scope(by), (tx) => loans.approve(tx, by, id));
const disburse = (id: string, on = '2026-09-05') =>
  withScope(scope(world.manager), (tx) => loans.disburse(tx, world.manager, id, { disbursementDate: on, reference: 'RAF-CR-0001' }));
const loanRow = async (id: string) => (await ownerPool.query(`select * from bank_loan where id = $1`, [id])).rows[0];
const scheduleOf = async (id: string) =>
  (
    await ownerPool.query(
      `select * from bank_loan_instalment where loan_id = $1 and superseded_at is null order by sequence`,
      [id],
    )
  ).rows;

async function readyLoan(input: LoanInput = {}) {
  const made = await createLoan(input);
  await approveLoan(made.id);
  await disburse(made.id);
  return made;
}

const draft = (amount: string, loanId: string | null, onPayable = payableId) =>
  withScope(scope(world.clerk), (tx) =>
    applications.create(tx, world.clerk, {
      payableId: onPayable,
      paymentMethodCode: SWIFT,
      bankCashAccountId: world.bankAccountId,
      payeeBankAccountId: payeeId,
      amountTxn: iqd(amount),
      onDate: '2026-09-10',
      ...(loanId ? { fundingSourceCode: 'loan', loanId } : {}),
    }),
  );
const approveApp = (id: string) => withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, id));

const eventsOf = async (id = payableId) =>
  (
    await ownerPool.query(`select event_code, summary from payable_event where payable_id = $1 order by recorded_at, id`, [id])
  ).rows as { event_code: string; summary: string }[];

async function journalLines(journalEntryId: string) {
  const { rows } = await ownerPool.query(
    `select l.line_role, l.debit_iqd::text as debit, l.credit_iqd::text as credit, l.loan_no, l.bank_account_code
       from journal_line l where l.journal_entry_id = $1 order by l.line_no`,
    [journalEntryId],
  );
  return rows as { line_role: string; debit: string; credit: string; loan_no: string | null; bank_account_code: string | null }[];
}

beforeEach(async () => {
  world = await buildTradingWorld();
  await loanAccounts();
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
  await ownerPool.query(`update bank_cash_account set bank_code = $2 where id = $1`, [world.bankAccountId, RAFIDAIN]);
  const { rows: payee } = await ownerPool.query(
    `insert into partner_bank_account
       (partner_id, bank_name, account_number, swift, currency, approval_status, is_active)
     values ($1,'Bank of China','CN-6217-0001','BKCHCNBJ','IQD','approved',true) returning id`,
    [world.supplierId],
  );
  payeeId = payee[0].id;
  payableId = await importOf('CSA-LOAN-0001');
  const pd = await withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, { payableId, pdNo: '7700', registrationDate: '2026-09-02', expiryDate: '2027-03-01' }),
  );
  await withScope(scope(world.clerk), (tx) =>
    customs.changeStatus(tx, world.clerk, pd.id, { statusCode: 'validated', effectiveDate: '2026-09-05' }),
  );
});

describe('A14 · the Rafidain example', () => {
  it('1,000,000 at 2 % deducted: 980,000 in, 1,000,000 owed, 20,000 commission; four quarters', async () => {
    const made = await createLoan();
    expect(made.loanNo).toMatch(/^LOAN-2026-\d{6}$/);
    const row = await loanRow(made.id);
    expect([row.status, row.commission_txn, row.net_proceeds_txn, row.maturity_date]).toEqual([
      'draft',
      '20000.0000',
      '980000.0000',
      '2027-09-30',
    ]);
    const schedule = await scheduleOf(made.id);
    expect(schedule.map((i) => [i.sequence, i.due_date, i.principal_txn, i.total_txn])).toEqual([
      [1, '2026-12-31', '250000.0000', '250000.0000'],
      [2, '2027-03-31', '250000.0000', '250000.0000'],
      [3, '2027-06-30', '250000.0000', '250000.0000'],
      [4, '2027-09-30', '250000.0000', '250000.0000'],
    ]);

    // The maker never approves; the manager (who is also CEO) does.
    expect(await rejection(approveLoan(made.id, world.clerk))).toMatch(/approve|permission|not allowed/i);
    await approveLoan(made.id);

    const { journalEntryId } = await disburse(made.id);
    const lines = await journalLines(journalEntryId);
    expect(lines.map((l) => [l.line_role, l.debit, l.credit, l.loan_no])).toEqual([
      ['bank', '980000.0000', '0.0000', null],
      ['landed_cost_clearing', '20000.0000', '0.0000', null],
      ['loan_liability', '0.0000', '1000000.0000', made.loanNo],
    ]);
    // The loan subledger reconciles per loan.
    const { rows: ledger } = await ownerPool.query(
      `select party_code, sum(credit_iqd - debit_iqd)::text as owed from subledger_entry
        where subledger_type = 'loan' group by party_code`,
    );
    expect(ledger).toEqual([{ party_code: made.loanNo, owed: '1000000.0000' }]);
    expect((await loanRow(made.id)).status).toBe('active');
  });

  it('the last instalment absorbs the rounding', async () => {
    const made = await createLoan({ principalTxn: iqd('1000000'), instalmentCount: 3, frequency: 'monthly', firstDueDate: '2026-10-31' });
    const schedule = await scheduleOf(made.id);
    expect(schedule.map((i) => [i.due_date, i.principal_txn])).toEqual([
      ['2026-10-31', '333333.3300'],
      ['2026-11-30', '333333.3300'],
      ['2026-12-31', '333333.3400'],
    ]);
  });

  it('600,000 / 400,000 drawn by two applications carry 12,000 / 8,000 of commission to the import', async () => {
    const made = await readyLoan();
    const first = await draft('600000', made.id);
    const second = await draft('400000', made.id);
    await approveApp(first.id);
    await approveApp(second.id);

    const { rows: draws } = await ownerPool.query(
      `select a.amount_txn, a.commission_share_txn, c.charge_type_code, c.amount_iqd
         from bank_loan_allocation a join landed_cost_charge c on c.id = a.landed_cost_charge_id
        where a.loan_id = $1 and a.released_at is null order by a.amount_txn desc`,
      [made.id],
    );
    expect(draws).toEqual([
      { amount_txn: '600000.0000', commission_share_txn: '12000.0000', charge_type_code: 'bank_commission', amount_iqd: '12000.0000' },
      { amount_txn: '400000.0000', commission_share_txn: '8000.0000', charge_type_code: 'bank_commission', amount_iqd: '8000.0000' },
    ]);
    const log = await eventsOf();
    expect(log.filter((e) => e.event_code === 'LOAN_LINKED')).toHaveLength(2);
    expect(log.filter((e) => e.event_code === 'COMMISSION_RECORDED').map((e) => e.summary)).toEqual([
      `Commission share of ${made.loanNo}: IQD 12,000.00 — charged to this import’s landed cost`,
      `Commission share of ${made.loanNo}: IQD 8,000.00 — charged to this import’s landed cost`,
    ]);
    const view = await withScope(scope(world.manager), (tx) => loans.view(tx, made.loanNo));
    expect([view.totals.allocated, view.totals.unallocated]).toEqual(['1000000.0000', '0.0000']);
  });
});

describe('§15.7 · what a loan may fund', () => {
  it('only a disbursed loan is drawn on; the room, the currency and the account are its own', async () => {
    const made = await createLoan();
    await approveLoan(made.id);
    // Drafting against an approved loan is allowed; approving waits for the money.
    const early = await draft('300000', made.id);
    expect(await rejection(approveApp(early.id))).toMatch(/has not arrived/);
    await disburse(made.id);
    await approveApp(early.id);

    const other = await importOf('CSA-LOAN-0002');
    expect(await rejection(draft('800000', made.id, other))).toMatch(/has IQD 700,000\.00 left to fund/);

    const { rows: usd } = await ownerPool.query(
      `insert into bank_cash_account (code, name, account_type, currency, gl_account_id, bank_code, bank_name, account_number)
       values ('BNK-USD-T','Rafidain USD','bank','USD',$1,$2,'Rafidain Bank','RF-USD-1') returning id`,
      [world.accounts.landed_cost_clearing, RAFIDAIN],
    );
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          loans.assertCanFund(tx, { loanId: made.id, currency: 'USD', bankCashAccountId: usd[0].id, amountTxn: iqd('1') }),
        ),
      ),
    ).toMatch(/is in IQD; this payment is in USD/);

    // Own funds cannot name a loan; a loan source must.
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          applications.create(tx, world.clerk, {
            payableId: other,
            paymentMethodCode: SWIFT,
            bankCashAccountId: world.bankAccountId,
            amountTxn: iqd('1000'),
            fundingSourceCode: 'loan',
          }),
        ),
      ),
    ).toMatch(/names the loan that funds it/);
  });

  it('a rejected application gives its draw back, and its commission charge is withdrawn', async () => {
    const made = await readyLoan();
    const app = await draft('600000', made.id);
    await approveApp(app.id);
    await withScope(scope(world.manager), (tx) => applications.reject(tx, world.manager, app.id, 'Bank refused the file'));

    const { rows } = await ownerPool.query(
      `select a.released_at is not null as released, a.release_reason, c.cancelled_at is not null as charge_cancelled
         from bank_loan_allocation a join landed_cost_charge c on c.id = a.landed_cost_charge_id where a.loan_id = $1`,
      [made.id],
    );
    expect(rows).toEqual([
      { released: true, release_reason: expect.stringMatching(/rejected: Bank refused the file/), charge_cancelled: true },
    ]);
    expect((await eventsOf()).map((e) => e.event_code)).toContain('LOAN_UNLINKED');
    const view = await withScope(scope(world.manager), (tx) => loans.view(tx, made.loanNo));
    expect(view.totals.unallocated).toBe('1000000.0000');
  });

  it('equal shares are re-stated when a draw comes or goes', async () => {
    const made = await readyLoan({ allocationMethod: 'equal' });
    const a = await draft('100000', made.id);
    const b = await draft('200000', made.id);
    await approveApp(a.id);
    await approveApp(b.id);
    const shares = async () =>
      (
        await ownerPool.query(
          `select commission_share_txn from bank_loan_allocation where loan_id = $1 and released_at is null order by created_at`,
          [made.id],
        )
      ).rows.map((r) => r.commission_share_txn);
    expect(await shares()).toEqual(['10000.0000', '10000.0000']);
    await withScope(scope(world.manager), (tx) => applications.reject(tx, world.manager, a.id, 'Duplicate'));
    expect(await shares()).toEqual(['20000.0000']);
    const { rows: live } = await ownerPool.query(
      `select count(*)::int as n from landed_cost_charge where source_type = 'bank_loan_allocation' and cancelled_at is null`,
    );
    expect(live[0].n).toBe(1);
  });
});

describe('§15.6 · repayment', () => {
  it('in order, Dr liability Cr bank; the last instalment repays the loan in full', async () => {
    // C-20: the bank received 980,000 net of the 20,000 commission and repays
    // 1,000,000; the difference is money it already held.
    await fundBank(world, '20000.0000');
    const made = await readyLoan();
    const app = await draft('500000', made.id);
    await approveApp(app.id);
    const schedule = await scheduleOf(made.id);

    expect(
      await rejection(
        withScope(scope(world.manager), (tx) =>
          loans.payInstalment(tx, world.manager, schedule[1].id, { paidDate: '2026-10-15', reference: 'RAF-DR-2' }),
        ),
      ),
    ).toMatch(/Instalment 1 .* is still unpaid/);

    const pay = (index: number, on: string) =>
      withScope(scope(world.manager), (tx) =>
        loans.payInstalment(tx, world.manager, schedule[index].id, { paidDate: on, reference: `RAF-DR-${index + 1}` }),
      );
    const first = await pay(0, '2026-10-15');
    expect((await journalLines(first.journalEntryId)).map((l) => [l.line_role, l.debit, l.credit, l.loan_no])).toEqual([
      ['loan_liability', '250000.0000', '0.0000', made.loanNo],
      ['bank', '0.0000', '250000.0000', null],
    ]);
    expect((await eventsOf()).map((e) => e.event_code)).toContain('LOAN_INSTALMENT_PAID');
    await pay(1, '2026-11-15');
    await pay(2, '2026-12-15');
    const last = await pay(3, '2026-12-20');
    expect(last.fullyRepaid).toBe(true);
    expect((await loanRow(made.id)).status).toBe('fully_repaid');
    const { rows: ledger } = await ownerPool.query(
      `select sum(credit_iqd - debit_iqd)::text as owed from subledger_entry where subledger_type = 'loan' and party_code = $1`,
      [made.loanNo],
    );
    expect(ledger[0].owed).toBe('0.0000');
    expect(await rejection(pay(3, '2026-12-21'))).toMatch(/fully repaid|was paid/);
  });

  it('a spread commission and interest ride on each instalment', async () => {
    const made = await readyLoan({
      principalTxn: iqd('900000'),
      commissionPct: '1',
      commissionTreatmentCode: 'spread_over_instalments',
      interestPctPa: '12',
      instalmentCount: 3,
      frequency: 'monthly',
      firstDueDate: '2026-10-31',
    });
    const row = await loanRow(made.id);
    expect(row.net_proceeds_txn).toBe('900000.0000');
    const schedule = await scheduleOf(made.id);
    // 900,000 × 12 % × 31/365 for the first month (from 30 Sep), on the
    // declining balance after.
    expect(schedule.map((i) => [i.principal_txn, i.commission_txn, i.interest_txn])).toEqual([
      ['300000.0000', '3000.0000', '9172.6000'],
      ['300000.0000', '3000.0000', '5917.8100'],
      ['300000.0000', '3000.0000', '3057.5300'],
    ]);
    const paid = await withScope(scope(world.manager), (tx) =>
      loans.payInstalment(tx, world.manager, schedule[0].id, { paidDate: '2026-10-31', reference: 'RAF-DR-1' }),
    );
    expect((await journalLines(paid.journalEntryId)).map((l) => [l.line_role, l.debit, l.credit])).toEqual([
      ['loan_liability', '300000.0000', '0.0000'],
      ['loan_interest', '9172.6000', '0.0000'],
      ['landed_cost_clearing', '3000.0000', '0.0000'],
      ['bank', '0.0000', '312172.6000'],
    ]);
  });

  it('a commission paid on its own posts Dr clearing Cr bank, once', async () => {
    const made = await readyLoan({ commissionTreatmentCode: 'paid_separately' });
    expect((await loanRow(made.id)).net_proceeds_txn).toBe('1000000.0000');
    const pay = () =>
      withScope(scope(world.manager), (tx) =>
        loans.payCommission(tx, world.manager, made.id, { paidOn: '2026-09-06', reference: 'RAF-COM-1' }),
      );
    const { journalEntryId } = await pay();
    expect((await journalLines(journalEntryId)).map((l) => [l.line_role, l.debit, l.credit])).toEqual([
      ['landed_cost_clearing', '20000.0000', '0.0000'],
      ['bank', '0.0000', '20000.0000'],
    ]);
    expect(await rejection(pay())).toMatch(/was paid on 2026-09-06/);
  });
});

describe('§15.6 · the sweep, approvals, cancel', () => {
  it('due inside seven days, overdue after; the funded imports are told once', async () => {
    const made = await readyLoan({ instalmentCount: 2, frequency: 'monthly', firstDueDate: '2026-10-10' });
    const app = await draft('100000', made.id);
    await approveApp(app.id);
    const run = (asOf: string) => withScope({ userId: world.manager.principal.userId, branchCode: BAGHDAD, isSuperUser: true }, (tx) => sweep.runSweep(tx, asOf));

    const early = await run('2026-10-05');
    expect(early.loanInstalmentsDue).toBe(1);
    expect((await scheduleOf(made.id)).map((i) => i.status)).toEqual(['due', 'upcoming']);

    const late = await run('2026-10-12');
    expect(late.loanInstalmentsOverdue).toBe(1);
    await run('2026-10-13');
    const told = (await eventsOf()).filter((e) => e.event_code === 'LOAN_INSTALMENT_OVERDUE');
    expect(told).toHaveLength(1);
    expect(told[0]!.summary).toMatch(new RegExp(`${made.loanNo} instalment 1 .* was due on 2026-10-10`));
  });

  it('above the account’s limit only the CEO approves; within it the manager does', async () => {
    const manager = await userWith('accounting_manager');
    const made = await createLoan();
    expect(await rejection(approveLoan(made.id, manager))).toMatch(/no limit has been set.*the CEO approves it/);
    await ownerPool.query(`update bank_cash_account set approval_limit_iqd = 5000000 where id = $1`, [world.bankAccountId]);
    await approveLoan(made.id, manager);
    expect((await loanRow(made.id)).status).toBe('approved');
  });

  it('cancelled with a reason before the money arrives; never after; never deleted', async () => {
    const made = await createLoan();
    expect(await rejection(withScope(scope(world.clerk), (tx) => loans.cancel(tx, world.clerk, made.id, ' ')))).toMatch(/Say why/);
    await withScope(scope(world.clerk), (tx) => loans.cancel(tx, world.clerk, made.id, 'Bank withdrew the offer'));
    expect((await loanRow(made.id)).status).toBe('cancelled');

    const live = await readyLoan();
    expect(
      await rejection(withScope(scope(world.manager), (tx) => loans.cancel(tx, world.manager, live.id, 'Changed our mind'))),
    ).toMatch(/repaid, not cancelled/);

    const { rows } = await ownerPool.query(
      `select has_table_privilege('erp_app', t, 'DELETE') as can from unnest(array['bank_loan','bank_loan_instalment','bank_loan_allocation']) t`,
    );
    expect(rows.map((r) => r.can)).toEqual([false, false, false]);
  });

  it('refuses what is not a loan: a cash account, a commission as large as the loan, a custom schedule without its dates', async () => {
    const { rows: cash } = await ownerPool.query(
      `insert into bank_cash_account (code, name, account_type, currency, gl_account_id, custodian_user_id)
       values ('CASH-T','Till','cash','IQD',$1,$2) returning id`,
      [world.accounts.loan_interest, world.clerk.principal.userId],
    );
    expect(await rejection(createLoan({ bankCashAccountId: cash[0].id }))).toMatch(/land in a bank account/);
    expect(await rejection(createLoan({ commissionPct: '', commissionTxn: iqd('1000000') }))).toMatch(/less than the principal/);
    expect(await rejection(createLoan({ frequency: 'custom', customDates: ['2026-12-31'] }))).toMatch(/names each of its 4 due dates/);
  });

  it('a draft schedule is retyped; it must repay the principal exactly; an approved one is fixed', async () => {
    const made = await createLoan({ instalmentCount: 2, frequency: 'custom', customDates: ['2026-12-01', '2027-06-01'] });
    const set = (rows: loans.ScheduleRowInput[]) =>
      withScope(scope(world.clerk), (tx) => loans.setSchedule(tx, world.clerk, made.id, rows));
    expect(
      await rejection(set([{ dueDate: '2026-12-01', principalTxn: iqd('400000') }, { dueDate: '2027-06-01', principalTxn: iqd('500000') }])),
    ).toMatch(/short by 100,000\.00/);
    await set([
      { dueDate: '2026-11-15', principalTxn: iqd('400000'), interestTxn: iqd('5000') },
      { dueDate: '2027-05-15', principalTxn: iqd('600000') },
    ]);
    const schedule = await scheduleOf(made.id);
    expect(schedule.map((i) => [i.due_date, i.total_txn])).toEqual([
      ['2026-11-15', '405000.0000'],
      ['2027-05-15', '600000.0000'],
    ]);
    const { rows } = await ownerPool.query(`select count(*)::int as n from bank_loan_instalment where loan_id = $1 and superseded_at is not null`, [made.id]);
    expect(rows[0].n).toBe(2);
    await approveLoan(made.id);
    expect(await rejection(set([{ dueDate: '2027-01-01', principalTxn: iqd('1000000') }]))).toMatch(/fixed when it was approved/);
  });
});
