/**
 * Telling people what falls due — §15, §16, §21.
 *
 * Three claims, each of which a naive sweep gets wrong:
 *
 *   · one notice per invoice per morning, never two under different headings —
 *     an invoice is due soon, or due today, or overdue, and not two of those;
 *   · running the sweep twice on one day says nothing twice, but tomorrow is a
 *     new day and says it again — job delivery is at-least-once, so a repeat
 *     is the normal case rather than an accident;
 *   · a settled invoice is not chased.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as dueNotices from '@/server/services/due-notices';
import type { Principal } from '@/server/domain/permissions';

const BRANCH = 'HQ';
const TODAY = '2026-06-15';

let sweeper: Principal;
let customerId = '';

async function user(role: string | null, superUser = false): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`,
    [id, `${id}@example.com`, role ?? 'super', superUser],
  );
  if (role) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
  return id;
}

async function invoice(no: string, dueDate: string, net: string, allocated: string, status: string) {
  await ownerPool.query(
    `insert into ar_invoice
       (id, invoice_no, customer_id, branch_code, invoice_date, due_date,
        gross_iqd, discount_iqd, net_iqd, allocated_iqd, status, created_by)
     values (gen_random_uuid(), $1, $2, $3, '2026-01-01'::date, $4::date, $5, 0, $5, $6, $7, $8)`,
    [no, customerId, BRANCH, dueDate, net, allocated, status, sweeper.userId],
  );
}

const sweep = (asOf = TODAY) =>
  withScope({ userId: sweeper.userId, branchCode: BRANCH, isSuperUser: true }, (tx) =>
    dueNotices.raiseDueNotices(tx, sweeper, asOf, { branchCode: BRANCH }),
  );

const noticesFor = async (invoiceNo: string) => {
  const { rows } = await ownerPool.query(
    `select event_type from notification where subject like $1 order by event_type`,
    [`%${invoiceNo}%`],
  );
  return rows.map((row) => row.event_type as string);
};

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');

  // Somebody to receive them: the rules address the Accounting Officer.
  await user('accounting_officer');
  const sweeperId = await user(null, true);
  sweeper = await withScope({ userId: sweeperId, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, sweeperId),
  );

  const { rows } = await ownerPool.query(
    `insert into business_partner (id, code, legal_name, is_customer, active, created_by)
     values (gen_random_uuid(), 'CUS-DN', 'Due Notices Customer', true, true, $1)
     returning id`,
    [sweeper.userId],
  );
  customerId = rows[0].id as string;
});

describe('one notice per invoice per morning', () => {
  it('sorts each invoice into exactly one of due soon, due today and overdue', async () => {
    await invoice('DN-SOON', '2026-06-18', '100', '0', 'posted'); // 3 days off
    await invoice('DN-TODAY', TODAY, '100', '0', 'posted');
    await invoice('DN-LATE', '2026-06-01', '100', '0', 'posted'); // 14 days past
    await invoice('DN-FAR', '2026-09-01', '100', '0', 'posted'); // beyond the horizon

    const run = await sweep();
    expect(run.dueSoon).toBe(1);
    expect(run.dueToday).toBe(1);
    expect(run.overdue).toBe(1);

    expect(await noticesFor('DN-SOON')).toEqual(['ar_invoice.due_soon']);
    expect(await noticesFor('DN-TODAY')).toEqual(['ar_invoice.due_today']);
    expect(await noticesFor('DN-LATE')).toEqual(['ar_invoice.overdue']);
    expect(await noticesFor('DN-FAR'), 'too far off to be news').toEqual([]);
  });

  it('says nothing about an invoice that is already settled', async () => {
    await invoice('DN-PAID', '2026-06-01', '100', '100', 'settled');
    const run = await sweep();
    expect(run.overdue).toBe(0);
    expect(await noticesFor('DN-PAID')).toEqual([]);
  });

  it('still chases what is left of a part-paid invoice', async () => {
    await invoice('DN-PART', '2026-06-01', '100', '40', 'partially_executed');
    const run = await sweep();
    expect(run.overdue).toBe(1);
    expect(await noticesFor('DN-PART')).toEqual(['ar_invoice.overdue']);
  });
});

describe('running it twice', () => {
  it('repeats nothing within the day, and says it again tomorrow', async () => {
    await invoice('DN-LATE', '2026-06-01', '100', '0', 'posted');

    const first = await sweep();
    expect(first.created).toBeGreaterThan(0);
    expect(first.suppressed).toBe(0);

    const again = await sweep();
    expect(again.created, 'the same morning says nothing twice').toBe(0);
    expect(again.suppressed).toBe(first.created);

    // A new day is a new notice: the invoice is a day later than it was.
    const tomorrow = await sweep('2026-06-16');
    expect(tomorrow.created, 'tomorrow is news again').toBe(first.created);
  });
});

describe('who hears about it', () => {
  it('addresses the receivable notices to the role that chases them', async () => {
    await invoice('DN-LATE', '2026-06-01', '100', '0', 'posted');
    await sweep();

    const { rows } = await ownerPool.query(
      `select distinct r.role_code
         from notification n
         join user_role r on r.user_id = n.recipient_user_id
        where n.event_type = 'ar_invoice.overdue'`,
    );
    expect(rows.map((row) => row.role_code)).toEqual(['accounting_officer']);
  });

  it('links the notice to the invoice rather than describing it', async () => {
    await invoice('DN-LATE', '2026-06-01', '100', '0', 'posted');
    await sweep();
    const { rows } = await ownerPool.query(
      `select context from notification where event_type = 'ar_invoice.overdue' limit 1`,
    );
    expect(rows[0].context.link).toBe('/sales/ar-invoices/DN-LATE');
    expect(rows[0].context.days_overdue).toBe(14);
  });
});
