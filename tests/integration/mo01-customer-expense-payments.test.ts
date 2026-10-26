/**
 * 0428 — Customer Payment, Expense Payment, and a customer's currency (2026-10-26).
 *
 * By direction: "a customer account … the only transactions should be receipts and payments … for
 * payments I don't want to use bank transfers or material returns … add a currency selection field
 * when creating a customer … and general expenses".
 *
 *   MO1  a customer payment, written by one person and approved and posted by another, debits the
 *        customer's receivable and credits the bank; the customer's statement shows it beside nothing
 *        else, and the subledger still ties to its control account
 *   MO2  four eyes: the writer cannot approve their own (a super user alone excepted), in the service
 *        and in the database
 *   MO3  from a USD account: the amount in dollars, the bank line in dollars, the dinars at the
 *        payment date's rate
 *   MO4  reversed with a reason: its journal mirrored, the balance back, the status final
 *   MO5  cancelled with a reason; a posted one is reversed, not cancelled; the database keeps a
 *        payment's amount after draft and never deletes one
 *   MO6  an expense payment debits the expense account named and credits the bank; a control
 *        account is refused, by the service and by the database
 *   MO7  a customer's currency: set when the customer is made, refused when it is not a currency in use
 *   MO8  the printed copies carry how each posts
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as customerPayments from '@/server/services/customer-payment';
import * as expensePayments from '@/server/services/expense-payment';
import * as partners from '@/server/services/partners';
import * as statement from '@/server/services/partner-statement';
import * as subledger from '@/server/services/subledger';
import * as documents from '@/server/print/money-out-documents';
import { messagesFor } from '@/server/print/i18n';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import { fundLedger, openingFundsAccount } from './funds';

const BAGHDAD = 'BGW';
const ON = '2026-02-15';
const money = (value: string) => parseDecimal(value, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let customerId: string;
let bankId: string;
let usdBankId: string;
let receivableId: string;
let expenseAccountId: string;

async function createUser(roles: string, superUser = false): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [id, `${id}@example.com`, roles, superUser]);
  for (const code of roles.split('+')) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, code]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const as = <T,>(actor: ActorContext, run: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: actor.principal.userId, branchCode: BAGHDAD, isSuperUser: actor.principal.isSuperUser }, run);

async function leaf(code: string, name: string, parent: string, restriction: string, control: string | null = null): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction, control_account)
     select $1, $2, account_type, id, false, true, 'approved', 1, $4, $5 from chart_of_account where code = $3
     returning id`,
    [code, name, parent, restriction, control],
  );
  return rows[0].id as string;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  const { rows: years } = await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status) values ('FY2026','2026','2026-01-01','2026-12-31','open') returning id`,
  );
  for (let month = 1; month <= 12; month += 1) {
    const start = `2026-${String(month).padStart(2, '0')}-01`;
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1, $2, $3, $4::date, ($4::date + interval '1 month' - interval '1 day')::date)`,
      [years[0].id, month, `2026-${month}`, start],
    );
  }
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: customers } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, status, active) values ('CUS-PAY','Al Waha Solar', true, 'active', true) returning id`,
  );
  customerId = customers[0].id;

  // The receivable a customer payment debits: the receipt's own rule, which 0428 copies.
  receivableId = await leaf('A9TRADE', 'Trade Receivables', 'A000001', 'IQD', 'customer');
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ('sales.customer_payment','customer_receivable',$1,true,$2)`,
    [receivableId, manager.principal.userId],
  );
  expenseAccountId = await leaf('X9RENT', 'Office rent', 'X000001', 'IQD');

  // The dinar bank seedBranch made, funded; and a dollar bank on a USD-only ledger account, funded in dollars.
  const { rows: banks } = await ownerPool.query(`select id, gl_account_id from bank_cash_account where code = 'CASH-BGW'`);
  bankId = banks[0].id;
  const contra = await openingFundsAccount();
  await fundLedger({ glAccountId: banks[0].gl_account_id, contraAccountId: contra, amountIqd: '100000000.0000', branchCode: BAGHDAD, userId: manager.principal.userId, on: '2026-01-02' });
  const usdLedger = await leaf('A9USDBANK', 'Dollar bank', 'A000001', 'USD');
  const { rows: usd } = await ownerPool.query(
    `insert into bank_cash_account (code, name, account_type, bank_name, account_number, gl_account_id, currency)
     values ('BANK-USD','Dollar account','bank','Seed Bank','USD-1',$1,'USD') returning id`,
    [usdLedger],
  );
  usdBankId = usd[0].id;
  const { rows: periods } = await ownerPool.query(`select id from fiscal_period where starts_on = '2026-01-01'`);
  const { rows: entry } = await ownerPool.query(
    `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
     values ('FUND-USD', '2026-01-02', '2026-01-02', $1, $2, 'Dollar funds for tests', 'draft', 13100000, 13100000, $3) returning id`,
    [periods[0].id, BAGHDAD, manager.principal.userId],
  );
  await ownerPool.query(
    `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
     values ($1, 1, $2, 10000, 0, 13100000, 0, 10000, 0, 'USD', $4), ($1, 2, $3, 0, 13100000, 0, 13100000, 0, 10000, 'IQD', $4)`,
    [entry[0].id, usdLedger, contra, BAGHDAD],
  );
  await ownerPool.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, manager.principal.userId]);
});

const payCustomer = (actor: ActorContext, amount: string, account = bankId) =>
  as(actor, (tx) =>
    customerPayments.create(tx, actor, {
      customerId,
      bankCashAccountId: account,
      branchCode: BAGHDAD,
      paymentDate: ON,
      amount: money(amount),
      purpose: 'Overpayment returned',
      reference: 'CHQ-77',
    }),
  );

const linesOf = async (paymentNo: string, table: 'customer_payment' | 'expense_payment') => {
  const { rows } = await ownerPool.query(
    `select a.code, l.currency, l.debit_txn::float as debit_txn, l.credit_txn::float as credit_txn, l.debit_iqd::float as debit, l.credit_iqd::float as credit, l.business_partner_code as partner
       from ${table} p join journal_line l on l.journal_entry_id = p.journal_entry_id join chart_of_account a on a.id = l.account_id
      where p.payment_no = $1 order by l.line_no`,
    [paymentNo],
  );
  return rows;
};

describe('MO1–MO5 · Customer Payment', () => {
  it('MO1 · debits the customer and credits the bank; the statement shows it, and the subledger ties', async () => {
    const made = await payCustomer(clerk, '2500000');
    expect(made.paymentNo).toMatch(/^CPY-BGW-2026-\d{6}$/);
    const posted = await as(manager, (tx) => customerPayments.approveAndPost(tx, manager, made.id));
    expect(posted.entryNo).toBeTruthy();

    expect(await linesOf(made.paymentNo, 'customer_payment')).toEqual([
      expect.objectContaining({ code: 'A9TRADE', debit: 2_500_000, credit: 0, partner: 'CUS-PAY' }),
      expect.objectContaining({ code: 'CASH-BGW', debit: 0, credit: 2_500_000 }),
    ]);
    const row = await as(manager, (tx) => customerPayments.viewByNo(tx, made.paymentNo));
    expect(row).toEqual(expect.objectContaining({ status: 'posted', customerCode: 'CUS-PAY', journalEntryNo: posted.entryNo }));

    // The customer's statement: the payment, named as itself, and the balance it leaves.
    const account = await as(manager, (tx) => statement.statementFor(tx, 'customer', 'CUS-PAY', { to: '2026-12-31' }));
    expect(account.lines.map((line) => line.document)).toEqual([{ kind: 'customer_payment', number: made.paymentNo, dueDate: null }]);
    expect(Number(account.closing)).toBe(2_500_000);
    // The customer subledger and its control account agree, to the dinar.
    const tie = await as(manager, (tx) => subledger.reconciliation(tx, '2026-12-31'));
    const trade = tie.find((row) => row.accountCode === 'A9TRADE');
    expect(trade).toEqual(expect.objectContaining({ subledgerType: 'customer' }));
    expect(Number(trade!.subledgerBalance)).toBe(2_500_000);
    expect(Number(trade!.generalLedgerBalance)).toBe(2_500_000);
  });

  it('MO2 · the writer cannot approve their own; a super user alone may', async () => {
    const made = await payCustomer(clerk, '1000');
    // The clerk holds no approve; the manager who wrote one cannot approve it either.
    const own = await payCustomer(manager, '1000');
    await expect(as(manager, (tx) => customerPayments.approve(tx, manager, own.id))).rejects.toThrow(/somebody else approves it/);
    // The database says the same if the service is gone around.
    await expect(
      ownerPool.query(`update customer_payment set status = 'approved', approved_by = created_by, approved_at = now() where id = $1`, [own.id]),
    ).rejects.toThrow(/customer_payment_four_eyes/);
    // A super user approves what they wrote (0278).
    const superUser = await createUser('accounting_manager', true);
    const theirs = await payCustomer(superUser, '1000');
    await as(superUser, (tx) => customerPayments.approveAndPost(tx, superUser, theirs.id));
    const { rows } = await ownerPool.query(`select status from customer_payment where id = $1`, [theirs.id]);
    expect(rows[0].status).toBe('posted');
    expect(made.id).toBeTruthy();
  });

  it('MO3 · from a USD account: dollars on the bank line, dinars at the day\'s rate on the customer', async () => {
    const made = await payCustomer(clerk, '250', usdBankId);
    const row = await as(clerk, (tx) => customerPayments.viewByNo(tx, made.paymentNo));
    expect(row).toEqual(expect.objectContaining({ currency: 'USD' }));
    expect(Number(row!.amount)).toBe(250);
    expect(Number(row!.amountIqd)).toBe(327_500);
    await as(manager, (tx) => customerPayments.approveAndPost(tx, manager, made.id));
    expect(await linesOf(made.paymentNo, 'customer_payment')).toEqual([
      expect.objectContaining({ code: 'A9TRADE', currency: 'IQD', debit: 327_500 }),
      expect.objectContaining({ code: 'A9USDBANK', currency: 'USD', credit_txn: 250, credit: 327_500 }),
    ]);
  });

  it('MO4 · reversed with a reason: the journal mirrored, the balance back, final', async () => {
    const made = await payCustomer(clerk, '400000');
    await as(manager, (tx) => customerPayments.approveAndPost(tx, manager, made.id));
    await expect(as(manager, (tx) => customerPayments.reverse(tx, manager, made.id, '  '))).rejects.toThrow(/Say why/);
    const back = await as(manager, (tx) => customerPayments.reverse(tx, manager, made.id, 'Paid to the wrong customer'));
    const row = await as(manager, (tx) => customerPayments.viewByNo(tx, made.paymentNo));
    expect(row).toEqual(expect.objectContaining({ status: 'reversed', reversalEntryNo: back.entryNo, reversalReason: 'Paid to the wrong customer' }));
    const account = await as(manager, (tx) => statement.statementFor(tx, 'customer', 'CUS-PAY', { to: '2026-12-31' }));
    expect(Number(account.closing)).toBe(0);
    await expect(as(manager, (tx) => customerPayments.reverse(tx, manager, made.id, 'again'))).rejects.toThrow(/only a posted payment/);
    await expect(ownerPool.query(`update customer_payment set status = 'posted' where id = $1`, [made.id])).rejects.toThrow(/does not change again/);
  });

  it('MO5 · cancelled with a reason; a posted one is not cancelled; what it pays is fixed after draft; never deleted', async () => {
    const draft = await payCustomer(clerk, '5000');
    await as(clerk, (tx) => customerPayments.cancel(tx, clerk, draft.id, 'Entered twice'));
    const { rows } = await ownerPool.query(`select status, cancel_reason from customer_payment where id = $1`, [draft.id]);
    expect(rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'Entered twice' });

    const posted = await payCustomer(clerk, '6000');
    await as(manager, (tx) => customerPayments.approve(tx, manager, posted.id));
    await expect(ownerPool.query(`update customer_payment set amount = 1 where id = $1`, [posted.id])).rejects.toThrow(/changed only in draft/);
    await as(manager, (tx) => customerPayments.post(tx, manager, posted.id));
    await expect(as(manager, (tx) => customerPayments.cancel(tx, manager, posted.id, 'no'))).rejects.toThrow(/reversed, not cancelled/);
    await expect(ownerPool.query(`delete from customer_payment where id = $1`, [posted.id])).rejects.toThrow();
  });
});

describe('MO6 · Expense Payment', () => {
  it('debits the expense account named and credits the bank; refuses a control account', async () => {
    const made = await as(clerk, (tx) =>
      expensePayments.create(tx, clerk, {
        bankCashAccountId: bankId,
        branchCode: BAGHDAD,
        paymentDate: ON,
        amount: money('750000'),
        expenseAccountId,
        departmentCode: 'FIN',
        payee: 'Karada office landlord',
        purpose: 'February rent',
      }),
    );
    expect(made.paymentNo).toMatch(/^EXV-BGW-2026-\d{6}$/);
    await as(manager, (tx) => expensePayments.approveAndPost(tx, manager, made.id));
    expect(await linesOf(made.paymentNo, 'expense_payment')).toEqual([
      expect.objectContaining({ code: 'X9RENT', debit: 750_000, credit: 0 }),
      expect.objectContaining({ code: 'CASH-BGW', debit: 0, credit: 750_000 }),
    ]);

    await expect(
      as(clerk, (tx) =>
        expensePayments.create(tx, clerk, {
          bankCashAccountId: bankId,
          branchCode: BAGHDAD,
          paymentDate: ON,
          amount: money('1000'),
          expenseAccountId: receivableId,
          payee: 'Somebody',
          purpose: 'Not an expense',
        }),
      ),
    ).rejects.toThrow(/control account/);
    await expect(
      ownerPool.query(`update expense_payment set expense_account_id = $1 where id = $2`, [receivableId, made.id]),
    ).rejects.toThrow(/control account|changed only in draft/);
  });
});

describe('MO7 · a customer\'s currency', () => {
  it('is kept when the customer is made, and refused when it is not a currency in use', async () => {
    const made = await as(manager, (tx) => partners.createInRole(tx, manager, 'customer', { legalName: 'Dollar Customer Co', currency: 'USD' }));
    const { rows } = await ownerPool.query(`select currency from business_partner where id = $1`, [made.id]);
    expect(rows[0].currency.trim()).toBe('USD');
    const { rows: audited } = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'business_partner.currency_set' and object_id = $1`, [made.id]);
    expect(audited[0].n).toBe(1);
    await expect(as(manager, (tx) => partners.createInRole(tx, manager, 'customer', { legalName: 'Nowhere Co', currency: 'XYZ' }))).rejects.toThrow(/not a currency in use/);
  });
});

describe('MO8 · the printed copies', () => {
  it('carry how each posts, in the reader\'s language', async () => {
    const made = await payCustomer(clerk, '2500000');
    await as(manager, (tx) => customerPayments.approveAndPost(tx, manager, made.id));
    const built = await as(manager, (tx) =>
      documents.customerPayment({ tx, principal: manager.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, made.paymentNo),
    );
    expect(built!.model.title).toBe('Customer Payment');
    const table = built!.model.tables[0]!;
    expect(table.rows.map((row) => [row.cells.debit, row.cells.credit])).toEqual([
      ['2500000.0000', null],
      [null, '2500000.0000'],
    ]);
    expect(built!.model.amountInWords).toEqual({ amount: '2500000.0000', currency: 'IQD' });
  });
});
