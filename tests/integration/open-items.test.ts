/**
 * Open items — §15 and §16, both sides.
 *
 * The rules worth holding are the ones a report gets quietly wrong:
 *
 *   · an invoice is aged from its **due** date, not its invoice date, so terms
 *     are honoured and nobody chases a customer who is not late;
 *   · the day it falls due is not yet late;
 *   · a partial payment leaves a history, not just a smaller number;
 *   · a settled invoice keeps saying how late it was paid, which is the whole
 *     of "days late after payment";
 *   · "paid" is the invoice's own figure, not a second sum of the receipts.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as openItems from '@/server/services/open-items';
import type { Principal } from '@/server/domain/permissions';

const BRANCH = 'HQ';
let manager: Principal;
let customerId = '';

const scope = () => ({ userId: manager.userId, branchCode: BRANCH });

/** An A/R invoice written straight in, so the suite tests the report not the raiser. */
async function invoice(
  no: string,
  invoiceDate: string,
  dueDate: string,
  net: string,
  allocated: string,
  status: string,
): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into ar_invoice
       (id, invoice_no, customer_id, branch_code, invoice_date, due_date,
        gross_iqd, discount_iqd, net_iqd, allocated_iqd, status, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4::date, $5::date, $6, 0, $6, $7, $8, $9)
     returning id`,
    [no, customerId, BRANCH, invoiceDate, dueDate, net, allocated, status, manager.userId],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');

  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name) values ($1,$2,'Open items')`,
    [id, `${id}@example.com`],
  );
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
  manager = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));

  const { rows } = await ownerPool.query(
    `insert into business_partner (id, code, legal_name, is_customer, active, created_by)
     values (gen_random_uuid(), 'CUS-OI', 'Open Items Customer', true, true, $1)
     returning id`,
    [manager.userId],
  );
  customerId = rows[0].id as string;
});

const read = (asOf: string, filter = {}) =>
  withScope(scope(), (tx) => openItems.openItems(tx, manager, 'customer', asOf, { branchCode: BRANCH, ...filter }));

describe('an invoice is aged from the date it falls due', () => {
  it('is not late on the day it is due, and is late the day after', async () => {
    await invoice('OI-DUE', '2026-03-01', '2026-03-31', '1000', '0', 'posted');

    const onTheDay = (await read('2026-03-31')).find((row) => row.invoiceNo === 'OI-DUE')!;
    expect(onTheDay.daysOverdue, 'due today is not overdue').toBe(0);
    expect(onTheDay.daysUntilDue).toBe(0);
    expect(onTheDay.bucket).toBe('current');

    const nextDay = (await read('2026-04-01')).find((row) => row.invoiceNo === 'OI-DUE')!;
    expect(nextDay.daysOverdue).toBe(1);
    expect(nextDay.bucket).toBe('1-30');
  });

  it('honours the terms: 30-day terms are not overdue on day 20', async () => {
    // Raised on the 1st, due on the 31st. On the 20th the customer has done
    // nothing wrong, and a report that said otherwise would have somebody
    // telephoning them.
    const onDay20 = (await read('2026-03-20')).find((row) => row.invoiceNo === 'OI-DUE')!;
    expect(onDay20.daysOverdue).toBe(0);
    expect(onDay20.daysUntilDue).toBe(11);
    expect(onDay20.bucket).toBe('current');
  });

  it('walks the buckets as the days pass', async () => {
    const bucketOn = async (asOf: string) =>
      (await read(asOf)).find((row) => row.invoiceNo === 'OI-DUE')!.bucket;
    expect(await bucketOn('2026-04-30')).toBe('1-30');
    expect(await bucketOn('2026-05-30')).toBe('31-60');
    expect(await bucketOn('2026-06-29')).toBe('61-90');
    expect(await bucketOn('2026-07-30')).toBe('90+');
  });
});

describe('what has been paid, and what that leaves', () => {
  it('reports the invoice’s own paid figure rather than re-adding the receipts', async () => {
    await invoice('OI-PART', '2026-03-01', '2026-03-31', '1000', '400', 'partially_executed');
    const item = (await read('2026-04-10')).find((row) => row.invoiceNo === 'OI-PART')!;
    expect(Number(item.totalIqd)).toBe(1000);
    expect(Number(item.paidIqd)).toBe(400);
    expect(Number(item.outstandingIqd)).toBe(600);
    expect(item.daysOverdue).toBe(10);
  });

  it('keeps a settled invoice on the list, so "how late was it paid" is answerable', async () => {
    await invoice('OI-SETTLED', '2026-03-01', '2026-03-31', '1000', '1000', 'settled');

    const open = await read('2026-05-01', { outstandingOnly: true });
    expect(open.map((row) => row.invoiceNo), 'settled is not outstanding').not.toContain('OI-SETTLED');

    const all = await read('2026-05-01');
    const settled = all.find((row) => row.invoiceNo === 'OI-SETTLED')!;
    expect(settled, 'but it is still on the record').toBeDefined();
    expect(Number(settled.outstandingIqd)).toBe(0);
  });

  it('counts only what is still owed into the ageing', async () => {
    const all = await read('2026-05-01');
    const buckets = openItems.ageing(all);
    const total = buckets.reduce((sum, bucket) => sum + Number(bucket.amountIqd), 0);
    const owed = all.reduce((sum, row) => sum + Math.max(0, Number(row.outstandingIqd)), 0);
    expect(total, 'the ageing adds up to what is outstanding').toBe(owed);
    // The settled invoice contributes nothing, though it is in the list.
    expect(total).toBe(1600);
  });
});

describe('overdue only, and the party view', () => {
  it('drops everything that is not yet late', async () => {
    await invoice('OI-FUTURE', '2026-04-01', '2026-12-31', '500', '0', 'posted');
    const late = await read('2026-05-01', { overdueOnly: true });
    expect(late.map((row) => row.invoiceNo)).not.toContain('OI-FUTURE');
    expect(late.every((row) => row.daysOverdue > 0)).toBe(true);
  });

  it('sums a party’s position and says how much of it is late', async () => {
    const parties = openItems.byParty(await read('2026-05-01'));
    const party = parties.find((row) => row.partyCode === 'CUS-OI')!;
    expect(Number(party.outstandingIqd)).toBe(2100); // 1000 + 600 + 500
    expect(Number(party.overdueIqd), 'the future invoice is not late').toBe(1600);
  });

  it('refuses a reader who may not see the invoices', async () => {
    const id = randomUUID();
    await ownerPool.query(
      `insert into app_user (id, email, display_name) values ($1,$2,'No grants')`,
      [id, `${id}@example.com`],
    );
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
    const nobody = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));
    await expect(
      withScope({ userId: id, branchCode: BRANCH }, (tx) =>
        openItems.openItems(tx, nobody, 'customer', '2026-05-01'),
      ),
    ).rejects.toThrow();
  });
});
