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
const previous = { guide: process.env.ERP_GUIDE_DIR, issues: process.env.ERP_ISSUES_FILE };

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
});

afterAll(() => {
  if (previous.guide === undefined) delete process.env.ERP_GUIDE_DIR;
  else process.env.ERP_GUIDE_DIR = previous.guide;
  if (previous.issues === undefined) delete process.env.ERP_ISSUES_FILE;
  else process.env.ERP_ISSUES_FILE = previous.issues;
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
