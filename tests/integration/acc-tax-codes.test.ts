/**
 * Tax Codes — REQ-ACC-001 Part D-5, over Phase 03.6's tables (0012) and 0292.
 *
 *   - The code is minted (TAX-001 …), with its treatment, its account and a
 *     first rate from a date; every change is an audit event on the code.
 *   - A rate is added from a date and never changed: a document reads the
 *     rate of its own day (`rateOn`), and the table refuses an edit.
 *   - One account never serves recoverable and non-recoverable tax at once.
 *   - Deactivated with a reason, never deleted; printed from its record;
 *     papers filed on it by whoever reads tax codes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as taxCodes from '@/server/services/tax-codes';
import * as attachments from '@/server/services/attachments';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { runExport } from '@/server/print/export';
import { mayExport } from '@/server/print/access';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
let manager: ActorContext;
let officer: ActorContext;
let vatInId: string;
let costId: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, role]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function account(code: string, parent: string): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     select $1, $1, account_type, id, false, true, 'approved', 1, 'IQD' from chart_of_account where code = $2 returning id`,
    [code, parent],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');
  vatInId = await account('A9VATIN', 'A000001');
  costId = await account('X9TAXCO', 'X000001');
});

describe('Tax Codes', () => {
  it('mints the code, keeps every rate from its date, and never changes one', async () => {
    const made = await withScope(scope(manager), (tx) =>
      taxCodes.create(tx, manager, {
        name: 'Input VAT 15%',
        direction: 'input',
        isRecoverable: true,
        accountId: vatInId,
        ratePercent: '15',
        effectiveFrom: '2026-01-01',
      }),
    );
    expect(made.code).toBe('TAX-001');
    expect(made.direction).toBe('input');

    await withScope(scope(manager), (tx) => taxCodes.addRate(tx, manager, made.code, { ratePercent: '10.5', effectiveFrom: '2026-07-01' }));
    const rate = (on: string) => withScope(scope(officer), (tx) => taxCodes.rateOn(tx, made.code, on));
    expect(await rate('2025-12-31')).toBeNull();
    expect(await rate('2026-06-30')).toBe('15.000000');
    expect(await rate('2026-07-01')).toBe('10.500000');

    // One rate per date; the table itself refuses to change a written rate.
    expect(
      await rejection(withScope(scope(manager), (tx) => taxCodes.addRate(tx, manager, made.code, { ratePercent: '12', effectiveFrom: '2026-07-01' }))),
    ).toMatch(/already has a rate from 2026-07-01/);
    expect(await rejection(ownerPool.query(`update tax_rate set rate_percent = 1 where tax_code = 'TAX-001'`))).toMatch(/append-only/);

    expect(await rejection(withScope(scope(manager), (tx) => taxCodes.addRate(tx, manager, made.code, { ratePercent: '101', effectiveFrom: '2026-08-01' })))).toMatch(
      /at most 100%/,
    );
    // An officer reads; only a manager configures.
    expect(
      await rejection(withScope(scope(officer), (tx) => taxCodes.addRate(tx, officer, made.code, { ratePercent: '5', effectiveFrom: '2026-09-01' }))),
    ).toMatch(/permission|not permitted|denied/i);

    const { rows: events } = await ownerPool.query(
      `select action from audit_event where object_type = 'tax_code' and object_id = $1 order by occurred_at`,
      [made.code],
    );
    // The refusal is on the record too.
    expect(events.map((e) => e.action)).toEqual(['tax_code.created', 'tax_code.rate_added', 'authorisation.denied']);
  });

  it('keeps recoverable and non-recoverable tax on different accounts, and deactivates with a reason', async () => {
    const vat = await withScope(scope(manager), (tx) =>
      taxCodes.create(tx, manager, { name: 'VAT', direction: 'input', isRecoverable: true, accountId: vatInId, ratePercent: '15', effectiveFrom: '2026-01-01' }),
    );
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          taxCodes.create(tx, manager, { name: 'Stamp', direction: 'input', isRecoverable: false, accountId: vatInId, ratePercent: '1', effectiveFrom: '2026-01-01' }),
        ),
      ),
    ).toMatch(/one account cannot hold both/);
    const stamp = await withScope(scope(manager), (tx) =>
      taxCodes.create(tx, manager, { name: 'Stamp', direction: 'output', isRecoverable: false, accountId: costId, ratePercent: '1', effectiveFrom: '2026-01-01' }),
    );
    expect(stamp.code).toBe('TAX-002');

    expect(await rejection(withScope(scope(manager), (tx) => taxCodes.setActive(tx, manager, vat.code, false, ' ')))).toMatch(/reason/);
    await withScope(scope(manager), (tx) => taxCodes.setActive(tx, manager, vat.code, false, 'Replaced by TAX-003'));
    const list = await withScope(scope(officer), (tx) => taxCodes.listAll(tx));
    expect(list.map((row) => [row.code, row.active, row.direction])).toEqual([
      ['TAX-001', false, 'input'],
      ['TAX-002', true, 'output'],
    ]);
    expect(await rejection(ownerPool.query(`delete from tax_code where code = 'TAX-001'`))).toMatch(/deactivated, never deleted/);
  });

  it('prints from its record and files papers on it for whoever reads tax codes', async () => {
    registerAttachmentRuntime();
    const vat = await withScope(scope(manager), (tx) =>
      taxCodes.create(tx, manager, { name: 'VAT', direction: 'input', isRecoverable: true, accountId: vatInId, ratePercent: '15', effectiveFrom: '2026-01-01' }),
    );
    expect(mayExport(officer.principal, 'tax_code', 'pdf')).toBe(true);
    const copy = await withScope(scope(officer), (tx) =>
      runExport(tx, officer, { key: 'tax_code', format: 'pdf', locale: 'ar', at: '2026-03-01T09:00:00.000Z', input: { id: vat.code, query: new URLSearchParams() } }),
    );
    expect(copy.status).toBe(200);
    if (copy.status === 200) expect(copy.model.tables[0]!.rows).toHaveLength(1);

    const filed = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { objectType: 'tax_code', objectId: vat.code, fileName: 'notice.pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n') }),
    );
    expect(filed.quarantined).toBe(false);
  });
});
