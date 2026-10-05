/**
 * The ERP Control Center (platform phase, Agent 9) against real documents.
 *
 * One world is built once — an import taken the whole way (shipped, cleared, received, costed), a customer who
 * bought and returned, a supplier whose order was received and who was paid — and every posting role mapped, a
 * backup set on a temporary disk, the scheduled jobs' state files fresh. Then the tests walk it in order:
 *
 *   CC1  the healthy world: every check a person can run reads ok, with the figures it compared (and the
 *        figures are the books' own, taken by a second route); the ones nobody can run say why
 *   CC2  one fault at a time, put into the world and taken out again: exactly the right check changes state,
 *        with the evidence the fault leaves (exact amounts, the record's number) and a path that opens a page
 *        the viewer is allowed into — and the world is healthy again afterwards
 *   CC3  who may open it and what each check shows them: the grant on the Control Center, the grant on the
 *        screen each check summarises, the branch; nothing leaks as a zero
 *   CC4  one check failing never blanks the page: a locked table times out one check, a spent budget makes the
 *        rest unavailable, never ok
 *   CC5  it writes nothing — a digest of the business tables, the audit trail and the Exception Center's tables
 *        is unchanged by every run of every person, and the transaction itself is held read-only
 *   CC6  faults that stay (a late container, a bank statement nobody matched) — last, because they cannot be undone
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { BAGHDAD, PANEL, SECOND, blWith, importOf, iqd, journal } from './logistics-fixture';
import { ERBIL, as, buildChainWorld, expectOpenable, maintenance, person, type ChainWorld, type Person, type Undo } from './cc01-world';
import { containerNo } from '../support/container-number';
import { CHECKS, checkOf, missingRequirement, type CheckResult, type CheckDefinition } from '@/server/domain/control-center';
import { MONEY_SCALE, parseDecimal } from '@/server/domain/money';
import { PermissionDeniedError, can } from '@/server/domain/permissions';
import { POSTING_MAP } from '@/server/domain/posting-map';
import * as authz from '@/server/services/authorization';
import * as banks from '@/server/services/bank-cash-accounts';
import * as rec from '@/server/services/bank-reconciliation';
import * as statements from '@/server/services/bank-statement';
import * as control from '@/server/services/control-center';
import { READERS } from '@/server/services/control-center-readers';
import * as employees from '@/server/services/employees';
import type { ActorContext } from '@/server/services/chart-of-accounts';

let world: ChainWorld;
let ceo: Person; // the CEO alone
let acct: Person; // the accounting manager alone
let admin: Person; // system administrator
let officer: Person; // accounting officer — raises, does not oversee
let logistics: Person; // logistics officer
let hr: Person; // HR manager
let outsider: Person; // holds a role that grants nothing
let probe: Person; // holds the Control Center and nothing else
let partial: Person; // the Control Center and the trial balance
let auditor: Person; // the Control Center and every screen the checks summarise
let erbilAuditor: Person; // the same, in the Erbil branch
let erbil: Person; // an accounting manager in the Erbil branch
let before: Record<string, string>;
let auditMark = 0n;

const dir = mkdtempSync(join(tmpdir(), 'cc01-'));
const backupRoot = join(dir, 'backups');
const jobStateDir = join(dir, 'jobs');
const crontab = join(dir, 'crontab.erp');
const host = { backupRoot, jobStateDir, crontab, logDir: join(dir, 'logs') };

// ---------------------------------------------------------------------------
// The host the checks read: a backup set, the crontab, the jobs' last runs
// ---------------------------------------------------------------------------

const CRON = [
  '# the jobs of this test host',
  '15 2 * * * $RUN backup 3600 $APP/scripts/ops/backup.sh',
  '*/5 * * * * $RUN deliver-notifications 240 $APP/scripts/ops/deliver-notifications.ts',
  '',
].join('\n');

function writeBackupSet(stamp = '20261004-021500') {
  const path = join(backupRoot, 'nightly', stamp);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `erp-${stamp}.dump.age`), 'x'.repeat(2048));
  writeFileSync(join(path, 'manifest.txt'), `stamp=${stamp}\n`);
  const now = new Date();
  utimesSync(path, now, now);
}

const writeLastRun = (job: string, at: Date, exit = 0) => writeFileSync(join(jobStateDir, `${job}.last`), `${at.toISOString()} ${exit} 12\n`);

function freshJobs() {
  mkdirSync(jobStateDir, { recursive: true });
  writeLastRun('backup', new Date());
  writeLastRun('deliver-notifications', new Date());
}

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

const report = (p: ActorContext, extra: Partial<control.RunInput> = {}) =>
  as(p, (tx) => control.run(tx, { principal: p.principal, branchCode: p.branchCode ?? BAGHDAD, host, ...extra }));

const stateMap = (r: control.ControlReport): Record<string, string> => Object.fromEntries(r.results.map((x) => [x.code, x.state]));
const resultOf = (r: control.ControlReport, code: string): CheckResult => {
  const found = r.results.find((x) => x.code === code);
  expect(found, code).toBeDefined();
  return found!;
};
const changed = (a: Record<string, string>, b: Record<string, string>): string[] => Object.keys(a).filter((code) => a[code] !== b[code]).sort();
const dec = (value: string | null | undefined): bigint => parseDecimal(value ?? '0', MONEY_SCALE);
const figure = (r: CheckResult, key: string) => r.figures.find((f) => f.key === key);

/** Checks that are off in a world nobody set them up in. */
const NOT_SET_UP = new Set(['platform.whatsapp', 'platform.automation', 'platform.cloud']);

/**
 * What a healthy world makes of one check, for a person who may run it. The machine the suite runs on is real:
 * a nearly full disk is a true finding of the system health check, so that is the one item it may carry.
 */
function expectHealthy(definition: CheckDefinition, result: CheckResult) {
  if (NOT_SET_UP.has(definition.code)) {
    expect(result, definition.code).toMatchObject({ state: 'not_checked', reason: { code: 'not_configured' }, items: [], attention: 0 });
    return;
  }
  if (definition.code === 'platform.system_health') {
    const codes = result.items.map((i) => String(i.params.healthCheck));
    expect(codes.filter((c) => c !== 'disk_low'), 'system health').toEqual([]);
    expect(result.state).toBe(codes.length === 0 ? 'ok' : 'attention');
    return;
  }
  expect(result, `${definition.code}: ${JSON.stringify(result.items)}`).toMatchObject({ state: 'ok', reason: null, items: [], attention: 0, hidden: 0 });
}

// ---------------------------------------------------------------------------
// Faults, put in and taken out
// ---------------------------------------------------------------------------

/**
 * Reports before, during and after a fault; the fault comes out whatever the assertions say. `observers` are
 * other people whose report is also taken while the fault is in.
 */
async function withFault(p: ActorContext, fault: () => Promise<Undo>, observers: readonly ActorContext[] = []) {
  const base = await report(p);
  const undo = await fault();
  let during: control.ControlReport;
  const observed: control.ControlReport[] = [];
  try {
    during = await report(p);
    for (const other of observers) observed.push(await report(other));
  } finally {
    await undo();
  }
  const after = await report(p);
  return { base, during, after, observed };
}

/**
 * A journal posted with 750 of debit and 250 of credit — what is left when a script writes a journal's lines
 * without its other side. The application's doors refuse it (a posted journal balances); only damage gets it in.
 */
async function unbalancedJournal(world: ChainWorld, entryNo: string, branch: string = BAGHDAD): Promise<Undo> {
  await maintenance(async (c) => {
    const { rows: period } = await c.query(`select id from fiscal_period where starts_on <= '2026-09-30' and ends_on >= '2026-09-30' limit 1`);
    const { rows: entry } = await c.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by, approved_by, posted_at)
       values ($1,'2026-09-30','2026-09-30',$2,$3,'Left by a maintenance script','posted',750,250,$4,$4,now()) returning id`,
      [entryNo, period[0].id, branch, world.manager.principal.userId],
    );
    await c.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1,1,$2,750,0,750,0,0,0,'IQD',$4), ($1,2,$3,0,250,0,250,0,0,'IQD',$4)`,
      [entry[0].id, world.accounts.expense, world.accounts.sales_revenue, branch],
    );
  });
  return () =>
    maintenance(async (c) => {
      await c.query(`delete from journal_line where journal_entry_id in (select id from journal_entry where entry_no = $1)`, [entryNo]);
      await c.query(`delete from journal_entry where entry_no = $1`, [entryNo]);
    });
}

/** Three panels written off a warehouse that never held any: the ledger below nothing, as a script with the triggers off leaves it. */
async function negativeStock(world: ChainWorld, warehouse: string = SECOND, branch: string = BAGHDAD): Promise<Undo> {
  await maintenance((c) =>
    c.query(
      `insert into inventory_movement (item_code, warehouse_code, branch_code, kind, quantity, movement_date, source_document_type, source_document_id, created_by)
       values ($1, $2, $3, 'write_off', -3, '2026-09-15', 'test', 'CC-NEG-1', $4)`,
      [PANEL, warehouse, branch, world.manager.principal.userId],
    ),
  );
  return () => maintenance(async (c) => void (await c.query(`delete from inventory_movement where source_document_id = 'CC-NEG-1'`)));
}

/** The business tables a read must never touch: row count and a digest of every row. */
const BUSINESS = [
  'ap_invoice',
  'ar_invoice',
  'payable',
  'journal_entry',
  'journal_line',
  'subledger_entry',
  'inventory_movement',
  'cost_layer',
  'shipment_container',
  'bank_reconciliation',
  'bank_statement',
  'posting_rule',
  'customs_pd',
  'business_partner',
  'chart_of_account',
  'exception',
  'exception_history',
  'notification',
  'notification_delivery',
  'job_outbox',
  'role_grant',
  'app_user',
] as const;
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of BUSINESS) {
    const { rows } = await ownerPool.query(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${table} t`);
    result[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return result;
}
const auditCount = async (): Promise<bigint> => BigInt((await ownerPool.query(`select coalesce(max(id), 0)::text as id from audit_event`)).rows[0].id);

/**
 * Files an employee for every user who has none (FIX-5's backfill). Employees are kept by branch and the
 * backfill sees only the branches its operator works in, so for the length of the call the administrator works in
 * both — a user the operator cannot see an employee for would otherwise look like one without.
 */
async function fileEmployees() {
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2) on conflict do nothing`, [admin.id, ERBIL]);
  try {
    return await as(admin, (tx) => employees.ensureForUsers(tx, admin));
  } finally {
    await ownerPool.query(`delete from user_branch_scope where user_id = $1 and branch_code = $2`, [admin.id, ERBIL]);
  }
}

async function roleWith(code: string, grants: readonly string[]) {
  await ownerPool.query(`insert into role (code, name) values ($1,$1) on conflict do nothing`, [code]);
  for (const object of grants) await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,$2,'view') on conflict do nothing`, [code, object]);
}

beforeAll(async () => {
  world = await buildChainWorld();
  writeBackupSet();
  freshJobs();
  writeFileSync(crontab, CRON);

  admin = await person('System Administrator', ['system_administrator']);
  ceo = await person('Chief Executive', ['ceo']);
  acct = await person('Accounting Manager', ['accounting_manager']);
  officer = await person('Accounting Officer', ['accounting_officer']);
  logistics = await person('Logistics Officer', ['logistics_officer']);
  hr = await person('HR Manager', ['hr_manager']);
  erbil = await person('Erbil Accountant', ['accounting_manager'], ERBIL);
  await roleWith('cc_nothing', []);
  outsider = await person('Outsider', ['cc_nothing']);
  await roleWith('cc_probe', ['control_center']);
  await roleWith('cc_partial', ['control_center', 'trial_balance']);
  await roleWith('cc_all', ['control_center', ...new Set(CHECKS.flatMap((c) => c.requires.map((r) => r.object)))]);
  auditor = await person('Auditor', ['cc_all']);
  erbilAuditor = await person('Erbil Auditor', ['cc_all'], ERBIL);
  probe = await person('Probe', ['cc_probe']);
  partial = await person('Partial', ['cc_partial']);

  // Everyone who can sign in is also an employee (FIX-5) — the platform check on that link is part of "healthy".
  expect((await fileEmployees()).skipped).toEqual([]);
  before = await snapshot();
  auditMark = await auditCount();
}, 300_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
describe('CC1 · the healthy world', () => {
  it('has a reader for every check of the catalogue and a check for every reader', () => {
    expect(Object.keys(READERS).sort()).toEqual(CHECKS.map((c) => c.code).sort());
    expect(new Set(CHECKS.map((c) => c.code)).size).toBe(CHECKS.length);
  });

  it('every check the CEO and accounting manager can run reads ok, and the ones they cannot say why', async () => {
    const run = await report(world.manager);
    expect(run.results.map((r) => r.code)).toEqual(CHECKS.map((c) => c.code));
    for (const definition of CHECKS) {
      const result = resultOf(run, definition.code);
      const missing = missingRequirement(definition, (verb, object) => can(world.manager.principal, verb, object));
      if (missing) {
        expect(result, definition.code).toMatchObject({ state: 'not_checked', reason: { code: 'no_access', params: { object: missing.object } }, figures: [], items: [], attention: 0 });
      } else {
        expectHealthy(definition, result);
      }
    }
    // The headline is counts, never a score.
    expect(run.summary.total).toBe(CHECKS.length);
    // The one finding a healthy world may carry is the machine's own nearly full disk.
    expect(run.summary.byState.attention).toBe(resultOf(run, 'platform.system_health').state === 'attention' ? 1 : 0);
    expect(run.summary.byState.unavailable).toBe(0);
    expect(Object.keys(run)).not.toContain('score');
    expect(run.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the system administrator reads the platform ok, with the jobs counted', async () => {
    const run = await report(admin);
    for (const definition of CHECKS) {
      const result = resultOf(run, definition.code);
      const missing = missingRequirement(definition, (verb, object) => can(admin.principal, verb, object));
      if (missing) expect(result.state, definition.code).toBe('not_checked');
      else expectHealthy(definition, result);
    }
    expect(resultOf(run, 'platform.jobs').figures).toEqual([
      { key: 'jobs', count: 2 },
      { key: 'jobs_ok', count: 2 },
    ]);
    expect(resultOf(run, 'platform.users_without_role').state).toBe('ok');
    expect(resultOf(run, 'platform.unknown_grants').state).toBe('ok');
  });

  it('a person granted every screen the checks summarise is asked all of them, and the healthy world answers every one', async () => {
    const run = await report(auditor);
    expect(run.results.filter((r) => r.reason?.code === 'no_access')).toEqual([]);
    for (const definition of CHECKS) expectHealthy(definition, resultOf(run, definition.code));
    expect(run.summary.byState.ok + run.summary.byState.attention + run.summary.byState.not_checked).toBe(CHECKS.length);
    expect(run.summary.byState.not_checked).toBe(NOT_SET_UP.size);
  });

  it('shows the figures it compared, and they are the books’ own', async () => {
    const run = await report(world.manager);

    // The trial balance: both sides, summed here by a second route (the owner's connection, no application code).
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd), 0)::text as d, coalesce(sum(l.credit_iqd), 0)::text as c
         from journal_line l join journal_entry e on e.id = l.journal_entry_id where e.status in ('posted', 'reversed')`,
    );
    const trial = resultOf(run, 'accounting.trial_balance');
    expect(dec(figure(trial, 'debit')!.amountIqd)).toBe(dec(rows[0].d));
    expect(dec(figure(trial, 'credit')!.amountIqd)).toBe(dec(rows[0].c));
    expect(dec(figure(trial, 'debit')!.amountIqd)).toBeGreaterThan(0n);
    expect(dec(figure(trial, 'difference')!.amountIqd)).toBe(0n);

    // Stock: the layers' value, by the owner's own sum of what remains at each layer's cost, equals the accounts.
    const layers = (await ownerPool.query(`select round(coalesce(sum(remaining_quantity * unit_cost_iqd), 0), 4)::text as v from cost_layer`)).rows[0].v as string;
    const stock = resultOf(run, 'inventory.stock_vs_gl');
    expect(dec(figure(stock, 'stock_layers')!.amountIqd)).toBe(dec(layers));
    expect(dec(figure(stock, 'stock_layers')!.amountIqd)).toBe(dec(figure(stock, 'stock_accounts')!.amountIqd));
    expect(dec(figure(stock, 'stock_layers')!.amountIqd)).toBeGreaterThan(0n);

    // Both control accounts agree with their sub-ledger, and neither is a vacuous zero.
    for (const code of ['receivables.control_account', 'payables.control_account']) {
      const control = resultOf(run, code);
      expect(dec(figure(control, 'subledger')!.amountIqd), code).toBe(dec(figure(control, 'control_account')!.amountIqd));
      expect(dec(figure(control, 'subledger')!.amountIqd), code).not.toBe(0n);
      expect(dec(figure(control, 'difference')!.amountIqd), code).toBe(0n);
    }

    // The statement and the ageing: money paid ahead is shown as credits not applied, not as a fault.
    for (const code of ['receivables.statement_ageing', 'payables.statement_ageing']) {
      const result = resultOf(run, code);
      expect(result.state, code).toBe('ok');
      expect(dec(figure(result, 'unapplied_credits')!.amountIqd), code).toBeGreaterThan(0n);
      expect(dec(figure(result, 'debits_without_document')!.amountIqd), code).toBe(0n);
    }
    expect(figure(resultOf(run, 'logistics.transit_issues'), 'imports')!.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('CC2 · one fault at a time', () => {
  it('a posted journal that does not balance: the trial balance and the journal check, by the exact difference', async () => {
    const entryNo = 'JV-CC-DAMAGED';
    const { base, during, after } = await withFault(world.manager, () => unbalancedJournal(world, entryNo));
    expect(changed(stateMap(base), stateMap(during))).toEqual(['accounting.journal_integrity', 'accounting.trial_balance']);

    const trial = resultOf(during, 'accounting.trial_balance');
    expect(trial.state).toBe('attention');
    expect(dec(figure(trial, 'difference')!.amountIqd)).toBe(dec('500'));
    expect(dec(figure(trial, 'debit')!.amountIqd) - dec(figure(trial, 'credit')!.amountIqd)).toBe(dec('500'));
    expect(trial.items).toHaveLength(1);
    expect(trial.items[0]).toMatchObject({ code: 'trial_balance_difference', href: '/finance/trial-balance' });
    expect(dec(String(trial.items[0]!.params.differenceIqd))).toBe(dec('500'));
    expectOpenable(world.manager, trial.items[0]!.href);

    const integrity = resultOf(during, 'accounting.journal_integrity');
    expect(integrity.state).toBe('attention');
    expect(integrity.items).toHaveLength(1);
    expect(integrity.items[0]!.ref).toBe(entryNo);
    expect(integrity.items[0]).toMatchObject({ detector: 'accounting.gl_integrity', href: `/finance/journals/${entryNo}` });
    expect(integrity.attention).toBe(integrity.items.length);
    expectOpenable(world.manager, integrity.items[0]!.href);

    // And taken out again, the world is as healthy as it was.
    expect(stateMap(after)).toEqual(stateMap(base));
  });

  it('a posting role with no account: the exact role, and the foreign-exchange roles apart', async () => {
    const event = 'sales.ar_invoice';
    const role = 'customer_receivable';
    const { base, during, after } = await withFault(world.manager, async () => {
      await ownerPool.query(`update posting_rule set is_active = false where event_type = $1 and line_role = $2`, [event, role]);
      return async () => {
        await ownerPool.query(`update posting_rule set is_active = true where event_type = $1 and line_role = $2`, [event, role]);
      };
    });
    expect(changed(stateMap(base), stateMap(during))).toEqual(['accounting.posting_roles']);
    const result = resultOf(during, 'accounting.posting_roles');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ detector: 'accounting.posting_role_unmapped', href: '/finance/posting-mappings', params: { postingEvent: event, postingRole: role, reason: 'missing' } });
    expect(figure(result, 'found')!.count).toBe(1);
    expectOpenable(world.manager, result.items[0]!.href);
    expect(stateMap(after)).toEqual(stateMap(base));

    // A foreign-exchange role is the other check's, not this one's.
    const fx = POSTING_MAP.flatMap((d) => d.lines.map((l) => ({ event: d.event, role: l.role }))).find((l) => /exchange|revaluation/.test(l.role))!;
    const second = await withFault(world.manager, async () => {
      await ownerPool.query(`update posting_rule set is_active = false where event_type = $1 and line_role = $2`, [fx.event, fx.role]);
      return async () => {
        await ownerPool.query(`update posting_rule set is_active = true where event_type = $1 and line_role = $2`, [fx.event, fx.role]);
      };
    });
    expect(changed(stateMap(second.base), stateMap(second.during))).toEqual(['accounting.fx_mapping']);
    expect(resultOf(second.during, 'accounting.fx_mapping').items[0]).toMatchObject({ params: { postingEvent: fx.event, postingRole: fx.role } });
    expect(stateMap(second.after)).toEqual(stateMap(second.base));
  });

  it('a bank account whose ledger account is gone: named by its code, and not counted twice by system health', async () => {
    let code = '';
    const { base, during, after, observed } = await withFault(
      world.manager,
      async () => {
      const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
      const { rows: gl } = await ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
         values ('A980001','Savings (test)','asset',$1,false,true,'approved',1,'IQD') returning id`,
        [parent[0].id],
      );
      const made = await as(world.manager, (tx) =>
        banks.create(tx, world.manager, 'bank', { name: 'Savings Account', bankName: 'Rafidain Bank', accountNumber: 'RF-9002', currency: 'IQD', glAccountId: gl[0].id }),
      );
      code = made.code;
      await maintenance((c) => c.query(`update chart_of_account set is_active = false where id = $1`, [gl[0].id]));
      return async () => {
        await maintenance(async (c) => {
          await c.query(`delete from bank_cash_account where code = $1`, [code]);
          await c.query(`delete from chart_of_account where id = $1`, [gl[0].id]);
        });
      };
      },
      [admin],
    );
    expect(changed(stateMap(base), stateMap(during))).toEqual(['accounting.bank_accounts']);
    // System health knows the same fault; it leaves it to this check rather than saying it twice.
    expect(resultOf(observed[0]!, 'platform.system_health').items.map((i) => i.params.healthCheck)).not.toContain('bank_account_unlinked');
    const result = resultOf(during, 'accounting.bank_accounts');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ code: 'bank_account_unlinked', ref: code, params: { account: code } });
    expect(figure(result, 'accounts_unlinked')!.count).toBe(1);
    expectOpenable(world.manager, result.items[0]!.href);
    expect(stateMap(after)).toEqual(stateMap(base));
  });

  it('a notification delivery nobody sent for more than a day, and one that failed: counted, with the way to the jobs', async () => {
    let stuckId = '';
    let failedId = '';
    const { base, during, after } = await withFault(admin, async () => {
      const made = async (key: string, age: string) =>
        (
          await ownerPool.query(
            `insert into notification (event_type, object_type, object_id, recipient_user_id, subject, body, dedupe_key, created_at)
             values ('test.event','test','CC-1',$1,'Subject','Body',$2, now() - $3::interval) returning id`,
            [world.manager.principal.userId, key, age],
          )
        ).rows[0].id as string;
      const stuckNotification = await made('cc-stuck', '3 days');
      stuckId = stuckNotification;
      await ownerPool.query(`insert into notification_delivery (notification_id, channel, status) values ($1,'email','pending')`, [stuckNotification]);
      const failedNotification = await made('cc-failed', '1 day');
      failedId = failedNotification;
      await ownerPool.query(
        `insert into notification_delivery (notification_id, channel, status, attempts, last_attempt_at, error_message) values ($1,'email','failed',3, now() - interval '1 day','mailbox full')`,
        [failedNotification],
      );
      return async () => {
        await maintenance(async (c) => {
          await c.query(`delete from notification_delivery where notification_id = any($1::bigint[])`, [[stuckId, failedId]]);
          await c.query(`delete from notification where id = any($1::bigint[])`, [[stuckId, failedId]]);
        });
      };
    });
    expect(changed(stateMap(base), stateMap(during))).toEqual(['platform.deliveries']);
    const result = resultOf(during, 'platform.deliveries');
    expect(figure(result, 'deliveries_stuck')!.count).toBe(1);
    expect(figure(result, 'deliveries_failed')!.count).toBe(1);
    expect(result.items.map((i) => i.code).sort()).toEqual(['deliveries_failed', 'deliveries_stuck']);
    expect(result.items.find((i) => i.code === 'deliveries_failed')!.params).toMatchObject({ channel: 'email', count: 1 });
    expect(result.items.find((i) => i.code === 'deliveries_stuck')!.params).toMatchObject({ count: 1 });
    for (const item of result.items) expectOpenable(admin, item.href);
    expect(stateMap(after)).toEqual(stateMap(base));
  });

  it('a job that failed, one that has not run for days, one that never ran: each named, and system health says nothing twice', async () => {
    const { base, during, after } = await withFault(admin, async () => {
      writeLastRun('backup', new Date(Date.now() - 3 * 24 * 3_600_000)); // a daily job, three days ago
      writeLastRun('deliver-notifications', new Date(), 2); // every five minutes, and it failed
      return async () => freshJobs();
    });
    expect(changed(stateMap(base), stateMap(during))).toEqual(['platform.jobs']);
    const result = resultOf(during, 'platform.jobs');
    expect(result.state).toBe('attention');
    const byJob = Object.fromEntries(result.items.map((i) => [String(i.params.job), i]));
    expect(byJob.backup).toMatchObject({ code: 'job_overdue', params: { job: 'backup', schedule: '15 2 * * *' } });
    expect(Number(byJob.backup!.params.hours)).toBeGreaterThanOrEqual(71);
    expect(byJob['deliver-notifications']).toMatchObject({ code: 'job_failed', params: { exit: 2 } });
    expect(figure(result, 'jobs_ok')!.count).toBe(0);
    for (const item of result.items) expectOpenable(admin, item.href);
    // System health reports a failed job itself; the Control Center does not repeat it there.
    expect(resultOf(during, 'platform.system_health').items.map((i) => i.params.healthCheck)).not.toContain('job_failed');
    expect(stateMap(after)).toEqual(stateMap(base));

    // A job with no state file at all has never run.
    const never = await withFault(admin, async () => {
      rmSync(join(jobStateDir, 'backup.last'));
      return async () => freshJobs();
    });
    expect(changed(stateMap(never.base), stateMap(never.during))).toEqual(['platform.jobs']);
    expect(resultOf(never.during, 'platform.jobs').items).toEqual([expect.objectContaining({ code: 'job_never', params: { job: 'backup' } })]);
    expect(stateMap(never.after)).toEqual(stateMap(never.base));
  });

  it('a missing host: the jobs and the backups say they could not be checked, never ok', async () => {
    const away = await report(admin, { host: { backupRoot: join(dir, 'nowhere'), jobStateDir: join(dir, 'nowhere-jobs'), crontab } });
    const jobs = resultOf(away, 'platform.jobs');
    expect(jobs).toMatchObject({ state: 'unavailable', reason: { code: 'no_host_data' }, items: [], attention: 0 });
    const health = resultOf(away, 'platform.system_health');
    expect(health.state).toBe('attention');
    expect(health.items.map((i) => i.params.healthCheck)).toContain('backup_missing');
    // A stale backup is a finding with the age in it.
    const stale = await withFault(admin, async () => {
      const path = join(backupRoot, 'nightly');
      const old = new Date(Date.now() - 60 * 3_600_000);
      for (const set of readdirSync(path)) utimesSync(join(path, set), old, old);
      return async () => {
        const now = new Date();
        for (const set of readdirSync(path)) utimesSync(join(path, set), now, now);
      };
    });
    expect(resultOf(stale.base, 'platform.system_health').items.map((i) => i.params.healthCheck)).not.toContain('backup_stale');
    expect(resultOf(stale.during, 'platform.system_health').items.map((i) => i.params.healthCheck)).toContain('backup_stale');
    expect(resultOf(stale.during, 'platform.system_health').state).toBe('attention');
    expect(stateMap(stale.after)).toEqual(stateMap(stale.base));
  });

  it('a grant that names nothing the system knows: the object and the roles holding it', async () => {
    const { base, during, after } = await withFault(admin, async () => {
      await ownerPool.query(`insert into role_grant (role_code, object, verb) values ('hr_officer','zz_removed_screen','view')`);
      return async () => {
        await ownerPool.query(`delete from role_grant where object = 'zz_removed_screen'`);
      };
    });
    expect(changed(stateMap(base), stateMap(during))).toEqual(['platform.unknown_grants']);
    const result = resultOf(during, 'platform.unknown_grants');
    expect(result.items).toEqual([expect.objectContaining({ code: 'unknown_grant', ref: 'zz_removed_screen', params: { object: 'zz_removed_screen', roles: 'hr_officer' } })]);
    expectOpenable(admin, result.items[0]!.href);
    expect(stateMap(after)).toEqual(stateMap(base));
  });

  it('a user with no role, and a second Super User: each named, each its own check', async () => {
    let ghost = '';
    const first = await withFault(auditor, async () => {
      const made = await person('Ghost Account', []);
      ghost = made.id;
      return async () => {
        await ownerPool.query(`update app_user set is_active = false where id = $1`, [made.id]);
      };
    });
    expect(changed(stateMap(first.base), stateMap(first.during))).toEqual(['platform.employee_links', 'platform.users_without_role']);
    const bare = resultOf(first.during, 'platform.users_without_role');
    expect(bare.items).toEqual([expect.objectContaining({ code: 'user_without_role', params: expect.objectContaining({ user: 'Ghost Account' }) })]);
    expect(bare.items[0]!.href).toContain(ghost);
    expectOpenable(auditor, bare.items[0]!.href);
    expect(resultOf(first.during, 'platform.employee_links').items).toEqual([expect.objectContaining({ code: 'user_without_employee' })]);
    expect(stateMap(first.after)).toEqual(stateMap(first.base));

    // One Super User is the owner’s break-glass account, listed and not flagged; the second is the finding.
    const supers: string[] = [];
    const one = await withFault(admin, async () => {
      const made = await person('Owner Key', []);
      await ownerPool.query(`update app_user set is_super_user = true where id = $1`, [made.id]);
      await fileEmployees();
      supers.push(made.id);
      return async () => undefined;
    });
    expect(resultOf(one.during, 'platform.super_users')).toMatchObject({ state: 'ok', items: [] });
    expect(figure(resultOf(one.during, 'platform.super_users'), 'super_users')!.count).toBe(1);
    const two = await withFault(admin, async () => {
      const made = await person('Second Key', []);
      await ownerPool.query(`update app_user set is_super_user = true where id = $1`, [made.id]);
      await fileEmployees();
      supers.push(made.id);
      return async () => {
        await ownerPool.query(`update app_user set is_super_user = false, is_active = false where id = any($1::uuid[])`, [supers]);
      };
    });
    const flagged = resultOf(two.during, 'platform.super_users');
    expect(flagged.state).toBe('attention');
    expect(flagged.items.map((i) => i.params.user).sort()).toEqual(['Owner Key', 'Second Key']);
    expect(stateMap(two.after)).toEqual(stateMap(two.base));
  });

  it('a WhatsApp bridge that was set up and then went quiet', async () => {
    const setting = (key: string, value: string) =>
      ownerPool.query(`insert into whatsapp_setting (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value`, [key, value]);
    const { base, during, after } = await withFault(admin, async () => {
      await ownerPool.query(`insert into whatsapp_session (key, value) values ('creds', '{"me":{"id":"9647700000000:1@s.whatsapp.net"}}'::jsonb) on conflict (key) do update set value = excluded.value`);
      await setting('bridge_state', 'connected');
      await setting('bridge_me', '9647700000000');
      await setting('bridge_last_seen', new Date(Date.now() - 20 * 60_000).toISOString());
      return async () => {
        await ownerPool.query(`delete from whatsapp_session where key = 'creds'`);
        await ownerPool.query(`delete from whatsapp_setting where key in ('bridge_state','bridge_me','bridge_last_seen')`);
      };
    });
    expect(resultOf(base, 'platform.whatsapp').state).toBe('not_checked');
    expect(changed(stateMap(base), stateMap(during))).toEqual(['platform.whatsapp']);
    const result = resultOf(during, 'platform.whatsapp');
    expect(result.state).toBe('attention');
    expect(result.items).toEqual([expect.objectContaining({ code: 'whatsapp_silent', href: '/administration/whatsapp' })]);
    expect(figure(result, 'bridge_state')!.text).toBe('connected');
    expectOpenable(admin, result.items[0]!.href);
    expect(stateMap(after)).toEqual(stateMap(base));
  });

  it('automation: a rule the system paused, a rule whose runs failed, and events the runner has not taken', async () => {
    const { base, during, after } = await withFault(admin, async () => {
      const made = { rules: [] as string[], events: [] as string[], runs: [] as string[] };
      await maintenance(async (client) => {
        const rule = async (no: string, paused: boolean) => {
          const { rows } = await client.query<{ id: string }>(
            `insert into automation_rule (rule_no, event_key, template_code, name, owner_user_id, created_by, paused_at, paused_reason, consecutive_failures)
             values ($1, 'ap_invoice.posted', 'invoice_posted_notice', $2, $3, $3, ${paused ? 'now()' : 'null'}, ${paused ? "'Stopped after 3 failures in a row.'" : 'null'}, ${paused ? 3 : 0}) returning id`,
            [no, `Fault ${no}`, admin.id],
          );
          made.rules.push(rows[0]!.id);
          return rows[0]!.id;
        };
        await rule('AUT-FAULT-1', true);
        const failing = await rule('AUT-FAULT-2', false);
        const subject = randomUUID();
        const { rows: event } = await client.query<{ id: string }>(
          `insert into automation_event (event_key, subject_type, subject_id, subject_key, window_key, episode_key, payload, occurred_at, status, next_attempt_at)
           values ('ap_invoice.posted', 'ap_invoice', $1, 'ap_invoice:' || $1, 'fault', 'fault', '{}'::jsonb, now() - interval '3 hours', 'pending', now() - interval '3 hours') returning id`,
          [subject],
        );
        made.events.push(event[0]!.id);
        const { rows: run } = await client.query<{ id: string }>(
          `insert into automation_run (rule_id, rule_version, event_id, event_key, subject_key, window_key, episode_key, run_key, owner_user_id, outcome, reason)
           values ($1, 1, $2, 'ap_invoice.posted', 'ap_invoice:' || $3, 'fault', 'fault', 'fault-run', $4, 'failed', 'A step failed.') returning id`,
          [failing, event[0]!.id, subject, admin.id],
        );
        made.runs.push(run[0]!.id);
      });
      return async () => {
        await maintenance(async (client) => {
          await client.query(`delete from automation_run where id = any($1::bigint[])`, [made.runs]);
          await client.query(`delete from automation_event where id = any($1::bigint[])`, [made.events]);
          await client.query(`delete from automation_rule where id = any($1::uuid[])`, [made.rules]);
        });
      };
    });
    expect(resultOf(base, 'platform.automation').state).toBe('not_checked');
    expect(changed(stateMap(base), stateMap(during))).toEqual(['platform.automation']);
    const result = resultOf(during, 'platform.automation');
    expect(result.state).toBe('attention');
    expect(result.items.map((i) => i.code).sort()).toEqual(['automation_behind', 'automation_failing', 'automation_paused']);
    expect(figure(result, 'automation_rules')!.count).toBe(2);
    expect(figure(result, 'automation_rules_on')!.count).toBe(0);
    expect(figure(result, 'automation_failed_runs')!.count).toBe(1);
    expect(figure(result, 'automation_waiting')!.count).toBeGreaterThanOrEqual(1);
    for (const found of result.items) expectOpenable(admin, found.href);
    expect(stateMap(after)).toEqual(stateMap(base));
  });

  it('stock below nothing, left by a maintenance script: the position, found by the ledger checks', async () => {
    const { base, during, after } = await withFault(world.manager, () => negativeStock(world));
    const flipped = changed(stateMap(base), stateMap(during));
    expect(flipped).toContain('inventory.negative_stock');
    expect(flipped.every((code) => code.startsWith('inventory.'))).toBe(true);
    const negative = resultOf(during, 'inventory.negative_stock');
    expect(negative.items[0]).toMatchObject({ detector: 'inventory.negative_stock' });
    expect(JSON.stringify(negative.items[0]!.params)).toContain(PANEL);
    expectOpenable(world.manager, negative.items[0]!.href);
    expect(stateMap(after)).toEqual(stateMap(base));
  });
});

// ---------------------------------------------------------------------------
describe('CC3 · who may open it, and what each check shows them', () => {
  it('opens for the CEO, the accounting manager, the system administrator — and nobody else', async () => {
    for (const p of [ceo, acct, admin, world.manager]) {
      expect(can(p.principal, 'view', control.PERMISSION_OBJECT), p.principal.userId).toBe(true);
      const run = await report(p);
      expect(run.results).toHaveLength(CHECKS.length);
    }
    for (const p of [world.clerk, officer, logistics, hr, outsider]) {
      expect(can(p.principal, 'view', control.PERMISSION_OBJECT)).toBe(false);
      await expect(report(p)).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('a person with no role at all is refused, and the refusal writes nothing', async () => {
    const nobody = await person('Nobody', []);
    const mark = await auditCount();
    await expect(report(nobody)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await auditCount()).toBe(mark);
    await ownerPool.query(`update app_user set is_active = false where id = $1`, [nobody.id]);
  });

  it('each check is withheld, with its reason and without a figure, from a person who lacks the grant it summarises', async () => {
    for (const p of [ceo, acct, admin, probe, partial]) {
      const run = await report(p);
      for (const definition of CHECKS) {
        const result = resultOf(run, definition.code);
        const missing = missingRequirement(definition, (verb, object) => can(p.principal, verb, object));
        if (missing) {
          expect(result, `${p.name} · ${definition.code}`).toMatchObject({ state: 'not_checked', reason: { code: 'no_access', params: { object: missing.object } }, figures: [], items: [], attention: 0, hidden: 0 });
        } else {
          expect(result.reason?.code ?? null, `${p.name} · ${definition.code}`).not.toBe('no_access');
        }
      }
    }
    // The probe holds the Control Center and nothing it summarises: 32 checks, none run, and no Exception Center counts.
    const nothing = await report(probe);
    expect(nothing.summary.byState).toEqual({ ok: 0, attention: 0, not_checked: CHECKS.length, unavailable: 0 });
    expect(nothing.exceptions).toBeNull();
    // With the trial balance as well, the two checks that summarise it — and only those — run.
    const some = await report(partial);
    expect(some.results.filter((r) => r.reason?.code !== 'no_access').map((r) => r.code).sort()).toEqual(['accounting.journal_integrity', 'accounting.trial_balance']);
    expect(some.summary.byState.not_checked).toBe(CHECKS.length - 2);
  });

  it('the CEO sees what the CEO’s grants allow and the administrator what theirs allow — not each other’s', async () => {
    const asCeo = await report(ceo);
    const asAdmin = await report(admin);
    const runnable = (p: Person) => CHECKS.filter((c) => !missingRequirement(c, (v, o) => can(p.principal, v, o))).map((c) => c.code).sort();
    expect(asCeo.results.filter((r) => r.reason?.code !== 'no_access').map((r) => r.code).sort()).toEqual(runnable(ceo));
    expect(asAdmin.results.filter((r) => r.reason?.code !== 'no_access').map((r) => r.code).sort()).toEqual(runnable(admin));
    // They are different people with different screens: neither runs the other's checks.
    expect(runnable(ceo)).not.toEqual(runnable(admin));
    expect(runnable(ceo).some((code) => !runnable(admin).includes(code))).toBe(true);
    expect(runnable(admin).some((code) => !runnable(ceo).includes(code))).toBe(true);
  });

  it('a branch-scoped manager sees their branch only: the Baghdad books are not their zero, and the scope says so', async () => {
    const run = await report(erbil, { branchCode: ERBIL });
    expect(run.scope).toEqual({ companyWide: false, branches: [ERBIL] });
    const trial = resultOf(run, 'accounting.trial_balance');
    expect(trial.state).toBe('ok');
    expect(dec(figure(trial, 'debit')!.amountIqd)).toBe(0n); // none of Baghdad's fifteen million
    const stock = resultOf(run, 'inventory.stock_vs_gl');
    // Layers are read under the viewer's branches; the Baghdad stock is not in them.
    if (stock.reason?.code !== 'no_access') expect(dec(figure(stock, 'stock_layers')!.amountIqd)).toBe(0n);
    const manager = await report(world.manager);
    expect(manager.scope.companyWide).toBe(false);
    expect(manager.scope.branches).toEqual([BAGHDAD]);
    // A fault in Baghdad does not turn the Erbil manager's screen red.
    const { during } = await withFault(erbil, () => unbalancedJournal(world, 'JV-CC-BGW-ONLY'));
    expect(resultOf(during, 'accounting.trial_balance').state).toBe('ok');
    expect(resultOf(during, 'accounting.journal_integrity').state).toBe('ok');
  });

  it('what is wrong in Baghdad is not told to Erbil, check by check — and what is wrong in Erbil is told to Erbil alone', async () => {
    const BRANCH_DOMAINS = new Set(['accounting', 'inventory', 'receivables', 'payables', 'logistics']);
    const books = (r: control.ControlReport) => r.results.filter((x) => BRANCH_DOMAINS.has(x.domain));

    // A journal that does not balance and stock below nothing, both in Baghdad.
    const baghdad = await withFault(
      erbilAuditor,
      async () => {
        const journalUndo = await unbalancedJournal(world, 'JV-CC-BGW-ONLY');
        const stockUndo = await negativeStock(world);
        return async () => {
          await stockUndo();
          await journalUndo();
        };
      },
      [auditor],
    );
    // The Baghdad auditor sees both faults (so the silence of Erbil's is not an empty world) …
    const seen = baghdad.observed[0]!;
    expect(resultOf(seen, 'accounting.trial_balance').state).toBe('attention');
    expect(resultOf(seen, 'accounting.journal_integrity').state).toBe('attention');
    expect(resultOf(seen, 'inventory.negative_stock').state).toBe('attention');
    // … the Erbil auditor, who can run every check, is told of neither, in a single item, figure or count.
    expect(baghdad.during.results.filter((r) => r.reason?.code === 'no_access')).toEqual([]);
    for (const result of books(baghdad.during)) expectHealthy(checkOf(result.code)!, result);
    expect(books(baghdad.during).map((r) => [r.code, r.state, r.figures])).toEqual(books(baghdad.base).map((r) => [r.code, r.state, r.figures]));
    expect(JSON.stringify(baghdad.during.results)).not.toContain('JV-CC-BGW-ONLY');

    // The same journal in Erbil is Erbil's to be told, and Baghdad's auditor does not hear of it.
    const erbilFault = await withFault(erbilAuditor, () => unbalancedJournal(world, 'JV-CC-ERB-ONLY', ERBIL), [auditor]);
    expect(changed(stateMap(erbilFault.base), stateMap(erbilFault.during))).toEqual(['accounting.journal_integrity', 'accounting.trial_balance']);
    expect(resultOf(erbilFault.during, 'accounting.journal_integrity').items[0]!.ref).toBe('JV-CC-ERB-ONLY');
    expect(JSON.stringify(erbilFault.observed[0]!.results)).not.toContain('JV-CC-ERB-ONLY');
    expect(resultOf(erbilFault.observed[0]!, 'accounting.trial_balance').state).toBe('ok');
  });

  it('a Super User is company-wide and passes every requirement', async () => {
    const root = await person('Root', []);
    await ownerPool.query(`update app_user set is_super_user = true where id = $1`, [root.id]);
    const principal = await as(root, (tx) => authz.loadPrincipal(tx, root.id));
    const superUser = { ...root, principal };
    const run = await report(superUser);
    expect(run.scope.companyWide).toBe(true);
    expect(run.results.filter((r) => r.reason?.code === 'no_access')).toEqual([]);
    await ownerPool.query(`update app_user set is_super_user = false, is_active = false where id = $1`, [root.id]);
  });
});

// ---------------------------------------------------------------------------
describe('CC4 · one failing check never blanks the page', () => {
  it('a locked table times out the checks that read it, says so, and the others answer', async () => {
    const locker = await ownerPool.connect();
    try {
      await locker.query('begin');
      await locker.query('lock table journal_line in access exclusive mode');
      const run = await report(world.manager, { checkTimeoutMs: 300 });
      const trial = resultOf(run, 'accounting.trial_balance');
      expect(trial).toMatchObject({ state: 'unavailable', reason: { code: 'timeout', params: { seconds: 1 } }, figures: [], items: [], attention: 0 });
      expect(run.summary.byState.unavailable).toBeGreaterThanOrEqual(1);
      // The ones that do not read the table are unharmed.
      expect(resultOf(run, 'accounting.bank_accounts').state).toBe('ok');
      expect(resultOf(run, 'platform.outbox').state).toBe('ok');
      expect(resultOf(run, 'logistics.customs').state).toBe('ok');
      // And the page still has its domains and its counts.
      expect(run.results).toHaveLength(CHECKS.length);
      if (can(world.manager.principal, 'view', 'exception')) expect(run.exceptions).not.toBeNull();
    } finally {
      await locker.query('rollback');
      locker.release();
    }
    // The lock gone, the same check reads again.
    expect(resultOf(await report(world.manager), 'accounting.trial_balance').state).toBe('ok');
  });

  it('a run past its budget leaves the checks not reached unavailable, with the reason — never ok', async () => {
    const run = await report(world.manager, { budgetMs: -1 });
    for (const definition of CHECKS) {
      const result = resultOf(run, definition.code);
      const missing = missingRequirement(definition, (verb, object) => can(world.manager.principal, verb, object));
      if (missing) expect(result.state).toBe('not_checked');
      else expect(result, definition.code).toMatchObject({ state: 'unavailable', reason: { code: 'budget' }, figures: [], items: [] });
    }
  });

  it('can be asked for one domain, or for chosen checks', async () => {
    const accounting = await report(world.manager, { domain: 'accounting' });
    expect(accounting.results.every((r) => r.domain === 'accounting')).toBe(true);
    expect(accounting.results.map((r) => r.code)).toEqual(CHECKS.filter((c) => c.domain === 'accounting').map((c) => c.code));
    const some = await report(world.manager, { only: ['inventory.fifo_layers', 'payables.supplier_credits'] });
    expect(some.results.map((r) => r.code)).toEqual(['inventory.fifo_layers', 'payables.supplier_credits']);
    expect(checkOf('inventory.fifo_layers')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('CC5 · it writes nothing', () => {
  it('no run of any person changes a business table, the audit trail or the Exception Center', async () => {
    const mark = await auditCount();
    const snap = await snapshot();
    for (const p of [world.manager, ceo, acct, admin, probe, partial, erbil]) await report(p);
    for (const p of [officer, logistics, hr, outsider]) await rejection(report(p));
    expect(await snapshot()).toEqual(snap);
    expect(await auditCount()).toBe(mark);
    // The world the suite built is also as the suite built it: the faults of CC2 left nothing behind.
    const now = await snapshot();
    for (const table of ['ap_invoice', 'ar_invoice', 'payable', 'subledger_entry', 'inventory_movement', 'cost_layer', 'shipment_container', 'customs_pd', 'bank_reconciliation', 'bank_statement']) {
      expect(now[table], table).toBe(before[table]);
    }
    expect(mark).toBeGreaterThanOrEqual(auditMark);
  });

  it('holds its own transaction read-only: a write attempted after it is refused by the database', async () => {
    await as(world.manager, async (tx) => {
      await control.run(tx, { principal: world.manager.principal, branchCode: BAGHDAD, host });
      const message = await rejection(tx.transaction((savepoint) => savepoint.execute(sql`update app_user set display_name = display_name where id = ${world.manager.principal.userId}`)));
      expect(message).toMatch(/read-only transaction/);
    });
  });

  it('a check cannot be made to write: every reader runs under the same read-only transaction', async () => {
    // The readers are run through `run`, which sets the transaction read-only first; none of them issues a write.
    const source = readFileSync(join(process.cwd(), 'src/server/services/control-center-readers.ts'), 'utf8');
    expect(source).not.toMatch(/\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b|\bdelete from\b/i);
  });
});

// ---------------------------------------------------------------------------
describe('CC6 · faults that stay', () => {
  it('a sub-ledger that is not its control account: the supplier side, by the exact difference, with the line that did it', async () => {
    const entryNo = await journal(world, world.accounts.supplier_payable!, world.accounts.expense!, '250000.0000', '2026-09-10');
    const run = await report(world.manager);
    const result = resultOf(run, 'payables.control_account');
    expect(result.state).toBe('attention');
    const gap = dec(figure(result, 'difference')!.amountIqd);
    expect(gap < 0n ? -gap : gap).toBe(dec('250000'));
    const difference = result.items.find((i) => i.code === 'control_difference')!;
    expect(difference).toBeDefined();
    expect(difference.href).toBe('/payables/reconciliation');
    expectOpenable(world.manager, difference.href);
    const line = result.items.find((i) => i.detector === 'payables.ledger_inconsistency');
    expect(line, 'the journal line that names nobody').toBeDefined();
    expect(JSON.stringify(line)).toContain(entryNo);
    // The customers are untouched, and so is the trial balance — the journal itself balanced.
    expect(resultOf(run, 'receivables.control_account').state).toBe('ok');
    expect(resultOf(run, 'accounting.trial_balance').state).toBe('ok');
  });

  it('a container past its ETA that nobody received: the shipment delays check, with the container and its days', async () => {
    const base = await report(world.manager);
    const late = await importOf(world, '10', { reference: 'CC-LATE' });
    const box = containerNo('MSCU', 760099);
    await blWith(world, late.payableId, [{ no: box, qty: '10' }], { eta: '2026-08-25' });
    const during = await report(world.manager);
    expect(changed(stateMap(base), stateMap(during))).toEqual(['logistics.shipment_delays']);
    const result = resultOf(during, 'logistics.shipment_delays');
    expect(result.state).toBe('attention');
    const item = result.items.find((i) => i.detector === 'logistics.container_delayed')!;
    expect(item).toBeDefined();
    expect(item.ref).toBe(box);
    expect(item.params).toMatchObject({ container: box, etaDate: '2026-08-25' });
    expect(Number(item.params.days)).toBeGreaterThan(30);
    expectOpenable(world.manager, item.href);
  });

  it('a bank statement nobody has matched: the reconciliation, with its difference', async () => {
    const base = await report(world.manager);
    await journal(world, world.accounts.bank!, world.accounts.sales_revenue!, '1000.0000', '2026-08-20');
    const statement = await as(world.manager, (tx) =>
      statements.importStatement(tx, world.manager, {
        bankCashAccountId: world.bankAccountId,
        branchCode: BAGHDAD,
        periodFrom: '2026-08-01',
        periodTo: '2026-08-31',
        openingBalanceIqd: iqd('0'),
        closingBalanceIqd: iqd('5001000'),
        lines: [
          { lineNo: 1, bookingDate: '2026-08-05', valueDate: '2026-08-05', amountIqd: iqd('5000000'), reference: 'FUNDING', counterparty: null, description: 'Funding' },
          { lineNo: 2, bookingDate: '2026-08-20', valueDate: '2026-08-20', amountIqd: iqd('1000'), reference: 'DEP-1', counterparty: null, description: 'Deposit' },
        ],
      }),
    );
    const opened = await as(world.manager, (tx) => rec.open(tx, world.manager, statement.id));
    const during = await report(world.manager);
    expect(changed(stateMap(base), stateMap(during))).toContain('accounting.bank_reconciliation');
    const result = resultOf(during, 'accounting.bank_reconciliation');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ detector: 'accounting.bank_reconciliation_difference', ref: opened.reconciliationNo });
    expect(dec(String(result.items[0]!.params.differenceIqd))).toBe(dec('5001000'));
    expectOpenable(world.manager, result.items[0]!.href);
    // A journal that moved the bank cannot have unbalanced the books.
    expect(resultOf(during, 'accounting.trial_balance').state).toBe('ok');
  });
});
