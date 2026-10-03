/**
 * REQ-IMPROVE-001 IMPROVE-2a — IM10 `im10-period-close` and IM12
 * `im12-subledger-equals-gl`.
 *
 * A close is refused while a blocking check fails, out of sequence, and —
 * once closed — the database itself refuses a journal posting and a stock
 * movement dated inside it. After the trading fixture's posted purchase
 * invoice, every control account equals its sub-ledger and the checklist
 * says so; a bogus sub-ledger row makes it say otherwise.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fundAccount } from './hr-funds';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as closing from '@/server/services/closing-checks';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let periodIds: Record<string, string>;

const period = (name: string) => periodIds[name]!;
const close = (name: string, reason = 'month end') =>
  withScope(scope(world.manager), (tx) => periods.setPeriodStatus(tx, world.manager, period(name), 'closed', reason));
const statusOf = async (name: string) => (await ownerPool.query(`select status from fiscal_period where id = $1`, [period(name)])).rows[0].status as string;

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(`insert into role_grant (role_code, object, verb) values ('accounting_manager','fiscal_period','configure') on conflict do nothing`);
  const { loadPrincipal } = await import('@/server/services/authorization');
  world = { ...world, manager: { principal: await withScope(scope(world.manager), (tx) => loadPrincipal(tx, world.manager.principal.userId)), branchCode: BAGHDAD } };
  const { rows } = await ownerPool.query(`select p.id, p.period_no from fiscal_period p join fiscal_year y on y.id = p.fiscal_year_id where y.code = 'FY2026' order by p.period_no`);
  periodIds = Object.fromEntries(rows.map((r) => [`2026-${String(r.period_no).padStart(2, '0')}`, r.id]));

  // Ten panels at 100,000 into WH-MAIN on 1 April; a million owed to Jinko.
  const invoice = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'SI-CLOSE',
      purchaseOrderId: null,
      branchCode: BAGHDAD,
      invoiceDate: '2026-04-01',
      dueDate: '2026-05-01',
      nonPoJustification: 'Bought directly from the supplier.',
      nonPoApprovedBy: world.manager.principal.userId,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: parseQuantity('10'), unitPriceIqd: parseDecimal('100000', 4n), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
    }),
  );
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoice.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoice.id));
});

describe('IM10 · im10-period-close — the close is refused while a check fails, and in sequence', () => {
  it('February cannot close before January — by the service and by the database', async () => {
    expect(await rejection(close('2026-02'))).toMatch(/cannot be closed while these checks fail: sequence/);
    expect(await statusOf('2026-02')).toBe('open');
    // Straight at the table, the trigger holds the same rule.
    expect(await rejection(ownerPool.query(`update fiscal_period set status = 'closed' where id = $1`, [period('2026-02')]))).toMatch(/close in sequence/);
  });

  it('January closes clean; then nothing posts into it, not even by hand', async () => {
    const before = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-01')));
    expect(before.mayClose).toBe(true);
    expect(before.checks.find((c) => c.code === 'sequence')).toMatchObject({ state: 'pass', figure: '0' });
    expect(before.checks.find((c) => c.code === 'subledger_equals_gl')).toMatchObject({ state: 'pass', figure: '0' });

    await close('2026-01');
    expect(await statusOf('2026-01')).toBe('closed');
    const { rows: trail } = await ownerPool.query(`select after_value from audit_event where action = 'fiscal_period.closed' order by id desc limit 1`);
    expect(trail[0].after_value.status).toBe('closed');
    // The warnings a close was taken over are on the record beside the reason.
    expect(trail[0].after_value.warnings).toEqual(expect.arrayContaining(['bank_reconciled']));

    // The application refuses a journal dated inside it at submission…
    const draft = await withScope(scope(world.manager), (tx) =>
      journal.createDraft(tx, world.manager, { branchCode: BAGHDAD, documentDate: '2026-01-15', postingDate: '2026-01-15', description: 'Late January' }),
    );
    await withScope(scope(world.manager), (tx) => journal.addLine(tx, world.manager, draft.id, { accountId: world.accounts.expense!, debit: '1000.0000', dimensions: { department: 'FIN' } }));
    await withScope(scope(world.manager), (tx) => journal.addLine(tx, world.manager, draft.id, { accountId: world.accounts.bank!, credit: '1000.0000' }));
    expect(await rejection(withScope(scope(world.manager), (tx) => journal.submit(tx, world.manager, draft.id)))).toMatch(/closed/i);

    // …and the database refuses a posted entry written straight into it (FC-3).
    expect(
      await rejection(
        ownerPool.query(
          `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, journal_type, source, status, total_debit_iqd, total_credit_iqd, created_by)
           values ('JE-2026-999999', '2026-01-20', '2026-01-20', $1, $2, 'by hand', 'standard', 'manual', 'posted', 0, 0, $3)`,
          [period('2026-01'), BAGHDAD, world.manager.principal.userId],
        ),
      ),
    ).toMatch(/the period is closed/);

    // …and a stock movement dated inside it (FC-3).
    expect(
      await rejection(
        ownerPool.query(
          `insert into inventory_movement (item_code, warehouse_code, branch_code, kind, quantity, movement_date, source_document_type, source_document_id, created_by)
           values ($1, $2, $3, 'goods_receipt', 1, '2026-01-20', 'test', 'by-hand', $4)`,
          [PANEL, WAREHOUSE, BAGHDAD, world.manager.principal.userId],
        ),
      ),
    ).toMatch(/the period is closed/);

    // The open month still takes a posting.
    const april = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-04')));
    expect(april.checks.find((c) => c.code === 'sequence')).toMatchObject({ state: 'fail', figure: '2' });
  });

  it('a journal dated in the month that has not posted blocks the close, and clears it when posted', async () => {
    await fundAccount(world, world.accounts.bank!, '5000.0000'); // C-20: the bank pays what it holds
    await close('2026-01');
    const draft = await withScope(scope(world.manager), (tx) =>
      journal.createDraft(tx, world.manager, { branchCode: BAGHDAD, documentDate: '2026-02-10', postingDate: '2026-02-10', description: 'February accrual' }),
    );
    await withScope(scope(world.manager), (tx) => journal.addLine(tx, world.manager, draft.id, { accountId: world.accounts.expense!, debit: '5000.0000', dimensions: { department: 'FIN' } }));
    await withScope(scope(world.manager), (tx) => journal.addLine(tx, world.manager, draft.id, { accountId: world.accounts.bank!, credit: '5000.0000' }));

    const report = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-02')));
    expect(report.mayClose).toBe(false);
    expect(report.blockingFailures).toEqual(['unposted_journals']);
    expect(report.checks.find((c) => c.code === 'unposted_journals')?.detail).toEqual([`${draft.entryNo} (draft)`]);
    expect(await rejection(close('2026-02'))).toMatch(/unposted_journals/);

    await withScope(scope(world.manager), (tx) => journal.submit(tx, world.manager, draft.id));
    const { rows: submitted } = await ownerPool.query(`select status from journal_entry where id = $1`, [draft.id]);
    if (submitted[0].status !== 'posted') await withScope(scope(world.manager), (tx) => journal.approve(tx, world.manager, draft.id));
    const after = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-02')));
    expect(after.blockingFailures).toEqual([]);
    await close('2026-02');
    expect(await statusOf('2026-02')).toBe('closed');
  });

  it('a soft close needs no checklist; reopening a hard close is still refused', async () => {
    await withScope(scope(world.manager), (tx) => periods.setPeriodStatus(tx, world.manager, period('2026-04'), 'soft_closed', 'month-end review'));
    expect(await statusOf('2026-04')).toBe('soft_closed');
    await close('2026-01');
    expect(await rejection(withScope(scope(world.manager), (tx) => periods.setPeriodStatus(tx, world.manager, period('2026-01'), 'open', 'oops')))).toMatch(/year-end action/);
  });
});

describe('IM12 · im12-subledger-equals-gl — after the fixture every control account equals its sub-ledger', () => {
  it('the checklist passes the reconciliation, names the figures, and catches a sub-ledger row the ledger never saw', async () => {
    const april = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-04')));
    const recon = april.checks.find((c) => c.code === 'subledger_equals_gl')!;
    expect(recon).toMatchObject({ state: 'pass', figure: '0' });
    const stock = april.checks.find((c) => c.code === 'stock_ledger_integrity')!;
    expect(stock).toMatchObject({ state: 'pass', figure: '0' });
    // Inventory value: ten panels at 100,000 on the layers, and in the inventory account.
    const value = april.checks.find((c) => c.code === 'inventory_value_equals_gl')!;
    expect(value.state).toBe('pass');
    expect(value.detail[0]).toMatch(/^layers 1000000\.0000(0*)? · accounts 1000000\.0000/);
    expect(april.checks.map((c) => c.code)).toEqual([...closing.CHECK_CODES]);
    // REQ-PM-001 §11 — before Finance ratifies recognition the warning says so rather than naming every project.
    expect(april.checks.find((c) => c.code === 'project_recognition')).toMatchObject({ state: 'pass', figure: 'not ratified' });

    // A sub-ledger row nothing posted: the reconciliation shows the exact difference and blocks the close.
    const { rows: control } = await ownerPool.query(`select id from chart_of_account where control_account = 'supplier' limit 1`);
    await ownerPool.query(
      `insert into subledger_entry (subledger_type, party_code, control_account_id, journal_entry_id, journal_line_id, posting_date, branch_code, currency,
                                    debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, source_module, source_doc_id)
       select 'supplier', 'SUP-JINKO', $1, e.id, l.id, '2026-04-02', e.branch_code, 'IQD', 0, 250, 0, 250, 0, 0, 'test', 'bogus'
         from journal_entry e join journal_line l on l.journal_entry_id = e.id where e.status = 'posted' limit 1`,
      [control[0].id],
    );
    await ownerPool.query(`update fiscal_period set status = 'closed' where id in ($1, $2, $3)`, [period('2026-01'), period('2026-02'), period('2026-03')]);
    const broken = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-04')));
    expect(broken.blockingFailures).toEqual(['subledger_equals_gl']);
    expect(broken.checks.find((c) => c.code === 'subledger_equals_gl')?.detail[0]).toMatch(/-250\.0000$/);
    expect(await rejection(close('2026-04'))).toMatch(/subledger_equals_gl/);
  });
});

describe('FC-4 · the nightly job tells the accounting managers what blocks the close, once', () => {
  it('names the next period to close and notifies each manager once per day per set of failures', async () => {
    const next = await withScope(scope(world.manager), (tx) => closing.nextToClose(tx, '2026-10-02'));
    expect(next?.name).toBe('January 2026');
    await close('2026-01');
    const february = await withScope(scope(world.manager), (tx) => closing.nextToClose(tx, '2026-10-02'));
    expect(february?.name).toBe('February 2026');

    // Nothing blocks February: nobody is told.
    const clean = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-02')));
    expect(await withScope(scope(world.manager), (tx) => closing.notifyFailures(tx, clean, '2026-10-02'))).toEqual({ notified: 0 });

    // March is out of sequence: one notice per manager, and not a second one the same night.
    const blocked = await withScope(scope(world.manager), (tx) => periods.closeReport(tx, period('2026-03')));
    expect(blocked.blockingFailures).toEqual(['sequence']);
    const first = await withScope(scope(world.manager), (tx) => closing.notifyFailures(tx, blocked, '2026-10-02'));
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const again = await withScope(scope(world.manager), (tx) => closing.notifyFailures(tx, blocked, '2026-10-02'));
    expect(again).toEqual({ notified: 0 });
    const { rows } = await ownerPool.query(`select subject, body from notification where event_type = 'fiscal_period.close_blocked' limit 1`);
    expect(rows[0].subject).toBe('March 2026 cannot close yet: 1 check(s) fail');
    expect(rows[0].body).toContain('sequence: 1 — February 2026');
  });
});
