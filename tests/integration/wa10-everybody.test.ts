/**
 * Noah for everybody — 2026-10-04, by direction: "make it available for all
 * users … explain everything … help them doing actions … if they have issues,
 * save the issues in an md file".
 *
 *   * Anybody with a contact may ask, and is answered as themselves: a tool
 *     that reads a table directly refuses a role that does not hold its
 *     screen's grant, and the free query is for the roles that read everything.
 *   * The menu and the written guide answer for the system itself.
 *   * An issue is written to the list from inside the question's read-only
 *     transaction — to a file, because the database refuses every write there.
 *   * A document moves a step by its number through its own service, as the
 *     person who said yes: what the service refuses, chat refuses, in the
 *     service's words, and the attempt is audited either way.
 *   * A customer or supplier is created from chat, and a prospect approved.
 *   * A journal entry, a purchase invoice or a sales invoice is keyed from
 *     what the person said and saved as a DRAFT ("draft maker") — every code
 *     resolved to a real record first, nothing posted, and the form's own
 *     service the one that saves it.
 *   * Any document is looked up by its number, as the asker; and the pictures
 *     of a screen travel with the answer.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import { businessToday } from '@/server/domain/business-date';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { DEFAULT_SETTINGS } from '@/server/domain/whatsapp';
import type { PendingAction } from '@/server/domain/whatsapp-do';
import * as ap from '@/server/services/ap-invoice';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as wa from '@/server/services/whatsapp';
import { toolRunnerFor } from '@/server/services/whatsapp-agent';
import * as doService from '@/server/services/whatsapp-do';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let nobody: ActorContext;
let admin: ActorContext;
const CHAT = '120363000000000001@g.us';

const dir = mkdtempSync(join(tmpdir(), 'noah-'));
const issuesFile = join(dir, 'var', 'issues.md');
const shotsDir = join(dir, 'shots');
const previous = { guide: process.env.ERP_GUIDE_DIR, issues: process.env.ERP_ISSUES_FILE, shots: process.env.ERP_GUIDE_SHOTS_DIR };

beforeAll(() => {
  mkdirSync(join(dir, 'docs', 'guide'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'guide', 'payables.md'),
    [
      '# Payables — user guide',
      '',
      '## Purchase Invoices (فواتير الشراء)',
      'Path: Payables → Purchasing & Invoices → Purchase Invoices',
      'Address: /payables/invoices',
      'What it is for: recording what a supplier billed.',
      '',
      '### How to create an invoice — Purchase Invoices',
      '1. Press **New invoice**.',
      '',
      '### Fields — Purchase Invoices',
      '- **Supplier** — who billed; required.',
    ].join('\n'),
  );
  process.env.ERP_GUIDE_DIR = join(dir, 'docs');
  process.env.ERP_ISSUES_FILE = issuesFile;

  mkdirSync(join(shotsDir, 'en'), { recursive: true });
  const shots = (['menu', 'screen', 'form'] as const).map((view) => {
    const file = `en/payables-invoices-${view}.jpg`;
    writeFileSync(join(shotsDir, file), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { route: '/payables/invoices', locale: 'en', view, file };
  });
  writeFileSync(join(shotsDir, 'index.json'), JSON.stringify(shots));
  process.env.ERP_GUIDE_SHOTS_DIR = shotsDir;
});

afterAll(() => {
  if (previous.guide === undefined) delete process.env.ERP_GUIDE_DIR;
  else process.env.ERP_GUIDE_DIR = previous.guide;
  if (previous.issues === undefined) delete process.env.ERP_ISSUES_FILE;
  else process.env.ERP_ISSUES_FILE = previous.issues;
  if (previous.shots === undefined) delete process.env.ERP_GUIDE_SHOTS_DIR;
  else process.env.ERP_GUIDE_SHOTS_DIR = previous.shots;
});

async function createUser(roles: string, name: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles.split('+')) {
    if (role) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** A question's read context, as `wa.answer` builds it: read-only, as the asker. */
function asking<T>(ctx: ActorContext, fn: (read: wa.ReadContext) => Promise<T>): Promise<T> {
  return wa.withReadOnlyScope({ userId: ctx.principal.userId, branchCode: BAGHDAD, isSuperUser: ctx.principal.isSuperUser }, (tx) =>
    fn({ tx, principal: ctx.principal, branchCode: BAGHDAD, locale: 'en', settings: DEFAULT_SETTINGS, today: businessToday() }),
  );
}

const tool = (ctx: ActorContext, name: string, args: Record<string, unknown> = {}) =>
  asking(ctx, (read) => toolRunnerFor(read, [], undefined, { userName: 'Tester', chat: CHAT })(name, args)).then((outcome) => outcome.text);

/** Propose, as the agent would, and hand back what the bridge would hold. */
const propose = (ctx: ActorContext, action: string, args: Record<string, unknown>) =>
  asking(ctx, (read) => doService.prepare({ ctx: read, userId: ctx.principal.userId, chat: CHAT, action, args }));

const confirm = (ctx: ActorContext, pending: PendingAction) => doService.run({ userId: ctx.principal.userId, pending, e164: '+9647700000001' });

async function draftInvoice(): Promise<{ id: string; invoiceNo: string }> {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: `CHAT-${randomUUID().slice(0, 8)}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: parseQuantity('10'),
          unitPriceIqd: parseDecimal('10000', 4n),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select invoice_no from ap_invoice where id = $1`, [made.id]);
  return { id: made.id, invoiceNo: rows[0].invoice_no as string };
}

beforeEach(async () => {
  world = await buildTradingWorld();
  nobody = await createUser('', 'A New Starter');
  admin = await createUser('system_administrator', 'Admin');
});

describe('everybody may ask, and is answered as themselves', () => {
  it('a tool that reads a table directly refuses a role without its screen\'s grant, and names the permission', async () => {
    expect(await tool(nobody, 'trial_balance')).toMatch(/role does not include "trial balance" \(the permission view on trial_balance\)/);
    expect(await tool(nobody, 'employees')).toMatch(/permission view on employee/);
    expect(await tool(nobody, 'bank_and_cash')).toMatch(/permission view on bank_account/);
    expect(await tool(nobody, 'items')).toMatch(/permission view on item/);
    expect(await tool(nobody, 'list_partners', { side: 'supplier' })).toMatch(/permission view on business_partner/);
    expect(await tool(nobody, 'invoice', { side: 'purchase', no: 'API-1' })).toMatch(/permission view on ap_invoice/);
    // The same question, asked by somebody whose role reads the books.
    expect(await tool(world.manager, 'list_partners', { side: 'supplier' })).toMatch(/supplier\(s\):/);
  });

  it('the free query is for the roles that read everything', async () => {
    expect(await tool(nobody, 'query', { sql: 'select 1 as one' })).toMatch(/free query is for the roles that read the whole company/);
    expect(await tool(nobody, 'schema')).toMatch(/free query is for the roles/);
    expect(await tool(world.clerk, 'query', { sql: 'select 1 as one' })).toMatch(/free query is for the roles/);
    // The manager also holds the CEO role.
    expect(await tool(world.manager, 'query', { sql: 'select 1 as one' })).toMatch(/one/);
  });

  it('the menu and the guide are for everybody, whatever their role', async () => {
    const where = await tool(nobody, 'screens', { search: 'purchase invoices' });
    expect(where).toContain('/payables/invoices');
    expect(where).toMatch(/role cannot open it/);
    expect(await tool(world.manager, 'screens', { search: 'purchase invoices' })).not.toMatch(/role cannot open it/);
    expect(await tool(nobody, 'screens')).toMatch(/The top bar/);

    const how = await tool(nobody, 'guide', { search: 'purchase invoice create' });
    expect(how).toContain('Press **New invoice**');
    expect(how).toContain('Path: Payables → Purchasing & Invoices → Purchase Invoices');
    expect(await tool(nobody, 'guide')).toContain('Purchase Invoices (فواتير الشراء)');
  });
});

describe('an issue is written down, from inside a read-only question', () => {
  it('goes to the file with who reported it, and is read back by an administrator', async () => {
    const said = await tool(nobody, 'report_issue', {
      summary: 'Save is refused on a new purchase invoice',
      kind: 'error_message',
      severity: 'blocks_work',
      screen: 'Payables → Purchase Invoices → New',
      doing: 'Raising an invoice for SUP-000001',
      message: 'SUP-000001 is prospect, so a purchase order cannot be raised against them (§6).',
      note: 'The supplier needs approving on its profile.',
    });
    expect(said).toMatch(/Written down as ISS-\d{8}-001/);

    const file = readFileSync(issuesFile, 'utf8');
    expect(file).toContain('# Issues reported to Noah');
    expect(file).toMatch(/## ISS-\d{8}-001 — Save is refused on a new purchase invoice/);
    expect(file).toContain('- Who: A New Starter <');
    expect(file).toContain('- Where reported: WhatsApp group');
    expect(file).toContain('> SUP-000001 is prospect');
    expect(file).toContain('- Status: open');

    // A second one takes the next number; the first is still there.
    expect(await tool(world.clerk, 'report_issue', { summary: 'The stock report is slow', kind: 'slow', severity: 'minor' })).toMatch(/ISS-\d{8}-002/);
    expect(readFileSync(issuesFile, 'utf8')).toMatch(/ISS-\d{8}-001[\s\S]*ISS-\d{8}-002/);

    expect(await tool(nobody, 'report_issue', { summary: '', kind: 'bug', severity: 'minor' })).toMatch(/Not written down/);
    expect(await tool(nobody, 'reported_issues')).toMatch(/for administrators/);
    expect(await tool(admin, 'reported_issues')).toMatch(/The stock report is slow/);
  });
});

describe('a document moves a step by its number, through its own service', () => {
  it('refuses, before anybody is asked, what cannot be: no such document, no such step, no reason', async () => {
    const invoice = await draftInvoice();
    expect(await propose(world.clerk, 'document_step', { step: 'submit', document: 'API-BGW-2026-999999' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/There is no purchase invoice API-BGW-2026-999999/),
    });
    expect(await propose(world.clerk, 'document_step', { step: 'approve', document: invoice.invoiceNo })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/has no "approve" step of its own.*posting IS the approval/),
    });
    expect(await propose(world.clerk, 'document_step', { step: 'reverse', document: invoice.invoiceNo })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/wants a reason/),
    });
    expect(await propose(world.clerk, 'document_step', { step: 'submit', document: 'XYZ-1' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot tell what kind of document XYZ-1 is/),
    });
    expect(await propose(world.clerk, 'document_step', { step: 'fly', document: invoice.invoiceNo })).toMatchObject({ ok: false });
  });

  it('proposes with the facts, changes nothing until a yes, then runs as the person — and the service\'s refusal is the answer', async () => {
    const invoice = await draftInvoice();

    // Posting a draft: proposed (the state is the service's to judge), refused when it runs.
    const early = await propose(world.manager, 'document_step', { step: 'post', document: invoice.invoiceNo.toLowerCase() });
    if (!early.ok) throw new Error(early.reason);
    expect(early.pending.sentence).toContain(`post purchase invoice ${invoice.invoiceNo}`);
    expect(early.pending.sentence).toMatch(/it is draft now, branch BGW/);
    expect(early.pending.sentence).toMatch(/never edited afterwards, only reversed/);
    const refused = await confirm(world.manager, early.pending);
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/posts from submitted/) });
    expect((await ownerPool.query(`select status from ap_invoice where id = $1`, [invoice.id])).rows[0].status).toBe('draft');

    // Submitting it: nothing moves on the proposal, the yes moves it.
    const submit = await propose(world.clerk, 'document_step', { step: 'submit', document: invoice.invoiceNo });
    if (!submit.ok) throw new Error(submit.reason);
    expect(submit.pending).toMatchObject({ action: 'document_step', step: 'submit', chat: CHAT, target: { kind: 'ap_invoice', id: invoice.id, documentNo: invoice.invoiceNo } });
    expect((await ownerPool.query(`select status from ap_invoice where id = $1`, [invoice.id])).rows[0].status).toBe('draft');
    const done = await confirm(world.clerk, submit.pending);
    expect(done).toMatchObject({ ok: true, said: expect.stringMatching(new RegExp(`purchase invoice ${invoice.invoiceNo} submitted\\. It is submitted now\\.`)) });
    expect((await ownerPool.query(`select status, submitted_by from ap_invoice where id = $1`, [invoice.id])).rows[0]).toMatchObject({
      status: 'submitted',
      submitted_by: world.clerk.principal.userId,
    });

    // Somebody with no role at all: the service refuses, in its own words.
    const stranger = await propose(admin, 'document_step', { step: 'submit', document: invoice.invoiceNo });
    if (stranger.ok) {
      const no = await confirm(admin, stranger.pending);
      expect(no.ok).toBe(false);
    }

    // Both attempts are in the audit trail: one refused, one done.
    const { rows } = await ownerPool.query(
      `select outcome, after_value ->> 'step' as step, actor_user_id from audit_event where action = 'whatsapp.action.document_step' and object_id = $1 order by occurred_at`,
      [invoice.id],
    );
    expect(rows.map((row) => `${row.step}:${row.outcome}`).slice(0, 2)).toEqual(['post:denied', 'submit:success']);
    expect(rows[1].actor_user_id).toBe(world.clerk.principal.userId);
  });
});

describe('a customer or a supplier from chat', () => {
  it('is a prospect when its maker cannot approve, and usable once somebody who can says yes', async () => {
    const made = await propose(world.clerk, 'create_partner', { role: 'supplier', name: 'Chat Supplier Co', phone: '+9647701112233' });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending.sentence).toContain('create the supplier "Chat Supplier Co"');
    expect(made.pending.sentence).toMatch(/will be a prospect until somebody who can approves it/);
    expect((await ownerPool.query(`select count(*)::int as n from business_partner where legal_name = 'Chat Supplier Co'`)).rows[0].n).toBe(0);

    const created = await confirm(world.clerk, made.pending);
    expect(created).toMatchObject({ ok: true, said: expect.stringMatching(/Supplier SUP-\d+ · Chat Supplier Co is on the system\. It is a prospect/) });
    const { rows } = await ownerPool.query(`select code, status, is_supplier, phone from business_partner where legal_name = 'Chat Supplier Co'`);
    expect(rows[0]).toMatchObject({ status: 'prospect', is_supplier: true, phone: '+9647701112233' });
    const code = rows[0].code as string;

    // The same name again is the service's to refuse.
    const again = await propose(world.clerk, 'create_partner', { role: 'supplier', name: 'Chat Supplier Co' });
    if (!again.ok) throw new Error(again.reason);
    expect(await confirm(world.clerk, again.pending)).toMatchObject({ ok: false, reason: expect.stringMatching(/already a supplier/) });

    // The officer cannot approve it; the manager can.
    const byClerk = await propose(world.clerk, 'approve_partner', { document: code });
    if (!byClerk.ok) throw new Error(byClerk.reason);
    expect((await confirm(world.clerk, byClerk.pending)).ok).toBe(false);
    const byManager = await propose(world.manager, 'approve_partner', { document: code.toLowerCase() });
    if (!byManager.ok) throw new Error(byManager.reason);
    expect(byManager.pending.sentence).toContain(`approve ${code} · Chat Supplier Co (supplier)`);
    expect(await confirm(world.manager, byManager.pending)).toMatchObject({ ok: true, said: expect.stringMatching(/approved/) });
    expect((await ownerPool.query(`select status from business_partner where code = $1`, [code])).rows[0].status).toBe('active');

    // Nothing to approve twice, and nothing to approve that is not there.
    expect(await propose(world.manager, 'approve_partner', { document: code })).toMatchObject({ ok: false, reason: expect.stringMatching(/not a prospect/) });
    expect(await propose(world.manager, 'approve_partner', { document: 'SUP-999999' })).toMatchObject({ ok: false, reason: expect.stringMatching(/no customer or supplier/) });
  });

  it('entered by somebody who may approve, it is usable at once; and it asks what it needs', async () => {
    const made = await propose(world.manager, 'create_partner', { role: 'customer', name: 'Chat Customer Co' });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending.sentence).toMatch(/approved straight away/);
    expect(await confirm(world.manager, made.pending)).toMatchObject({ ok: true, said: expect.stringMatching(/Customer CUS-\d+ · Chat Customer Co is on the system\. It is approved/) });
    expect(await propose(world.manager, 'create_partner', { name: 'No Role Given' })).toMatchObject({ ok: false, reason: expect.stringMatching(/customer or a supplier/) });
    expect(await propose(world.manager, 'create_partner', { role: 'customer', name: ' ' })).toMatchObject({ ok: false });
  });
});

describe('a draft from chat', () => {
  const codeOf = async (id: string) => (await ownerPool.query(`select code from chart_of_account where id = $1`, [id])).rows[0].code as string;
  const count = async (table: string) => (await ownerPool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

  it('a journal entry: refused while it does not balance or names what is not there, and saved as a draft — posting nothing — on a yes', async () => {
    const expense = await codeOf(world.accounts.expense!);
    const bank = await codeOf(world.accounts.bank!);

    expect(
      await propose(world.clerk, 'create_draft', { kind: 'journal_entry', lines: [{ account: expense, debit: '250,000' }, { account: bank, credit: '200000' }] }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/does not balance: debits 250,000, credits 200,000 — out by 50,000/) });
    expect(await propose(world.clerk, 'create_draft', { kind: 'journal_entry', lines: [{ account: 'Z999999', debit: '1' }, { account: bank, credit: '1' }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Line 1: there is no account Z999999 in the chart/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'journal_entry', lines: [{ account: 'X000001', debit: '1' }, { account: bank, credit: '1' }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is a heading, and nothing posts to a heading/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'journal_entry', lines: [{ account: expense, debit: '5', credit: '5' }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/needs a debit or a credit — one of them/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'payment', lines: [{}] })).toMatchObject({ ok: false, reason: expect.stringMatching(/Which kind of draft/) });
    expect(await propose(world.clerk, 'create_draft', { kind: 'journal_entry', lines: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/at least one line/) });

    const before = await count('journal_entry');
    const made = await propose(world.clerk, 'create_draft', {
      kind: 'journal_entry',
      date: '2026-09-15',
      description: 'Office rent, September',
      lines: [
        { account: expense.toLowerCase(), debit: '250,000', description: 'Rent' },
        { account: bank, credit: 250000 },
      ],
    });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending).toMatchObject({ action: 'create_draft', chat: CHAT, draft: { kind: 'journal_entry', date: '2026-09-15', currency: 'IQD' } });
    expect(made.pending.sentence).toContain('create a DRAFT journal entry dated 2026-09-15 — "Office rent, September", branch BGW');
    expect(made.pending.sentence).toContain(`1. ${expense} · Service and Expense Cost — debit 250,000`);
    expect(made.pending.sentence).toContain(`2. ${bank} · Bank Current Account — credit 250,000`);
    expect(made.pending.sentence).toMatch(/debits 250,000 = credits 250,000 \(IQD\)/);
    expect(made.pending.sentence).toMatch(/Nothing is posted/);
    // Proposing changed nothing.
    expect(await count('journal_entry')).toBe(before);

    const done = await confirm(world.clerk, made.pending);
    if (!done.ok) throw new Error(done.reason);
    expect(done.said).toMatch(/Journal entry JE-\S+ is saved as a draft with 2 line\(s\)\./);
    expect(done.said).toMatch(/\/finance\/journals\/JE-/);
    const { rows } = await ownerPool.query(
      `select j.status, j.posting_date::text as posting_date, j.description, j.created_by,
              (select count(*)::int from journal_line l where l.journal_entry_id = j.id) as lines,
              (select coalesce(sum(l.debit_iqd), 0)::text from journal_line l where l.journal_entry_id = j.id) as debits
         from journal_entry j order by j.created_at desc limit 1`,
    );
    expect(rows[0]).toMatchObject({ status: 'draft', posting_date: '2026-09-15', description: 'Office rent, September', lines: 2, created_by: world.clerk.principal.userId });
    expect(Number(rows[0].debits)).toBe(250000);
    expect(await count('journal_entry')).toBe(before + 1);

    // Somebody whose role keys no journals: whatever chat proposes, the journal's own service refuses.
    const stranger = await propose(nobody, 'create_draft', { kind: 'journal_entry', lines: [{ account: expense, debit: '10' }, { account: bank, credit: '10' }] });
    if (stranger.ok) expect((await confirm(nobody, stranger.pending)).ok).toBe(false);
    expect(await count('journal_entry')).toBe(before + 1);

    // The saving is in the audit trail, as the person who said yes.
    const audit = await ownerPool.query(
      `select outcome, actor_user_id, after_value -> 'draft' ->> 'kind' as kind from audit_event where action = 'whatsapp.action.create_draft' and outcome = 'success' order by occurred_at desc limit 1`,
    );
    expect(audit.rows[0]).toMatchObject({ kind: 'journal_entry', actor_user_id: world.clerk.principal.userId });
  });

  it('a purchase invoice: the supplier, the item and the warehouse are found first; saved as a draft that owes nothing yet', async () => {
    expect(await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'Nobody Ltd', lines: [{ item: PANEL, quantity: 1, unitPrice: 1 }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/No active, approved supplier matches "Nobody Ltd"/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', lines: [{ item: PANEL, quantity: 1, unitPrice: 1 }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Which supplier\?/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'jinko', lines: [{ item: 'ITM-NOPE', quantity: 1, unitPrice: 1 }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Line 1: no item "ITM-NOPE"/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'jinko', lines: [{ item: PANEL, quantity: 'many', unitPrice: 1 }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/how many\?/),
    });
    expect(await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'jinko', lines: [{ item: PANEL, quantity: 2 }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/what is the unit price in IQD\?/),
    });
    expect(
      await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'jinko', lines: [{ item: PANEL, quantity: 2, unitPrice: 5, warehouse: 'WH-NOPE' }] }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/there is no active warehouse WH-NOPE in branch BGW/) });

    const before = await count('ap_invoice');
    const made = await propose(world.clerk, 'create_draft', {
      kind: 'purchase_invoice',
      party: 'jinko',
      date: '2026-09-10',
      dueDate: '2026-11-10',
      description: 'Keyed from chat',
      lines: [{ item: 'itm-panel', quantity: '10', unitPrice: '10,000', discount: '5,000', warehouse: 'wh-main' }],
    });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending.sentence).toMatch(/create a DRAFT purchase invoice — supplier \S+ · Jinko Solar, dated 2026-09-10, due 2026-11-10, in IQD, branch BGW/);
    expect(made.pending.sentence).toContain('a local purchase (not an import)');
    expect(made.pending.sentence).toContain(`1. ${PANEL} · Solar Panel 550W — 10 × 10,000 − 5,000 → warehouse ${WAREHOUSE}`);
    expect(made.pending.sentence).toContain('total 95,000 IQD');
    expect(made.pending.sentence).toMatch(/no journal, no stock, nothing owed yet/);
    expect(await count('ap_invoice')).toBe(before);

    const done = await confirm(world.clerk, made.pending);
    if (!done.ok) throw new Error(done.reason);
    expect(done.said).toMatch(/Purchase invoice API-\S+ is saved as a draft for \S+ · Jinko Solar\./);
    expect(done.said).toMatch(/\/payables\/invoices\/API-/);
    const { rows } = await ownerPool.query(
      `select i.invoice_no, i.status, i.supplier_id, i.invoice_date::text as invoice_date, i.journal_entry_id, i.created_by,
              (select count(*)::int from ap_invoice_line l where l.ap_invoice_id = i.id) as lines
         from ap_invoice i order by i.created_at desc limit 1`,
    );
    expect(rows[0]).toMatchObject({ status: 'draft', supplier_id: world.supplierId, invoice_date: '2026-09-10', journal_entry_id: null, lines: 1, created_by: world.clerk.principal.userId });
    expect(await count('inventory_movement')).toBe(0);

    // What he made can be looked up by its number, and moved on by the usual step.
    const no = rows[0].invoice_no as string;
    const seen = await tool(world.clerk, 'document_status', { no: no.toLowerCase() });
    expect(seen).toContain(`${no} · purchase invoice`);
    expect(seen).toMatch(/status: draft · branch BGW · 95,000 IQD/);
    expect(seen).toContain(`/payables/invoices/${no}`);
    expect(await tool(nobody, 'document_status', { no })).toMatch(/role does not include "purchase invoice"/);
    expect(await tool(world.clerk, 'document_status', { no: 'API-BGW-2026-999999' })).toMatch(/There is no purchase invoice API-BGW-2026-999999/);
    expect(await tool(world.clerk, 'document_status', { no: 'XYZ-1' })).toMatch(/cannot tell what kind of document XYZ-1 is/);
    const submit = await propose(world.clerk, 'document_step', { step: 'submit', document: no });
    if (!submit.ok) throw new Error(submit.reason);
    expect(await confirm(world.clerk, submit.pending)).toMatchObject({ ok: true });
  });

  it('a purchase priced in dollars is put to the person with the rate of its date, and a missing rate is said', async () => {
    // Two warehouses in the branch: he asks which, and does not pick one.
    expect(await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'jinko', lines: [{ item: PANEL, quantity: 10, unitPrice: 100 }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/which warehouse does it arrive in\? The choices: .*WH-MAIN · Main Warehouse/),
    });
    const made = await propose(world.clerk, 'create_draft', {
      kind: 'purchase_invoice',
      party: 'jinko',
      date: '2026-09-10',
      currency: 'usd',
      lines: [{ item: PANEL, quantity: 10, unitPrice: 100, warehouse: WAREHOUSE }],
    });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending.sentence).toMatch(/in USD \(1 USD = 1,310 IQD on 2026-09-10\)/);
    expect(made.pending.sentence).toContain('total 1,000 USD (1,310,000 IQD)');
    const done = await confirm(world.clerk, made.pending);
    if (!done.ok) throw new Error(done.reason);
    const { rows } = await ownerPool.query(`select status, agreed_currency, agreed_rate::text as agreed_rate from ap_invoice order by created_at desc limit 1`);
    expect(rows[0]).toMatchObject({ status: 'draft', agreed_currency: 'USD' });
    expect(Number(rows[0].agreed_rate)).toBe(1310);

    expect(
      await propose(world.clerk, 'create_draft', { kind: 'purchase_invoice', party: 'jinko', currency: 'EUR', lines: [{ item: PANEL, quantity: 1, unitPrice: 1 }] }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/There is no EUR rate for/) });
  });

  it('a sales invoice: the customer by name, saved as a draft from which no stock has left', async () => {
    const before = await count('ar_invoice');
    const made = await propose(world.clerk, 'create_draft', {
      kind: 'sales_invoice',
      party: 'al noor',
      date: '2026-09-12',
      lines: [{ item: 'Solar Panel 550W', quantity: 2, unitPrice: 15000, warehouse: WAREHOUSE }],
    });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending.sentence).toMatch(/create a DRAFT sales invoice — customer \S+ · Al Noor Trading, dated 2026-09-12, in IQD, branch BGW/);
    expect(made.pending.sentence).toContain(`1. ${PANEL} · Solar Panel 550W — 2 × 15,000 → warehouse ${WAREHOUSE}`);
    expect(made.pending.sentence).toContain('total 30,000 IQD');
    expect(await count('ar_invoice')).toBe(before);

    const done = await confirm(world.clerk, made.pending);
    if (!done.ok) throw new Error(done.reason);
    expect(done.said).toMatch(/Sales invoice INV-\S+ is saved as a draft for \S+ · Al Noor Trading\./);
    const { rows } = await ownerPool.query(`select status, customer_id, journal_entry_id from ar_invoice order by created_at desc limit 1`);
    expect(rows[0]).toMatchObject({ status: 'draft', customer_id: world.customerId, journal_entry_id: null });
    expect(await count('inventory_movement')).toBe(0);

    // A supplier is not a customer.
    expect(await propose(world.clerk, 'create_draft', { kind: 'sales_invoice', party: 'jinko', lines: [{ item: PANEL, quantity: 1, unitPrice: 1, warehouse: WAREHOUSE }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/No active, approved customer matches "jinko"/),
    });
  });
});

describe('the pictures of a screen travel with the answer', () => {
  const show = (ctx: ActorContext, args: Record<string, unknown>) =>
    asking(ctx, (read) => toolRunnerFor(read, [], undefined, { userName: 'Tester', chat: CHAT })('show_screen', args));

  it('show_screen attaches them for somebody who may open the screen, each with its tag', async () => {
    const shown = await show(world.manager, { screen: '/payables/invoices', view: 'all' });
    expect(shown.text).toMatch(/3 picture\(s\) of Purchase Invoices/);
    expect(shown.text).toContain('[picture: payables-invoices-menu]');
    expect(shown.images).toHaveLength(3);
    const closed = await show(nobody, { screen: '/payables/invoices' });
    expect(closed.images ?? []).toEqual([]);
    expect(closed.text).toMatch(/role cannot open Purchase Invoices/);
  });

  it('untagged, the words go first and each picture follows under what it shows', async () => {
    const shown = await show(world.manager, { screen: '/payables/invoices', view: 'all' });
    const reply = await wa.answer({
      userId: world.manager.principal.userId,
      text: 'where do I enter a purchase invoice?',
      agent: async () => ({
        text: 'Payables → Purchasing & Invoices → Purchase Invoices. The ringed entry in the first picture is the one to click.',
        model: null,
        used: ['screens', 'show_screen'],
        images: [...(shown.images ?? []), { file: join(shotsDir, 'en', 'never-made.jpg'), caption: 'missing' }],
      }),
    });
    // The one whose file is not there is left out; the words still go.
    expect(reply.images.map((image) => image.fileName)).toEqual(['payables-invoices-menu.jpg', 'payables-invoices-screen.jpg', 'payables-invoices-form.jpg']);
    expect(reply.images[0]).toMatchObject({ format: 'image', contentType: 'image/jpeg', caption: expect.stringMatching(/Purchase Invoices: where it is in the menu/) });
    expect(reply.images[0]!.body.length).toBe(4);
    expect(reply.parts.map((part) => (part.image ? part.image.fileName : 'words'))).toEqual(['words', 'payables-invoices-menu.jpg', 'payables-invoices-screen.jpg', 'payables-invoices-form.jpg']);
    expect(reply.text).toContain('The ringed entry in the first picture');
    expect(reply.attachment).toBeNull();
  });

  it('tagged, each step is sent under its own picture, and the stamp closes the last of them', async () => {
    const shown = await show(world.manager, { screen: '/payables/invoices', view: 'all' });
    const reply = await wa.answer({
      userId: world.manager.principal.userId,
      text: 'how do I enter a purchase invoice?',
      agent: async () => ({
        text: [
          'To enter a purchase invoice:',
          '',
          '[picture: payables-invoices-menu]',
          '*Step 1* — open *Payables* and click *Purchase Invoices*, ringed in red.',
          '',
          '[picture: payables-invoices-screen]',
          '*Step 2* — press *New invoice*.',
          '',
          '[picture: payables-invoices-form]',
          '*Step 3* — 1 — *Supplier*: who billed you; required.',
        ].join('\n'),
        model: null,
        used: ['guide', 'show_screen'],
        images: shown.images ?? [],
      }),
    });
    expect(reply.parts.map((part) => [part.image?.fileName ?? null, part.text.split('\n')[0]])).toEqual([
      [null, 'To enter a purchase invoice:'],
      ['payables-invoices-menu.jpg', '*Step 1* — open *Payables* and click *Purchase Invoices*, ringed in red.'],
      ['payables-invoices-screen.jpg', '*Step 2* — press *New invoice*.'],
      ['payables-invoices-form.jpg', '*Step 3* — 1 — *Supplier*: who billed you; required.'],
    ]);
    // W-R7: when it was read, under which branch, as whom — under the last step, and in its caption.
    const last = reply.parts[reply.parts.length - 1]!;
    expect(last.text).toMatch(/BGW/);
    expect(last.image!.caption).toBe(last.text);
    expect(reply.parts[1]!.image!.caption).toBe('*Step 1* — open *Payables* and click *Purchase Invoices*, ringed in red.');
    // The record keeps the whole answer, without the tags.
    expect(reply.text).not.toMatch(/\[picture/);
    expect(reply.text).toContain('*Step 2* — press *New invoice*.');
  });

  it('an answer with no pictures is one message, as it always was', async () => {
    const reply = await wa.answer({
      userId: world.manager.principal.userId,
      text: 'what is an import?',
      agent: async () => ({ text: 'A payable whose goods come from abroad.', model: null, used: [] }),
    });
    expect(reply.images).toEqual([]);
    expect(reply.parts).toEqual([{ text: reply.text, image: null }]);
  });
});

describe('the look-ups a draft needs', () => {
  it('finds an account by part of its name, and says the rate of a date', async () => {
    const found = await tool(world.clerk, 'accounts', { search: 'bank current' });
    expect(found).toMatch(/1 account\(s\) matching "bank current":/);
    expect(found).toMatch(/A9\d{5} · Bank Current Account · /);
    expect(await tool(world.clerk, 'accounts', { search: 'x000001' })).toMatch(/X000001 · .* · HEADING \(nothing posts to it\)/);
    expect(await tool(world.clerk, 'accounts', { search: 'trade payables' })).toMatch(/supplier control account/);
    expect(await tool(world.clerk, 'accounts', { search: 'no such account anywhere' })).toMatch(/No account matches/);
    expect(await tool(nobody, 'accounts')).toMatch(/permission view on chart_of_account/);

    expect(await tool(world.clerk, 'exchange_rate', { currency: 'usd', date: '2026-09-10' })).toMatch(/1 USD = 1,310 IQD on 2026-09-10 \(the accounting rate in force since 2026-01-01\)/);
    expect(await tool(world.clerk, 'exchange_rate', { currency: 'IQD' })).toMatch(/1 IQD = 1 IQD/);
    expect(await tool(world.clerk, 'exchange_rate', { currency: 'XYZ' })).toMatch(/XYZ: no accounting rate/);
    expect(await tool(nobody, 'exchange_rate')).toMatch(/permission view on exchange_rate/);
  });
});

describe('one refused statement does not end the question', () => {
  // 2026-10-04, the first real question in the group: a query named a column
  // that does not exist, PostgreSQL aborted the question's transaction, and
  // every tool after it — the schema look-up, a second query, even writing the
  // problem down — was refused. He told the group his database was down.
  it('a wrong column is said, and the schema, the next query and the issues list all still work', async () => {
    await asking(world.manager, async (read) => {
      const run = toolRunnerFor(read, [], undefined, { userName: 'Tester', chat: CHAT });

      const wrong = await run('query', { sql: 'select bp.code, bp.name from business_partner bp' });
      expect(wrong.text).toMatch(/PostgreSQL refused the query: .*column bp\.name does not exist/);
      expect(wrong.text).toMatch(/Nothing else was affected/);

      // The look-up that corrects the query, in the same question.
      const columns = await run('schema', { table: 'business_partner' });
      expect(columns.text).toMatch(/legal_name text not null/);
      const right = await run('query', { sql: 'select bp.code, bp.legal_name from business_partner bp order by bp.code' });
      expect(right.text).toMatch(/Jinko Solar/);

      // A named tool, and the issues list, after a second failure.
      expect((await run('query', { sql: 'select * from no_such_table' })).text).toMatch(/PostgreSQL refused the query: .*no_such_table/);
      expect((await run('list_partners', { side: 'supplier' })).text).toMatch(/supplier\(s\):/);
      const filed = await run('report_issue', { summary: 'A query named a column that is not there', kind: 'bug', severity: 'minor' });
      expect(filed.text).toMatch(/Written down as ISS-\d{8}-\d{3}/);
    });
    expect(readFileSync(issuesFile, 'utf8')).toMatch(/A query named a column that is not there/);
  });
});

describe('he reads a thing whole before he explains it', () => {
  // 2026-10-04: "make it drastically understand everything". The first real
  // question was "I completed the sale and the customer account is empty".
  it('document_story: what it is, its lines, that nothing has posted, who did what, and what comes next', async () => {
    const invoice = await draftInvoice();
    const draft = await tool(world.clerk, 'document_story', { no: invoice.invoiceNo.toLowerCase() });
    expect(draft).toContain(`${invoice.invoiceNo} · purchase invoice · status: DRAFT · branch BGW`);
    expect(draft).toMatch(/supplier: \S+ · Jinko Solar/);
    expect(draft).toMatch(/dated 2026-09-01 · due 2026-11-01/);
    expect(draft).toMatch(/LINES \(1\):\n1\. ITM-PANEL · Solar Panel 550W — 10 EA × 10,000 · warehouse WH-MAIN/);
    expect(draft).toMatch(/JOURNAL: none — this document has written NOTHING to the ledger/);
    expect(draft).toMatch(/STOCK MOVEMENTS: none — this document has moved no stock/);
    expect(draft).toMatch(/PAYMENTS AGAINST IT: none/);
    expect(draft).toMatch(/WHO: raised by /);
    expect(draft).toMatch(/WHAT THIS MEANS: NOTHING HAS POSTED: no journal, no stock in, nothing owed\. Next: submit it/);
    expect(draft).toContain(`/payables/invoices/${invoice.invoiceNo}`);

    // After a step taken from chat, the history says who did it — and the meaning moves on.
    const submit = await propose(world.clerk, 'document_step', { step: 'submit', document: invoice.invoiceNo });
    if (!submit.ok) throw new Error(submit.reason);
    expect(await confirm(world.clerk, submit.pending)).toMatchObject({ ok: true });
    const submitted = await tool(world.manager, 'document_story', { no: invoice.invoiceNo });
    expect(submitted).toContain('status: SUBMITTED');
    expect(submitted).toMatch(/submitted by /);
    expect(submitted).toMatch(/HISTORY \(\d+ event\(s\), oldest first\):[\s\S]*whatsapp\.action\.document_step/);
    expect(submitted).toMatch(/Waiting to be posted by a second person/);

    // As the asker: no grant, no story; no such document, said plainly.
    expect(await tool(nobody, 'document_story', { no: invoice.invoiceNo })).toMatch(/role does not include "purchase invoice"/);
    expect(await tool(world.clerk, 'document_story', { no: 'API-BGW-2026-999999' })).toMatch(/There is no purchase invoice API-BGW-2026-999999/);
    expect(await tool(world.clerk, 'document_story', { no: 'XYZ-1' })).toMatch(/cannot tell what kind of document XYZ-1 is/);
  });

  it('document_story reads a journal draft with its lines, and a sales draft that has moved nothing', async () => {
    const expense = (await ownerPool.query(`select code from chart_of_account where id = $1`, [world.accounts.expense])).rows[0].code as string;
    const bank = (await ownerPool.query(`select code from chart_of_account where id = $1`, [world.accounts.bank])).rows[0].code as string;
    const made = await propose(world.clerk, 'create_draft', { kind: 'journal_entry', date: '2026-09-15', description: 'Office rent', lines: [{ account: expense, debit: 250000 }, { account: bank, credit: 250000 }] });
    if (!made.ok) throw new Error(made.reason);
    const saved = await confirm(world.clerk, made.pending);
    if (!saved.ok) throw new Error(saved.reason);
    const no = /JE-\S+/.exec(saved.said)![0];
    const journal = await tool(world.clerk, 'document_story', { no });
    expect(journal).toContain(`${no} · journal entry · status: DRAFT`);
    expect(journal).toMatch(new RegExp(`JOURNAL LINES:\\n1\\. Dr 250,000 — ${expense} · Service and Expense Cost\\n2\\. Cr 250,000 — ${bank} · Bank Current Account`));
    expect(journal).toMatch(/A draft: nothing is in the ledger/);

    const sale = await propose(world.clerk, 'create_draft', { kind: 'sales_invoice', party: 'al noor', lines: [{ item: PANEL, quantity: 2, unitPrice: 15000, warehouse: WAREHOUSE }] });
    if (!sale.ok) throw new Error(sale.reason);
    const sold = await confirm(world.clerk, sale.pending);
    if (!sold.ok) throw new Error(sold.reason);
    const inv = /INV-\S+/.exec(sold.said)![0];
    const story = await tool(world.clerk, 'document_story', { no: inv });
    expect(story).toMatch(/customer: \S+ · Al Noor Trading/);
    expect(story).toMatch(/net 30,000 IQD · received against it 0 IQD/);
    expect(story).toMatch(/JOURNAL: none/);
    expect(story).toMatch(/RECEIPTS AGAINST IT: none/);
    // The sentence that answers "why is the customer account empty".
    expect(story).toMatch(/NOTHING HAS POSTED: no journal, no receivable on the customer, no stock out/);
  });

  it('activity_log is the audit trail, searched — for whoever holds the Audit Log screen', async () => {
    expect(await tool(nobody, 'activity_log')).toMatch(/permission view on audit_event/);
    const reader = [admin, world.manager, world.clerk].find((ctx) => ctx.principal.isSuperUser || ctx.principal.grants.some((grant) => grant.object === 'audit_event' && grant.verb === 'view'));
    if (!reader) throw new Error('no fixture role reads the audit log');

    const invoice = await draftInvoice();
    const refused = await propose(world.manager, 'document_step', { step: 'post', document: invoice.invoiceNo });
    if (!refused.ok) throw new Error(refused.reason);
    expect((await confirm(world.manager, refused.pending)).ok).toBe(false);

    const all = await tool(reader, 'activity_log', { document: invoice.invoiceNo });
    expect(all).toMatch(/event\(s\) on \S+, newest first:/);
    expect(all).toMatch(/whatsapp\.action\.document_step · DENIED/);
    const problems = await tool(reader, 'activity_log', { outcome: 'problems', action: 'whatsapp', limit: 5 });
    expect(problems).toMatch(/that were refused or failed/);
    expect(problems).toMatch(/DENIED/);
    expect(await tool(reader, 'activity_log', { user: 'nobody-by-this-name-anywhere' })).toMatch(/Nothing in the audit trail by "nobody-by-this-name-anywhere"/);
    expect(await tool(reader, 'activity_log', { from: '2020-01-01', to: '2020-01-02' })).toMatch(/Nothing in the audit trail from 2020-01-01, to 2020-01-02/);
  });

  it('system_status says whether the system is well, and shows its keepers the jobs and the error log', async () => {
    const jobs = join(dir, 'jobs');
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, 'backup.last'), '2026-10-04T02:00:07Z 0 41\n');
    writeFileSync(join(jobs, 'closing-checks.last'), '2026-10-04T03:40:07Z 1 5\n');
    const log = join(dir, 'error.log');
    writeFileSync(
      log,
      [
        '2026-10-04T19:48:26: Error: MISSING_MESSAGE: posting_map.role.inventory (ar)',
        '2026-10-04T19:48:26:     at <unknown> (.next/server/chunks/ssr/_1.js:1:3114)',
        '2026-10-04T19:48:27: Error: MISSING_MESSAGE: posting_map.role.inventory (ar)',
        '2026-10-04T19:48:27: (node:1) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.',
        '2026-10-04T20:39:18: Error: The Server Reference ID did not match the expected format.',
      ].join('\n'),
    );
    const before = { jobs: process.env.JOB_STATE_DIR, log: process.env.ERP_ERROR_LOG, deployed: process.env.ERP_DEPLOYED_AT };
    process.env.JOB_STATE_DIR = jobs;
    process.env.ERP_ERROR_LOG = log;
    // The build that is running was deployed between the two errors.
    process.env.ERP_DEPLOYED_AT = '2026-10-04T20:00';
    try {
      const brief = await tool(nobody, 'system_status');
      expect(brief).toMatch(/The system is (HEALTHY|DEGRADED): the database answers; migrations \d+ applied of \d+/);
      expect(brief).not.toMatch(/SCHEDULED JOBS|ERROR LOG/);

      const full = await tool(admin, 'system_status');
      expect(full).toMatch(/migrations \d+ applied of \d+ — at head, nothing waiting/);
      expect(full).toMatch(/SCHEDULED JOBS \(2\): 1 FAILED on its last run\./);
      expect(full).toMatch(/backup: ok · last run 04\/10\/2026 05:00 · 41s/);
      expect(full).toMatch(/closing-checks: FAILED \(exit 1\)/);
      // An error under the running build is a current one…
      expect(full).toMatch(/ERROR LOG — 1 distinct error\(s\) since this build was deployed \(2026-10-04 20:00, server time\)[^\n]*\n2026-10-04T20:39 Error: The Server Reference ID did not match/);
      // …and one from before it is set apart, said once with its count, and not to be reported as it stands.
      expect(full).toMatch(/BEFORE this build — 1 error\(s\) from an earlier build\.[^\n]*do NOT report one as a current defect[^\n]*\n2026-10-04T19:48 Error: MISSING_MESSAGE: posting_map\.role\.inventory \(ar\) \(×2\)/);
      // A stack frame and a warning are not errors.
      expect(full).not.toMatch(/MaxListenersExceededWarning|chunks\/ssr/);
    } finally {
      if (before.jobs === undefined) delete process.env.JOB_STATE_DIR;
      else process.env.JOB_STATE_DIR = before.jobs;
      if (before.log === undefined) delete process.env.ERP_ERROR_LOG;
      else process.env.ERP_ERROR_LOG = before.log;
      if (before.deployed === undefined) delete process.env.ERP_DEPLOYED_AT;
      else process.env.ERP_DEPLOYED_AT = before.deployed;
    }
  });

  it('a refused query comes back with the real columns, and several tables are described in one call', async () => {
    const wrong = await tool(world.manager, 'query', { sql: 'select bp.code, bp.name from business_partner bp join ar_invoice i on i.customer_id = bp.id' });
    expect(wrong).toMatch(/PostgreSQL refused the query: column bp\.name does not exist/);
    expect(wrong).toMatch(/The real columns — write it again with these:/);
    expect(wrong).toMatch(/business_partner: id, code, legal_name,/);
    expect(wrong).toMatch(/ar_invoice: id, invoice_no, status,/);

    const noTable = await tool(world.manager, 'query', { sql: 'select * from sales_invoice' });
    expect(noTable).toMatch(/There is no table "sales_invoice"\. Tables with a name like it: .*ar_invoice/);

    const both = await tool(world.manager, 'schema', { table: 'ar_invoice, ar_invoice_line' });
    expect(both).toMatch(/ar_invoice:\n[\s\S]*invoice_no text not null[\s\S]*ar_invoice_line:\n[\s\S]*net_iqd/);
    expect(both).toMatch(/joins: .*customer_id → business_partner\(id\)/);
    expect(both).toMatch(/joins: .*ar_invoice_id → ar_invoice\(id\)/);
  });

  it('what he did to get an answer is kept with it', async () => {
    const reply = await wa.answer({
      userId: world.manager.principal.userId,
      text: 'why is the customer account empty?',
      agent: async () => ({
        text: 'It is approved, not posted.',
        model: null,
        used: ['query', 'document_story'],
        trace: [
          { tool: 'query', args: '{"sql":"select bp.name from business_partner bp"}', ms: 12, ok: false, said: 'PostgreSQL refused the query: column bp.name does not exist.' },
          { tool: 'document_story', args: '{"no":"INV-1"}', ms: 40, ok: true },
        ],
      }),
    });
    expect(reply.detail).toMatchObject({ tools: ['query', 'document_story'], failed: 1 });
    expect((reply.detail.trace as unknown[]).length).toBe(2);
    expect(typeof reply.detail.seconds).toBe('number');
  });
});

describe('what they sent is entered as it is written', () => {
  it('a purchase draft carries the supplier own invoice number and each line its words', async () => {
    const made = await propose(world.clerk, 'create_draft', {
      kind: 'purchase_invoice',
      party: 'jinko',
      date: '2026-09-20',
      supplierInvoiceNo: 'JK-2026-00917',
      lines: [{ item: PANEL, quantity: 4, unitPrice: 12500, warehouse: WAREHOUSE, description: 'Tiger Neo 550W mono' }],
    });
    if (!made.ok) throw new Error(made.reason);
    expect(made.pending.sentence).toContain("the supplier's own invoice number: JK-2026-00917");
    expect(made.pending.draft).toMatchObject({ supplierInvoiceNo: 'JK-2026-00917' });
    const done = await confirm(world.clerk, made.pending);
    if (!done.ok) throw new Error(done.reason);
    const { rows } = await ownerPool.query(
      `select i.supplier_invoice_no, i.status, (select l.description from ap_invoice_line l where l.ap_invoice_id = i.id limit 1) as line
         from ap_invoice i order by i.created_at desc limit 1`,
    );
    expect(rows[0]).toMatchObject({ supplier_invoice_no: 'JK-2026-00917', status: 'draft', line: 'Tiger Neo 550W mono' });
  });

  it('the people behind the contacts are named for the group roster', async () => {
    await withScope(scope(admin), (tx) =>
      wa.saveContact(tx, admin, { userId: world.manager.principal.userId, e164: '+9647701112233', allowNotifications: true, allowQueries: true, allowDigest: false }),
    );
    const people = await withScope(scope(admin), (tx) => wa.contactPeople(tx));
    expect(people.get('+9647701112233')).toMatchObject({ email: expect.stringContaining('@') });
    expect(people.get('+9647700000000')).toBeUndefined();
  });
});
