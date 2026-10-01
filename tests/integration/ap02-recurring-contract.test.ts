/**
 * REQ-AP-001 A8 — the rent is in the system, as purchase invoices (D12).
 *
 * A monthly contract generates one **purchase invoice** per period,
 * `generate_days_ahead` early, idempotently — the partial unique on
 * (recurring_contract_id, period_start) is the guarantee, and running the
 * generator twice proves it. Auto-confirm (D8) submits the period's invoice
 * for posting at once; a period past its due date reads Overdue on the
 * register; an amendment changes future periods only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as contracts from '@/server/services/recurring-contracts';
import * as expenses from '@/server/services/expenses';
import {
  BRANCH,
  buildPayablesWorld,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;

const superScope = () => ({
  userId: world.manager.principal.userId,
  branchCode: BRANCH,
  isSuperUser: true,
});

const LEASE = (world: PayablesWorld) =>
  ({
    supplierId: world.supplierId,
    departmentCode: 'FIN',
    branchCode: BRANCH,
    expenseCategoryCode: 'rent',
    description: 'Erbil office lease, 3rd floor',
    currency: 'USD',
    amountPerPeriodTxn: '2500.0000',
    frequency: 'monthly',
    startDate: '2026-09-01',
    dueRule: 'day_of_period:1',
    generateDaysAhead: 30,
    autoConfirm: true,
    invoiceExpected: false,
  }) as const;

async function activeLease() {
  const created = await withScope(scope(world.officer), (tx) =>
    contracts.create(tx, world.officer, LEASE(world)),
  );
  await withScope(scope(world.manager), (tx) =>
    contracts.approve(tx, world.manager, created.id),
  );
  return created;
}

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
});

describe('ap02 · a monthly contract raises its own purchase invoices', () => {
  it('generates one purchase invoice per period, thirty days ahead, idempotently', async () => {
    const lease = await activeLease();

    // §10.2 — a period is created generate_days_ahead before it starts.
    // 1 October sees September (already running) and October; November's
    // generation day is 2 October, thirty days before 1 November.
    const first = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2026-10-01', null),
    );
    expect(first.periodsCreated).toBe(2);

    const second = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2026-10-02', null),
    );
    expect(second.periodsCreated).toBe(1);

    const again = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2026-10-02', null),
    );
    expect(again.periodsCreated).toBe(0);

    const { rows } = await ownerPool.query(
      `select period_start::text as start, due_date::text as due, status::text as status, note,
              expense_category_code as category, payable_id
         from ap_invoice where recurring_contract_id = $1 order by period_start`,
      [lease.id],
    );
    expect(rows.map((row) => row.start)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(rows[0].due).toBe('2026-09-01');
    expect(rows[0].note).toMatch(/lease.*2026-09/);
    expect(new Set(rows.map((row) => row.category))).toEqual(new Set(['rent']));
    // D12 — an expense is an invoice, not a payable record.
    expect(rows.every((row) => row.payable_id === null)).toBe(true);
    // D8 — the lease is its own evidence: every period is submitted for posting.
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['submitted']));

    // No payable was raised for the rent.
    const { rows: payables } = await ownerPool.query(
      `select count(*)::int as n from payable where recurring_contract_id = $1`,
      [lease.id],
    );
    expect(payables[0].n).toBe(0);
  });

  it('maker-checker: whoever raised the contract cannot activate it', async () => {
    // The manager holds the approve permission — the refusal is §5.2, not authz.
    const created = await withScope(scope(world.manager), (tx) =>
      contracts.create(tx, world.manager, LEASE(world)),
    );
    const refusal = await rejection(
      withScope(scope(world.manager), (tx) => contracts.approve(tx, world.manager, created.id)),
    );
    expect(refusal).toMatch(/cannot approve/);
  });

  it('an unpaid period past its due date reads Overdue on the register (D12)', async () => {
    await activeLease();
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-10-01', null));

    const { rows } = await ownerPool.query(`
      select i.period_start::text as start, i.status::text as status, i.due_date::text as due_date,
             i.total_iqd::text as total, i.settled_amount_iqd::text as settled
        from ap_invoice i where i.recurring_contract_id is not null order by i.period_start`);
    // September (due 1 Sep) and October (due 1 Oct) are both past due on the
    // 2nd; nothing about the rent needs a stage rail or a reason code.
    const states = rows.map((row) =>
      expenses.paymentState(
        { status: row.status, dueDate: row.due_date, totalIqd: row.total, settledAmountIqd: row.settled },
        '2026-10-02',
      ),
    );
    expect(states).toEqual(['overdue', 'overdue']);

    // The overdue rent carries a note, dated and signed, and the note cannot
    // be rewritten (R3).
    const { rows: first } = await ownerPool.query(
      `select id from ap_invoice where recurring_contract_id is not null order by period_start limit 1`,
    );
    await withScope(scope(world.officer), (tx) =>
      expenses.addNote(tx, world.officer, first[0].id, 'Landlord travelling, pays Monday'),
    );
    const update = await ownerPool
      .query(`update ap_invoice_note set note = 'rewritten'`)
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(update).toMatch(/append-only|not allowed|immutable/i);
  });

  it('an amendment is a dated row that reaches future periods only', async () => {
    const lease = await activeLease();
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-10-01', null));

    // The landlord raises the rent from December.
    await withScope(scope(world.manager), (tx) =>
      contracts.amend(tx, world.manager, {
        contractId: lease.id,
        effectiveFrom: '2026-12-01',
        amountPerPeriodTxn: '2750.0000',
        note: 'Annual escalation per clause 4.2',
      }),
    );

    // Generated periods stand at the old rent…
    const amounts = async () =>
      (
        await ownerPool.query(
          `select i.period_start::text as start, l.unit_price::numeric as amount
             from ap_invoice i join ap_invoice_line l on l.ap_invoice_id = i.id
            where i.recurring_contract_id = $1 order by i.period_start`,
          [lease.id],
        )
      ).rows.map((row) => ({ start: row.start as string, amount: Number(row.amount) }));

    const before = await amounts();
    expect(new Set(before.map((row) => row.amount)).size).toBe(1);

    // …and December arrives at the new one: 2750 / 2500 of the old IQD figure.
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-11-15', null));
    const after = await amounts();
    const december = after.at(-1)!;
    expect(december.start).toBe('2026-12-01');
    expect(december.amount / after[0]!.amount).toBeCloseTo(2750 / 2500, 6);

    // The amendment row itself cannot be rewritten (R3).
    const update = await ownerPool
      .query(`update recurring_contract_amendment set note = 'rewritten'`)
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(update).toMatch(/append-only/);
  });

  it('ending the contract stops generation; generated periods stand (§10.3)', async () => {
    const lease = await activeLease();
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-10-01', null));

    await withScope(scope(world.manager), (tx) =>
      contracts.end(tx, world.manager, {
        contractId: lease.id,
        endDate: '2026-11-30',
        reason: 'Moving to the new building',
      }),
    );

    const more = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2027-03-01', null),
    );
    expect(more.periodsCreated).toBe(0);

    // September and October were generated before the end; November never
    // was, and §10.3 keeps what exists and raises nothing new.
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from ap_invoice where recurring_contract_id = $1`,
      [lease.id],
    );
    expect(rows[0].n).toBe(2);
  });
});
