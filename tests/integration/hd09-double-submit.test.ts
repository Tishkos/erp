/**
 * REQ-HARDEN-001 HD9 — a double submit posts exactly once.
 *
 * The transitions the audit found reading unlocked rows now lock them
 * (`SELECT … FOR UPDATE`): two concurrent confirms of one payment
 * application, two repayments of one instalment, two locks of one landed
 * cost, two status changes of one PD. One wins; the other reads the new
 * status and is refused; the books carry one posting.
 *
 * The fixture is the Stage 6 loan test's, verbatim.
 *
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


const confirmApp = (id: string) =>
  withScope(scope(world.manager), (tx) =>
    applications.confirm(tx, world.manager, id, { confirmedOn: '2026-09-20', reference: 'MT103-HD9' }),
  );
const sendApp = (id: string) =>
  withScope(scope(world.manager), (tx) => applications.send(tx, world.manager, id, { applicationDate: '2026-09-12' }));

describe('HD9 · double submits', () => {
  it('two concurrent confirms of one payment application post one supplier payment and draw the loan once', async () => {
    const made = await readyLoan();
    const app = await draft('500000', made.id);
    await approveApp(app.id);
    await sendApp(app.id);
    const { rows: invoice } = await ownerPool.query(`select id from ap_invoice where payable_id = $1`, [payableId]);
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoice[0].id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoice[0].id));

    const outcomes = await Promise.allSettled([confirmApp(app.id), confirmApp(app.id)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    const { rows: payments } = await ownerPool.query(`select count(*)::int as n from supplier_payment where supplier_id = $1`, [world.supplierId]);
    expect(payments[0].n).toBe(1);
    const { rows: draws } = await ownerPool.query(
      `select count(*)::int as n from bank_loan_allocation where loan_id = $1 and released_at is null`,
      [made.id],
    );
    expect(draws[0].n).toBe(1);
  });

  it('two concurrent repayments of one instalment post once', async () => {
    const made = await readyLoan();
    const schedule = await scheduleOf(made.id);
    const pay = () =>
      withScope(scope(world.manager), (tx) =>
        loans.payInstalment(tx, world.manager, schedule[0].id, { paidDate: '2026-10-15', reference: 'RAF-DR-1' }),
      );
    const outcomes = await Promise.allSettled([pay(), pay()]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from journal_entry where source_module = 'treasury' and source_event = 'repaid' and source_doc_id = $1`,
      [schedule[0].id],
    );
    expect(rows[0].n).toBe(1);
    const { rows: ledger } = await ownerPool.query(
      `select sum(debit_iqd)::text as repaid from subledger_entry where subledger_type = 'loan' and party_code = $1`,
      [made.loanNo],
    );
    expect(ledger[0].repaid).toBe('250000.0000');
  });

  it('two concurrent status changes of one PD leave one history row for the change', async () => {
    const { rows: pd } = await ownerPool.query(`select id from customs_pd where pd_no = '7700'`);
    const change = () =>
      withScope(scope(world.clerk), (tx) =>
        customs.changeStatus(tx, world.clerk, pd[0].id, { statusCode: 'totally_written_off', effectiveDate: '2026-09-21' }),
      );
    const outcomes = await Promise.allSettled([change(), change()]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from customs_pd_status_history where pd_id = $1 and status_code = 'totally_written_off'`,
      [pd[0].id],
    );
    expect(rows[0].n).toBe(1);
  });
});
