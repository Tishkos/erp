/**
 * REQ-AP-001 Stage 3 — payments & bank (§15.1–§15.6).
 *
 *   A11  Sending a payment application without funds / to an unverified
 *        supplier bank account is refused with a message naming the cause;
 *        a manager's override with a reason is stored and logged; an
 *        officer's is not accepted. (The PD check is Stage 4's and warns
 *        until the PD register exists.)
 *   A12  Approval reserves funds; rejection releases; confirmation (SWIFT,
 *        transfer, cash, cheque) posts the right document dated the
 *        confirmation date and allocates it; `settled_amount_iqd` changes
 *        only then; the posted document carries `amount_txn` + currency.
 *
 * Plus the instalment plan (§15.2), the maker-checker on approval, D3 (no
 * payment from an account in another currency), Applied / Paid / Remaining
 * (§15.5), debit final (§15.4) and the sweep's SWIFT clock (§15.4, D4).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as sweep from '@/server/services/payables-sweep';
import * as treasury from '@/server/services/treasury';
import * as banks from '@/server/services/bank-cash-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import {
  BAGHDAD,
  PANEL,
  WAREHOUSE,
  buildTradingWorld,
  scope,
  type TradingWorld,
} from './trading-fixture';

let world: TradingWorld;
let payableId: string;
let payableNo: string;
let invoiceId: string;
let payeeId: string;
let serial = 0;

const SWIFT = 'PM-T001';
const TRANSFER = 'PM-T002';
const CASH = 'PM-T003';
const CHEQUE = 'PM-T004';
const iqd = (value: string) => parseDecimal(value, 4n);

/** Money in an account's G/L, posted as a real journal. */
async function fund(glAccountId: string, amount: string, on = '2026-09-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Owner deposit','draft',$5,$5,$6) returning id`,
      [`FUND-AP03-${(serial += 1)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, glAccountId, amount, world.accounts.grni, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, world.manager.principal.userId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** An import of 100 panels at 10,000 IQD — 1,000,000 IQD owed. */
async function importInvoice(reference = 'CSA-PAY-0001') {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      paymentTermsText: '30% deposit, 70% against B/L copy',
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity('100'),
          unitPriceIqd: iqd('10000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(
    `select p.id, p.payable_no from payable p join ap_invoice i on i.payable_id = p.id where i.id = $1`,
    [made.id],
  );
  return { invoiceId: made.id, payableId: rows[0].id as string, payableNo: rows[0].payable_no as string };
}

async function postInvoice() {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
}

async function plan30_70() {
  await withScope(scope(world.clerk), (tx) =>
    applications.planInstalments(tx, world.clerk, {
      payableId,
      rows: [
        { label: 'Deposit', basis: 'percent', percent: '30', triggerCode: 'on_order' },
        { label: 'Balance', basis: 'percent', percent: '70', triggerCode: 'against_bl_copy' },
      ],
    }),
  );
  return withScope(scope(world.clerk), (tx) => applications.instalmentsFor(tx, payableId));
}

async function draft(input: Partial<applications.CreateInput> = {}) {
  return withScope(scope(world.clerk), (tx) =>
    applications.create(tx, world.clerk, {
      payableId,
      paymentMethodCode: SWIFT,
      bankCashAccountId: world.bankAccountId,
      payeeBankAccountId: payeeId,
      amountTxn: iqd('300000'),
      onDate: '2026-09-10',
      ...input,
    }),
  );
}

const approve = (id: string) =>
  withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, id));
const send = (id: string, by = world.clerk, overrideReason?: string) =>
  withScope(scope(by), (tx) =>
    applications.send(tx, by, id, { applicationDate: '2026-09-10', bankReference: 'MANS-77', overrideReason: overrideReason ?? null }),
  );
const confirm = (id: string, on = '2026-09-14', reference = 'MT103-0001') =>
  withScope(scope(world.manager), (tx) =>
    applications.confirm(tx, world.manager, id, { confirmedOn: on, reference }),
  );

const statusOf = async (id: string) => {
  const { rows } = await ownerPool.query(`select * from payment_application where id = $1`, [id]);
  return rows[0];
};
const eventsOf = async () => {
  const { rows } = await ownerPool.query(
    `select event_code, summary from payable_event where payable_id = $1 order by recorded_at, id`,
    [payableId],
  );
  return rows as { event_code: string; summary: string }[];
};
const position = () =>
  withScope(scope(world.manager), (tx) => treasury.accountPosition(tx, world.bankAccountId));

beforeEach(async () => {
  world = await buildTradingWorld();
  for (const [code, name, kind, confirmation] of [
    [SWIFT, 'SWIFT transfer', 'bank', 'swift'],
    [TRANSFER, 'Local transfer', 'bank', 'transfer'],
    [CASH, 'Cash', 'cash', 'cash'],
    [CHEQUE, 'Cheque', 'bank', 'cheque'],
  ] as const) {
    await ownerPool.query(
      `insert into payment_method (code, name, kind, confirmation_kind) values ($1,$2,$3,$4)`,
      [code, name, kind, confirmation],
    );
  }
  const { rows: payee } = await ownerPool.query(
    `insert into partner_bank_account
       (partner_id, bank_name, account_number, swift, currency, approval_status, is_active)
     values ($1,'Bank of China','CN-6217-0001','BKCHCNBJ','IQD','approved',true) returning id`,
    [world.supplierId],
  );
  payeeId = payee[0].id;
  ({ invoiceId, payableId, payableNo } = await importInvoice());
});

// ---------------------------------------------------------------------------
// §15.2 — the plan
// ---------------------------------------------------------------------------

describe('§15.2 · the instalment plan', () => {
  it('30% / 70% of what is owed, logged, and a plan that does not add up is refused', async () => {
    const plan = await plan30_70();
    expect(plan.map((i) => [i.sequence, i.label, i.amountTxn, i.status])).toEqual([
      [1, 'Deposit', '300000.0000', 'planned'],
      [2, 'Balance', '700000.0000', 'planned'],
    ]);
    const log = await eventsOf();
    expect(log.map((e) => e.event_code)).toContain('INSTALMENT_PLANNED');

    const short = await rejection(
      withScope(scope(world.clerk), (tx) =>
        applications.planInstalments(tx, world.clerk, {
          payableId,
          rows: [
            { label: 'Deposit', basis: 'percent', percent: '30', triggerCode: 'on_order' },
            { label: 'Balance', basis: 'percent', percent: '60', triggerCode: 'against_bl_copy' },
          ],
        }),
      ),
    );
    expect(short).toMatch(/short by 100,000\.00/);
  });

  it('a third of an amount rounds into the last instalment; re-planning supersedes, never rewrites', async () => {
    await withScope(scope(world.clerk), (tx) =>
      applications.planInstalments(tx, world.clerk, {
        payableId,
        rows: [
          { label: '1st', basis: 'percent', percent: '33.3333', triggerCode: 'on_order' },
          { label: '2nd', basis: 'percent', percent: '33.3333', triggerCode: 'before_shipment' },
          { label: '3rd', basis: 'percent', percent: '33.3334', triggerCode: 'days_after_invoice', triggerDays: 60 },
        ],
      }),
    );
    const plan = await withScope(scope(world.clerk), (tx) => applications.instalmentsFor(tx, payableId));
    const total = plan.reduce((sum, i) => sum + parseDecimal(i.amountTxn, 4n), 0n);
    expect(total).toBe(iqd('1000000'));
    // days_after_invoice derives its date from the invoice (2026-09-01 + 60).
    expect(plan[2]!.expectedDate).toBe('2026-10-31');

    await plan30_70();
    const { rows } = await ownerPool.query(
      `select count(*) filter (where superseded_at is null)::int as live,
              count(*) filter (where superseded_at is not null)::int as superseded
         from payable_instalment where payable_id = $1`,
      [payableId],
    );
    expect(rows[0]).toEqual({ live: 2, superseded: 3 });
  });
});

// ---------------------------------------------------------------------------
// A11 — the checks on Send
// ---------------------------------------------------------------------------

describe('A11 · ap03-payment-checks', () => {
  it('without funds Send is refused naming the account; an officer cannot override, a manager can', async () => {
    const made = await draft();
    await approve(made.id);

    const refused = await rejection(send(made.id));
    expect(refused).toMatch(/available against 300,000\.00 IQD/);

    const officer = await rejection(send(made.id, world.clerk, 'CEO said so'));
    expect(officer).toMatch(/available against/);

    await send(made.id, world.manager, 'Owner deposit arrives this afternoon');
    const row = await statusOf(made.id);
    expect(row.status).toBe('sent');
    expect(row.overridden_checks).toEqual(['funds']);
    expect(row.override_reason).toBe('Owner deposit arrives this afternoon');
    expect((await eventsOf()).map((e) => e.event_code)).toEqual(
      expect.arrayContaining(['CHECK_OVERRIDDEN', 'PAYMENT_APPLIED', 'SWIFT_PENDING']),
    );
  });

  it('an unverified supplier bank account refuses Send with the cause', async () => {
    await fund(world.accounts.bank!, '5000000');
    await ownerPool.query(`update partner_bank_account set approval_status = 'submitted', is_active = false where id = $1`, [payeeId]);
    const made = await draft();
    await approve(made.id);
    const refused = await rejection(send(made.id));
    expect(refused).toMatch(/CN-6217-0001 is not verified/);

    // A SWIFT with no supplier account named at all is refused too.
    const none = await draft({ payeeBankAccountId: null, amountTxn: iqd('100000') });
    await approve(none.id);
    expect(await rejection(send(none.id))).toMatch(/Name the supplier bank account/);
  });

  it('the PD check warns until the PD register exists, and does not refuse', async () => {
    await fund(world.accounts.bank!, '5000000');
    const made = await draft();
    const checks = await withScope(scope(world.clerk), async (tx) =>
      applications.checksFor(tx, await applications.loadByNo(tx, made.applicationNo)),
    );
    expect(checks.find((c) => c.code === 'pd_validated')?.outcome).toBe('warning');
    expect(checks.find((c) => c.code === 'funds')?.outcome).toBe('pass');
    expect(checks.find((c) => c.code === 'payee_account')?.outcome).toBe('pass');
  });

  it('the maker cannot approve; D3 refuses an account in another currency; never more than is owed', async () => {
    const made = await draft();
    const own = await rejection(
      withScope(scope(world.clerk), (tx) => applications.approve(tx, world.clerk, made.id)),
    );
    expect(own).not.toBe('');

    // An officer does not hold approve at all; a manager who drafted cannot approve his own.
    const mine = await withScope(scope(world.manager), (tx) =>
      applications.create(tx, world.manager, {
        payableId,
        paymentMethodCode: SWIFT,
        bankCashAccountId: world.bankAccountId,
        payeeBankAccountId: payeeId,
        amountTxn: iqd('100000'),
      }),
    );
    expect(
      await rejection(withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, mine.id))),
    ).toMatch(/cannot approve it/);

    const { rows: gl } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       select 'A9USD01', 'Bank USD', account_type, id, false, true, 'approved', 1, 'USD' from chart_of_account where code = 'A000001'
       returning id`,
    );
    const usd = await withScope(scope(world.manager), (tx) =>
      banks.create(tx, world.manager, 'bank', {
        name: 'Mansour USD',
        bankName: 'Mansour Bank',
        accountNumber: 'MB-USD-1',
        currency: 'USD',
        glAccountId: gl[0].id,
      }),
    );
    const { rows: usdRow } = await ownerPool.query(`select id from bank_cash_account where code = $1`, [usd.code]);
    expect(await rejection(draft({ bankCashAccountId: usdRow[0].id }))).toMatch(/holds USD .* is in IQD \(D3\)/);

    expect(await rejection(draft({ amountTxn: iqd('900000') }))).toMatch(/more than is left to ask the bank for/);
  });

  it('one live application per instalment; a rejected one frees it', async () => {
    const [deposit] = await plan30_70();
    const first = await draft({ instalmentId: deposit!.id, amountTxn: null });
    expect((await statusOf(first.id)).amount_txn).toBe('300000.0000');
    expect(await rejection(draft({ instalmentId: deposit!.id, amountTxn: null }))).toMatch(
      /already has .* only after the first is rejected or cancelled/,
    );
    await approve(first.id);
    await withScope(scope(world.manager), (tx) =>
      applications.reject(tx, world.manager, first.id, 'Bank asked for the PD copy'),
    );
    const second = await draft({ instalmentId: deposit!.id, amountTxn: null });
    expect(second.applicationNo).toMatch(/^PAYAPP-/);
  });
});

// ---------------------------------------------------------------------------
// A12 — reserve, release, confirm
// ---------------------------------------------------------------------------

describe('A12 · ap03-reserve-and-confirm', () => {
  it('approval reserves, rejection releases', async () => {
    await fund(world.accounts.bank!, '5000000');
    const before = await position();
    expect(before.committedIqd).toBe(0n);

    const made = await draft();
    await approve(made.id);
    expect((await position()).committedIqd).toBe(iqd('300000'));
    expect((await position()).availableIqd).toBe(iqd('4700000'));

    await withScope(scope(world.manager), (tx) =>
      applications.reject(tx, world.manager, made.id, 'Bank refused: beneficiary name mismatch'),
    );
    expect((await position()).committedIqd).toBe(0n);
    const codes = (await eventsOf()).map((e) => e.event_code);
    expect(codes).toEqual(expect.arrayContaining(['FUNDS_RESERVED', 'PAYMENT_REJECTED', 'FUNDS_RELEASED']));

    // Rejected needs its reason; nothing is deleted.
    const { rows } = await ownerPool.query(`select status, closed_reason from payment_application where id = $1`, [made.id]);
    expect(rows[0]).toEqual({ status: 'rejected', closed_reason: 'Bank refused: beneficiary name mismatch' });
  });

  it('a SWIFT deposit before the invoice posts becomes a posted supplier advance dated the SWIFT date', async () => {
    await fund(world.accounts.bank!, '5000000');
    const [deposit] = await plan30_70();
    const made = await draft({ instalmentId: deposit!.id, amountTxn: null });
    await approve(made.id);
    await send(made.id);

    // Sent is not paid: the invoice and the books are untouched.
    const { rows: unsettled } = await ownerPool.query(`select settled_amount_iqd from ap_invoice where id = $1`, [invoiceId]);
    expect(unsettled[0].settled_amount_iqd).toBe('0.0000');
    expect((await position()).committedIqd).toBe(iqd('300000'));

    const confirmed = await confirm(made.id, '2026-09-14', 'MT103-DEP-1');
    expect(confirmed.supplierAdvanceId).toBeTruthy();

    const { rows } = await ownerPool.query(
      `select status::text as status, paid_date::text as paid, amount_iqd, amount_txn, currency, payable_id,
              created_by, approved_by
         from supplier_advance where id = $1`,
      [confirmed.supplierAdvanceId],
    );
    expect(rows[0]).toMatchObject({
      status: 'posted',
      paid: '2026-09-14',
      amount_iqd: '300000.0000',
      amount_txn: '300000.0000',
      currency: 'IQD',
      payable_id: payableId,
      // The application's maker requested it; its approver approved it.
      created_by: world.clerk.principal.userId,
      approved_by: world.manager.principal.userId,
    });
    expect((await statusOf(made.id)).status).toBe('confirmed');
    // Reservation released, Booked fell.
    const after = await position();
    expect(after.committedIqd).toBe(0n);
    expect(after.balanceIqd).toBe(iqd('4700000'));
    expect((await eventsOf()).map((e) => e.event_code)).toContain('SWIFT_CONFIRMED');

    // §15.5 — Applied / Paid / Remaining.
    const totals = await withScope(scope(world.clerk), (tx) => applications.totalsFor(tx, payableId));
    expect(totals.paidTxn).toBe(iqd('300000'));
    expect(totals.remainingTxn).toBe(iqd('700000'));
    expect(totals.fullyPaid).toBe(false);
  });

  it('a transfer after the invoice posts becomes a supplier payment allocated to it — settled only at confirmation', async () => {
    await fund(world.accounts.bank!, '5000000');
    await postInvoice();
    const made = await draft({ paymentMethodCode: TRANSFER, amountTxn: iqd('1000000') });
    await approve(made.id);
    await send(made.id);
    const { rows: before } = await ownerPool.query(`select settled_amount_iqd from ap_invoice where id = $1`, [invoiceId]);
    expect(before[0].settled_amount_iqd).toBe('0.0000');

    const confirmed = await confirm(made.id, '2026-09-12', 'RAF-TRF-889');
    const { rows: payment } = await ownerPool.query(
      `select status::text as status, payment_date::text as paid, reference, amount_txn, currency, allocated_amount_iqd
         from supplier_payment where id = $1`,
      [confirmed.supplierPaymentId],
    );
    expect(payment[0]).toMatchObject({
      status: 'posted',
      paid: '2026-09-12',
      reference: 'RAF-TRF-889',
      amount_txn: '1000000.0000',
      currency: 'IQD',
      allocated_amount_iqd: '1000000.0000',
    });
    const { rows: after } = await ownerPool.query(`select settled_amount_iqd from ap_invoice where id = $1`, [invoiceId]);
    expect(after[0].settled_amount_iqd).toBe('1000000.0000');

    const codes = (await eventsOf()).map((e) => e.event_code);
    expect(codes).toEqual(expect.arrayContaining(['TRANSFER_CONFIRMED', 'FULLY_PAID']));
    const { rows: stage } = await ownerPool.query(`select stage_code from payable where id = $1`, [payableId]);
    expect(stage[0].stage_code).toBeTruthy();

    // §15.4 — debit final, by hand when the account is not reconciled here.
    await withScope(scope(world.manager), (tx) =>
      applications.recordDebit(tx, world.manager, made.id, { debitDate: '2026-09-13' }),
    );
    expect((await statusOf(made.id)).status).toBe('debited');
    expect((await eventsOf()).map((e) => e.event_code)).toContain('DEBIT_FINAL');
  });

  it('a cheque and a cash payment each post a supplier payment with their own proof', async () => {
    await fund(world.accounts.bank!, '5000000');
    await postInvoice();

    const cheque = await draft({ paymentMethodCode: CHEQUE, payeeBankAccountId: null, amountTxn: iqd('400000') });
    await approve(cheque.id);
    await send(cheque.id);
    // A cheque needs its number.
    expect(await rejection(confirm(cheque.id, '2026-09-15', '  '))).toMatch(/cheque number/);
    await confirm(cheque.id, '2026-09-15', 'CHQ-004411');

    // Cash leaves a cash account, not a bank account.
    const { rows: gl } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       select 'A9CASH1', 'Cash Box', account_type, id, false, true, 'approved', 1, 'IQD' from chart_of_account where code = 'A000001'
       returning id`,
    );
    const box = await withScope(scope(world.manager), (tx) =>
      banks.create(tx, world.manager, 'cash', {
        name: 'Head office cash',
        currency: 'IQD',
        glAccountId: gl[0].id,
        custodianUserId: world.manager.principal.userId,
      }),
    );
    const { rows: boxRow } = await ownerPool.query(`select id from bank_cash_account where code = $1`, [box.code]);
    expect(
      await rejection(draft({ paymentMethodCode: CASH, payeeBankAccountId: null, amountTxn: iqd('600000') })),
    ).toMatch(/paid from a cash account/);
    await fund(gl[0].id, '1000000');
    const cash = await draft({
      paymentMethodCode: CASH,
      payeeBankAccountId: null,
      bankCashAccountId: boxRow[0].id,
      amountTxn: iqd('600000'),
    });
    await approve(cash.id);
    await send(cash.id);
    await confirm(cash.id, '2026-09-16', 'CV-2026-0091');

    const { rows } = await ownerPool.query(
      `select pa.application_no, sp.reference, sp.payment_date::text as paid, sp.status::text as status
         from payment_application pa join supplier_payment sp on sp.id = pa.supplier_payment_id
        where pa.payable_id = $1 order by sp.payment_date`,
      [payableId],
    );
    expect(rows.map((r) => [r.reference, r.paid, r.status])).toEqual([
      ['CHQ-004411', '2026-09-15', 'posted'],
      ['CV-2026-0091', '2026-09-16', 'posted'],
    ]);
    const codes = (await eventsOf()).map((e) => e.event_code);
    expect(codes).toEqual(expect.arrayContaining(['CHEQUE_PAID', 'CASH_PAID', 'FULLY_PAID']));
  });

  it('the officer cannot confirm; a confirmed application cannot be cancelled', async () => {
    await fund(world.accounts.bank!, '5000000');
    const made = await draft();
    await approve(made.id);
    await send(made.id);
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          applications.confirm(tx, world.clerk, made.id, { confirmedOn: '2026-09-14', reference: 'X' }),
        ),
      ),
    ).not.toBe('');
    await confirm(made.id);
    expect(
      await rejection(withScope(scope(world.manager), (tx) => applications.cancel(tx, world.manager, made.id, 'oops'))),
    ).toMatch(/cannot become 'cancelled'/);
  });
});

// ---------------------------------------------------------------------------
// §15.4, D4 — the SWIFT clock
// ---------------------------------------------------------------------------

describe('§15.4 · the sweep watches what was sent', () => {
  it('a SWIFT pending past 14 days opens one hold in the payment lane, once', async () => {
    await fund(world.accounts.bank!, '5000000');
    const made = await draft();
    await approve(made.id);
    await send(made.id); // sent 2026-09-10

    const run = (asOf: string) =>
      withScope({ userId: world.manager.principal.userId, branchCode: BAGHDAD, isSuperUser: true }, (tx) =>
        sweep.runSweep(tx, asOf),
      );
    await run('2026-09-20'); // 10 days — within the limit
    const { rows: none } = await ownerPool.query(
      `select count(*)::int as n from payable_hold where payable_id = $1 and check_code = 'swift_pending'`,
      [payableId],
    );
    expect(none[0].n).toBe(0);

    await run('2026-09-30'); // 20 days
    await run('2026-09-30');
    const { rows } = await ownerPool.query(
      `select lane_code, reason_code, status from payable_hold where payable_id = $1 and check_code = 'swift_pending'`,
      [payableId],
    );
    expect(rows).toEqual([{ lane_code: 'payment', reason_code: 'PENDING_REASON', status: 'open' }]);
  });
});
