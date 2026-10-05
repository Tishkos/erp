/**
 * Preview before it happens, and "do it all" plans — 2026-10-05, by direction.
 *
 *   * "What will posting INV-… do? He runs the posting for real and
 *     immediately undoes it, then shows the exact journal lines and stock
 *     movements it would write." So a preview is held to two things at once:
 *     NOTHING is left behind — not a row, not a status, not a document number
 *     drawn from a series — and what it said is what the real step then does,
 *     line for line.
 *   * "Bring in the stock and post the invoice. He lays out the steps in
 *     order, you approve, and he runs them one at a time, checking the result
 *     after each and stopping at the first refusal." So a plan is one yes for
 *     several ordinary steps: each its own transaction and its own audit row,
 *     a refusal ends it, and what ran before the refusal stays done.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import { businessToday } from '@/server/domain/business-date';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { DEFAULT_SETTINGS, money, quantity } from '@/server/domain/whatsapp';
import { ACTION_NAMES, actionLabel, type PendingAction } from '@/server/domain/whatsapp-do';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as opening from '@/server/services/opening-stock';
import * as wa from '@/server/services/whatsapp';
import * as doService from '@/server/services/whatsapp-do';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
/** A super user: the testing phase's "everything for everyone". */
let boss: ActorContext;
/** Somebody with a branch and no role at all. */
let nobody: ActorContext;
const CHAT = '120363000000000001@g.us';
const qty = (value: string) => parseQuantity(value);
const iqd = (value: string) => parseDecimal(value, 4n);

async function createUser(name: string, options: { superUser?: boolean } = {}): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [id, `${id}@example.com`, name, options.superUser === true]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** A question's read context, as `wa.answer` builds it: read-only, as the asker. */
function asking<T>(ctx: ActorContext, fn: (read: wa.ReadContext) => Promise<T>): Promise<T> {
  return wa.withReadOnlyScope({ userId: ctx.principal.userId, branchCode: BAGHDAD, isSuperUser: ctx.principal.isSuperUser }, (tx) =>
    fn({ tx, principal: ctx.principal, branchCode: BAGHDAD, locale: 'en', settings: DEFAULT_SETTINGS, today: businessToday() }),
  );
}

const propose = (ctx: ActorContext, action: string, args: Record<string, unknown>) =>
  asking(ctx, (read) => doService.prepare({ ctx: read, userId: ctx.principal.userId, chat: CHAT, action, args }));

const confirm = (ctx: ActorContext, pending: PendingAction) => doService.run({ userId: ctx.principal.userId, pending, e164: '+9647700000001' });

const previewOf = (ctx: ActorContext, action: string, args: Record<string, unknown>) =>
  asking(ctx, (read) => doService.preview({ ctx: read, userId: ctx.principal.userId, chat: CHAT, action, args }));

/** Propose and say yes, for the steps a test needs done for real. */
async function act(ctx: ActorContext, action: string, args: Record<string, unknown>) {
  const proposed = await propose(ctx, action, args);
  if (!proposed.ok) throw new Error(proposed.reason);
  return confirm(ctx, proposed.pending);
}

// ── documents ──────────────────────────────────────────────────────────────

/** A purchase invoice for 10 panels at 10,000, raised by the clerk; submitted unless asked for as a draft. */
async function purchaseInvoice(state: 'draft' | 'submitted' = 'submitted'): Promise<{ id: string; no: string }> {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: `WA19-${randomUUID().slice(0, 8)}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: qty('10'),
          unitPriceIqd: iqd('10000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  if (state === 'submitted') await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
  const { rows } = await ownerPool.query(`select invoice_no from ap_invoice where id = $1`, [made.id]);
  return { id: made.id, no: rows[0].invoice_no as string };
}

/** A sales invoice for 65 panels at 15,000, approved and waiting to be posted. */
async function salesInvoice(): Promise<{ id: string; no: string }> {
  const made = await withScope(scope(boss), (tx) =>
    ar.createDirect(tx, boss, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-10',
      dueDate: '2026-10-10',
      lines: [{ itemCode: PANEL, quantity: qty('65'), unitPriceIqd: iqd('15000'), warehouseCode: WAREHOUSE }],
    }),
  );
  await withScope(scope(boss), (tx) => ar.approve(tx, boss, made.id));
  return { id: made.id, no: made.invoiceNo };
}

/** Opening stock of 100 panels at 10,000: a draft, or submitted. */
async function openingStock(state: 'draft' | 'submitted'): Promise<{ id: string; no: string }> {
  const made = await withScope(scope(boss), (tx) =>
    opening.create(tx, boss, {
      branchCode: BAGHDAD,
      warehouseCode: WAREHOUSE,
      documentDate: '2026-01-31',
      description: 'Go-live opening position',
      lines: [{ itemCode: PANEL, quantity: qty('100'), uomCode: 'EA', unitCostIqd: iqd('10000'), costLayerDate: '2025-11-01' }],
    }),
  );
  if (state === 'submitted') await withScope(scope(boss), (tx) => opening.submit(tx, boss, made.id));
  return { id: made.id, no: made.documentNo };
}

// ── what must not move ─────────────────────────────────────────────────────

const COUNTED = [
  'journal_entry',
  'journal_line',
  'inventory_movement',
  'cost_layer',
  'cost_layer_consumption',
  'subledger_entry',
  'notification',
  'notification_delivery',
  'job_outbox',
  'doc_number_allocation',
  'audit_event',
] as const;

interface Snapshot {
  readonly counts: Record<string, number>;
  /** Every document-number sequence PostgreSQL holds, and where it stands. */
  readonly sequences: readonly { sequencename: string; last_value: string | null }[];
  /** Every series, as the allocations record it. */
  readonly series: readonly { key: string; highest: string; issued: number }[];
  /** Every other counter in the database: the surrogate ids of rows. */
  readonly counters: Record<string, string | null>;
  readonly layers: string;
  readonly document: unknown;
}

async function snapshot(document?: { table: string; id: string }): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED) counts[table] = (await ownerPool.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
  counts.previews = (await ownerPool.query(`select count(*)::int as n from audit_event where action = 'whatsapp.preview'`)).rows[0].n as number;
  const sequences = (await ownerPool.query(`select sequencename, last_value::text as last_value from pg_sequences where schemaname = 'public' and sequencename like 'docseq\\_%' order by sequencename`))
    .rows as { sequencename: string; last_value: string | null }[];
  const series = (
    await ownerPool.query(`select sequence_key || '/' || scope_key as key, max(serial)::text as highest, count(*)::int as issued from doc_number_allocation group by 1 order by 1`)
  ).rows as { key: string; highest: string; issued: number }[];
  const counters: Record<string, string | null> = {};
  for (const row of (await ownerPool.query(`select sequencename, last_value::text as last_value from pg_sequences where schemaname = 'public' and sequencename not like 'docseq\\_%'`)).rows) {
    counters[row.sequencename as string] = row.last_value as string | null;
  }
  const layers = (await ownerPool.query(`select coalesce(string_agg(id::text || ':' || remaining_quantity::text, ',' order by id), '') as s from cost_layer`)).rows[0].s as string;
  const row = document ? (await ownerPool.query(`select to_jsonb(t) as doc from ${document.table} t where t.id = $1`, [document.id])).rows[0]?.doc : null;
  return { counts, sequences, series, counters, layers, document: row ?? null };
}

/** After a preview: everything as it was, but for the rows saying a preview was given. */
async function expectNothingLeft(before: Snapshot, document: { table: string; id: string } | undefined, previews: number): Promise<void> {
  const after = await snapshot(document);
  // The audit trail grew by the preview's own row(s), and by nothing else at all.
  expect(after.counts).toEqual({ ...before.counts, audit_event: (before.counts.audit_event ?? 0) + previews, previews: (before.counts.previews ?? 0) + previews });
  expect(after.sequences).toEqual(before.sequences);
  expect(after.series).toEqual(before.series);
  expect(after.layers).toBe(before.layers);
  expect(after.document).toEqual(before.document);
  // What a rehearsal does spend, like any transaction that is rolled back: the
  // surrogate id of a row that never was. Those, and nothing that is a number
  // anybody reads.
  const spent = Object.keys(after.counters).filter((name) => after.counters[name] !== before.counters[name]);
  expect(spent.filter((name) => !name.endsWith('_id_seq'))).toEqual([]);
}

const auditRows = async (action: string) =>
  (await ownerPool.query(`select actor_user_id, object_type, object_id, outcome::text as outcome, after_value from audit_event where action = $1 order by id`, [action])).rows as {
    actor_user_id: string;
    object_type: string;
    object_id: string;
    outcome: string;
    after_value: Record<string, unknown>;
  }[];

/** The journal lines a preview printed, as it printed them. */
const journalLinesIn = (text: string) =>
  text
    .split('\n')
    .filter((line) => /^ {2}(Dr|Cr) /.test(line))
    .map((line) => line.trim())
    .sort();

/** The stock movements a preview printed: "kind: ±quantity ITEM". */
const movementsIn = (text: string) =>
  text
    .split('\n')
    .filter((line) => /^ {2}[a-z ]+: [+−]/.test(line))
    .map((line) => line.trim().replace(/ · .*$/, '').replace(/ (into|out of) .*$/, ''))
    .sort();

/** The journal lines really written since a moment, in a preview's own form. */
async function journalLinesSince(entriesBefore: readonly string[]): Promise<string[]> {
  const { rows } = await ownerPool.query(
    `select case when l.debit_iqd > 0 then 'Dr' else 'Cr' end as side,
            (case when l.debit_iqd > 0 then l.debit_iqd else l.credit_iqd end)::text as amount,
            a.code, a.name, l.business_partner_code as partner, l.bank_account_code as bank, l.warehouse_code as warehouse
       from journal_line l join chart_of_account a on a.id = l.account_id
      where not (l.journal_entry_id::text = any($1))`,
    [entriesBefore],
  );
  return rows
    .map((line) => `${line.side} ${money(line.amount)} — ${line.code} · ${line.name}${[line.partner, line.bank, line.warehouse].filter(Boolean).map((part: string) => ` · ${part}`).join('')}`)
    .sort();
}

async function movementsSince(movementsBefore: readonly string[]): Promise<string[]> {
  const { rows } = await ownerPool.query(`select kind::text as kind, quantity::text as quantity, item_code from inventory_movement where not (id::text = any($1))`, [movementsBefore]);
  return rows
    .map((row) => `${String(row.kind).replace(/_/g, ' ')}: ${String(row.quantity).startsWith('-') ? '−' : '+'}${quantity(String(row.quantity).replace('-', ''))} ${row.item_code}`)
    .sort();
}

const idsOf = async (table: string) => (await ownerPool.query(`select id::text as id from ${table}`)).rows.map((row) => row.id as string);

/**
 * The opening journal's other side (§9.7): approval posts Dr inventory / Cr
 * opening balance, and the posting engine refuses a role nobody has mapped.
 */
async function mapOpeningBalance(): Promise<void> {
  const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = 'E000001'`);
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('E900001','Opening Balance Equity',$1,$2,false,true,'approved',1,'IQD') returning id`,
    [parents[0].account_type, parents[0].id],
  );
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('inventory.opening_stock','opening_balance',$1,true,$2) on conflict do nothing`,
    [rows[0].id, world.manager.principal.userId],
  );
  await withScope(scope(world.manager), (tx) => coa.setRequiredDimensions(tx, world.manager, rows[0].id, []));
}

beforeEach(async () => {
  world = await buildTradingWorld();
  await mapOpeningBalance();
  boss = await createUser('The Owner', { superUser: true });
  nobody = await createUser('A New Starter');
});

describe('a preview runs the step, reads what it wrote, and undoes it', () => {
  it('posting a purchase invoice: the journal and the stock are foretold, nothing is left behind, and the real posting then writes exactly that', async () => {
    const invoice = await purchaseInvoice();
    const at = { table: 'ap_invoice', id: invoice.id };
    const before = await snapshot(at);
    const journalsBefore = await idsOf('journal_entry');
    const movementsBefore = await idsOf('inventory_movement');

    const text = await previewOf(world.manager, 'document_step', { step: 'post', document: invoice.no.toLowerCase() });

    expect(text).toMatch(/^PREVIEW — nothing was changed\./);
    expect(text).toContain(`"post the document" on ${invoice.no}`);
    expect(text).toContain(`${invoice.no}: submitted → posted`);
    expect(text).toMatch(/on the document: .*total iqd: 0 → 100,000/);
    expect(text).toContain('JOURNAL it would write — a new journal entry, numbered when it really posts');
    expect(text).toMatch(/ {2}Dr 100,000 — A9\d{5} · Inventory/);
    expect(text).toMatch(/ {2}Cr 100,000 — L9\d{5} · Trade Payables · SUP-JINKO/);
    expect(text).toContain('totals: Dr 100,000 = Cr 100,000 IQD');
    expect(text).toContain('STOCK it would move');
    expect(text).toMatch(/ {2}goods receipt: \+10 ITM-PANEL · Solar Panel 550W into WH-MAIN/);
    expect(text).toMatch(/cost: it would open 1 FIFO cost layer\(s\) worth 100,000 IQD/);
    expect(text).toMatch(/notifications it would raise: \d+/);
    expect(text).toMatch(/What it would mean: .*the company would owe supplier SUP-JINKO 100,000 IQD more/);
    expect(text).toMatch(/10 of ITM-PANEL would come into WH-MAIN, making 10/);
    // The number a rehearsal was handed is nobody's number, and is never shown.
    expect(text).not.toMatch(/\b9\d{9}\b/);

    // Nothing is left: not a row, not the invoice, not a number from any series.
    await expectNothingLeft(before, at, 1);
    const [row] = await auditRows('whatsapp.preview');
    expect(row).toMatchObject({
      actor_user_id: world.manager.principal.userId,
      object_type: 'ap_invoice',
      object_id: invoice.id,
      outcome: 'success',
      after_value: { action: 'document_step', step: 'post', outcome: 'would_succeed', documentNo: invoice.no, rehearsal: true, wouldWrite: { journals: 1, movements: 1 } },
    });

    // Now for real — and it is what the preview said, line for line.
    const journalSeries = async () =>
      (await ownerPool.query(`select coalesce(max(serial), 0)::int as highest, count(*)::int as issued from doc_number_allocation where sequence_key = 'JOURNAL_ENTRY'`)).rows[0] as {
        highest: number;
        issued: number;
      };
    const was = await journalSeries();
    expect(await act(world.manager, 'document_step', { step: 'post', document: invoice.no })).toMatchObject({ ok: true });
    expect(await journalLinesSince(journalsBefore)).toEqual(journalLinesIn(text));
    expect(await movementsSince(movementsBefore)).toEqual(movementsIn(text));
    expect(journalLinesIn(text).length).toBeGreaterThanOrEqual(2);
    expect(movementsIn(text)).toEqual(['goods receipt: +10 ITM-PANEL']);
    // The journal took the very next number of its series: the rehearsal spent none.
    const now = await journalSeries();
    const written = (await idsOf('journal_entry')).length - journalsBefore.length;
    expect(written).toBeGreaterThan(0);
    expect(now.highest - was.highest).toBe(written);
    expect(now.issued - was.issued).toBe(written);
    expect((await ownerPool.query(`select status::text as status, total_iqd::text as total from ap_invoice where id = $1`, [invoice.id])).rows[0]).toMatchObject({ status: 'posted', total: '100000.0000' });
  });

  it('posting a sales invoice with stock: the cost of what leaves is foretold too, and matches', async () => {
    const stock = await openingStock('submitted');
    expect(await act(boss, 'approve_opening_stock', { document: stock.no })).toMatchObject({ ok: true });
    const invoice = await salesInvoice();
    const at = { table: 'ar_invoice', id: invoice.id };
    const before = await snapshot(at);
    const journalsBefore = await idsOf('journal_entry');
    const movementsBefore = await idsOf('inventory_movement');

    const text = await previewOf(boss, 'document_step', { step: 'post', document: invoice.no });
    expect(text).toMatch(/^PREVIEW — nothing was changed\./);
    expect(text).toContain(`${invoice.no}: approved → posted`);
    expect(text).toMatch(/ {2}Dr 975,000 — A9\d{5} · Trade Receivables · CUST-ALNOOR/);
    expect(text).toMatch(/ {2}delivery: −65 ITM-PANEL · Solar Panel 550W out of WH-MAIN/);
    expect(text).toMatch(/cost: it would take 65 from 1 FIFO cost layer\(s\) — 650,000 IQD at cost/);
    expect(text).toMatch(/customer CUST-ALNOOR would owe 975,000 IQD more/);
    expect(text).toMatch(/65 of ITM-PANEL would leave WH-MAIN, leaving 35/);
    await expectNothingLeft(before, at, 1);

    expect(await act(boss, 'document_step', { step: 'post', document: invoice.no })).toMatchObject({ ok: true });
    expect(await journalLinesSince(journalsBefore)).toEqual(journalLinesIn(text));
    expect(await movementsSince(movementsBefore)).toEqual(movementsIn(text));
  });

  it('posting a sales invoice with no stock: it would be REFUSED, in the service\'s own words, and nothing is left behind', async () => {
    const invoice = await salesInvoice();
    const at = { table: 'ar_invoice', id: invoice.id };
    const before = await snapshot(at);

    const text = await previewOf(boss, 'document_step', { step: 'post', document: invoice.no });
    expect(text).toMatch(/^PREVIEW — it would be REFUSED, and nothing was changed:\n/);
    await expectNothingLeft(before, at, 1);
    expect((await auditRows('whatsapp.preview'))[0]).toMatchObject({ object_type: 'ar_invoice', object_id: invoice.id, after_value: { outcome: 'would_be_refused', step: 'post' } });

    // The words are the service's: the real step is refused in the same ones.
    const real = await act(boss, 'document_step', { step: 'post', document: invoice.no });
    expect(real.ok).toBe(false);
    if (real.ok) throw new Error('posted with no stock');
    expect(real.reason).not.toMatch(/^Failed query/);
    expect(text).toContain(real.reason);
    expect((await ownerPool.query(`select status::text as status from ar_invoice where id = $1`, [invoice.id])).rows[0].status).toBe('approved');
  });

  it('a journal entry: its submission and its approval, each foretold and each undone', async () => {
    const code = async (id: string) => (await ownerPool.query(`select code from chart_of_account where id = $1`, [id])).rows[0].code as string;
    const expense = await code(world.accounts.expense!);
    const clearing = await code(world.accounts.return_clearing!);
    const drafted = await act(world.clerk, 'create_draft', {
      kind: 'journal_entry',
      date: '2026-09-15',
      description: 'Office rent, September',
      lines: [
        { account: expense, debit: '250,000', description: 'Rent' },
        { account: clearing, credit: '250000' },
      ],
    });
    if (!drafted.ok) throw new Error(drafted.reason);
    const entry = (await ownerPool.query(`select id::text as id, entry_no from journal_entry order by created_at desc limit 1`)).rows[0] as { id: string; entry_no: string };
    const at = { table: 'journal_entry', id: entry.id };

    // The clerk submits. Along the way the system asks whether they may
    // override a closed period — a right they do not hold, and one that is
    // only consulted: that is not a refusal, and the preview does not make it one.
    const first = await snapshot(at);
    const submitting = await previewOf(world.clerk, 'document_step', { step: 'submit', document: entry.entry_no });
    expect(submitting).toMatch(/^PREVIEW — nothing was changed\./);
    expect(submitting).toContain(`${entry.entry_no}: draft → submitted`);
    expect(submitting).toContain('JOURNAL: it would write none.');
    expect(submitting).toContain('STOCK: it would move none.');
    await expectNothingLeft(first, at, 1);
    expect(await act(world.clerk, 'document_step', { step: 'submit', document: entry.entry_no })).toMatchObject({ ok: true });

    // The manager approves: the journal that was waiting is the one that posts.
    const second = await snapshot(at);
    const approving = await previewOf(world.manager, 'document_step', { step: 'approve', document: entry.entry_no });
    expect(approving).toMatch(/^PREVIEW — nothing was changed\./);
    expect(approving).toContain(`${entry.entry_no}: submitted → posted`);
    expect(approving).toContain(`JOURNAL it would post — ${entry.entry_no} · Office rent, September · dated 2026-09-15 · posted`);
    expect(journalLinesIn(approving)).toEqual([`Cr 250,000 — ${clearing} · Return Clearing`, `Dr 250,000 — ${expense} · Service and Expense Cost`]);
    expect(approving).toContain('totals: Dr 250,000 = Cr 250,000 IQD');
    await expectNothingLeft(second, at, 1);

    // From the approval inbox the same journal cannot be named at all — chat
    // offers only what has a record page — so the preview says what a proposal would.
    expect(await previewOf(world.manager, 'approve_document', { document: entry.entry_no })).toMatch(/^PREVIEW — not run, and nothing was changed: JE-\S+ is not waiting for their decision/);
    await expectNothingLeft(second, at, 1);

    expect(await act(world.manager, 'document_step', { step: 'approve', document: entry.entry_no })).toMatchObject({ ok: true });
    expect((await ownerPool.query(`select status::text as status from journal_entry where id = $1`, [entry.id])).rows[0].status).toBe('posted');
  });

  it('what the database only checks when a transaction commits is checked in the rehearsal: a bank that would go below nothing', async () => {
    const code = async (id: string) => (await ownerPool.query(`select code from chart_of_account where id = $1`, [id])).rows[0].code as string;
    const drafted = await act(world.clerk, 'create_draft', {
      kind: 'journal_entry',
      date: '2026-09-15',
      description: 'Rent paid from the bank',
      lines: [
        { account: await code(world.accounts.expense!), debit: '250000' },
        { account: await code(world.accounts.bank!), credit: '250000' },
      ],
    });
    if (!drafted.ok) throw new Error(drafted.reason);
    const entry = (await ownerPool.query(`select id::text as id, entry_no from journal_entry order by created_at desc limit 1`)).rows[0] as { id: string; entry_no: string };
    expect(await act(world.clerk, 'document_step', { step: 'submit', document: entry.entry_no })).toMatchObject({ ok: true });
    const at = { table: 'journal_entry', id: entry.id };
    const before = await snapshot(at);

    // No service refuses this: the bank account holds nothing, and the rule
    // (C-20) is a trigger PostgreSQL runs at commit. A rehearsal never commits.
    const text = await previewOf(world.manager, 'document_step', { step: 'approve', document: entry.entry_no });
    expect(text).toMatch(/^PREVIEW — it would be REFUSED, and nothing was changed:\n.*cannot hold less than nothing/);
    await expectNothingLeft(before, at, 1);

    const real = await act(world.manager, 'document_step', { step: 'approve', document: entry.entry_no });
    if (real.ok) throw new Error('posted a bank below nothing');
    expect(real.reason).toMatch(/cannot hold less than nothing/);
    expect(real.reason).not.toMatch(/Failed query/);
    expect(text).toContain(real.reason);
    expect((await ownerPool.query(`select status::text as status from journal_entry where id = $1`, [entry.id])).rows[0].status).toBe('submitted');
  });

  it('reversing a posted purchase invoice: the mirror journal and the stock going back are foretold, and match', async () => {
    const invoice = await purchaseInvoice();
    expect(await act(world.manager, 'document_step', { step: 'post', document: invoice.no })).toMatchObject({ ok: true });
    const posted = (await ownerPool.query(`select entry_no from journal_entry order by created_at desc limit 1`)).rows[0].entry_no as string;
    const at = { table: 'ap_invoice', id: invoice.id };
    const before = await snapshot(at);
    const journalsBefore = await idsOf('journal_entry');
    const movementsBefore = await idsOf('inventory_movement');

    const text = await previewOf(world.manager, 'document_step', { step: 'reverse', document: invoice.no, reason: 'Posted to the wrong supplier' });
    expect(text).toMatch(/^PREVIEW — nothing was changed\./);
    expect(text).toContain(`${invoice.no}: posted → reversed`);
    expect(text).toContain('JOURNAL it would write — a new journal entry, numbered when it really posts');
    expect(text).toMatch(/ {2}Dr 100,000 — L9\d{5} · Trade Payables · SUP-JINKO/);
    expect(text).toMatch(/ {2}Cr 100,000 — A9\d{5} · Inventory/);
    expect(text).toContain(`journal ${posted}, already on the books, would be reversed`);
    expect(text).toMatch(/ {2}reversal: −10 ITM-PANEL · Solar Panel 550W out of WH-MAIN/);
    expect(text).toMatch(/the company would owe supplier SUP-JINKO 100,000 IQD less; 10 of ITM-PANEL would leave WH-MAIN, leaving 0/);
    expect(text).not.toMatch(/\b9\d{9}\b/);
    await expectNothingLeft(before, at, 1);

    expect(await act(world.manager, 'document_step', { step: 'reverse', document: invoice.no, reason: 'Posted to the wrong supplier' })).toMatchObject({ ok: true });
    expect(await journalLinesSince(journalsBefore)).toEqual(journalLinesIn(text));
    expect(await movementsSince(movementsBefore)).toEqual(movementsIn(text));
  });

  it('the other steps it is given for: opening stock to approve, and a prospect partner', async () => {
    // Opening stock.
    const stock = await openingStock('submitted');
    const stockAt = { table: 'opening_stock', id: stock.id };
    const first = await snapshot(stockAt);
    const opening = await previewOf(boss, 'approve_opening_stock', { document: stock.no });
    expect(opening).toMatch(/^PREVIEW — nothing was changed\./);
    expect(opening).toContain(`${stock.no}: submitted → approved`);
    expect(opening).toMatch(/ {2}opening stock: \+100 ITM-PANEL · Solar Panel 550W into WH-MAIN/);
    expect(opening).toMatch(/cost: it would open 1 FIFO cost layer\(s\) worth 1,000,000 IQD/);
    expect(opening).toMatch(/100 of ITM-PANEL would come into WH-MAIN, making 100/);
    // The opening journal is part of the approval, from chat as from the screen (§9.7).
    expect(opening).toMatch(/JOURNAL it would write/);
    expect(opening).toMatch(/Dr 1,000,000 — \S+ · Inventory/);
    expect(opening).toMatch(/Cr 1,000,000 — E900001 · Opening Balance Equity/);
    await expectNothingLeft(first, stockAt, 1);

    // And the real approval, from chat, raises that journal: the stock and the ledger move together.
    const approved = await act(boss, 'approve_opening_stock', { document: stock.no });
    expect(approved).toMatchObject({ ok: true });
    if (approved.ok) expect(approved.said).toMatch(/and the opening journal raised/);
    const { rows: journal } = await ownerPool.query(
      `select a.code, l.debit_iqd::text as debit, l.credit_iqd::text as credit
         from journal_entry j
         join journal_line l on l.journal_entry_id = j.id
         join chart_of_account a on a.id = l.account_id
        where j.source_doc_id = $1 and j.status = 'posted'
        order by l.debit_iqd desc`,
      [stock.id],
    );
    expect(journal.map((line) => [line.code === 'E900001' ? 'opening' : 'inventory', Number(line.debit), Number(line.credit)])).toEqual([
      ['inventory', 1_000_000, 0],
      ['opening', 0, 1_000_000],
    ]);

    // A prospect partner.
    const made = await act(world.clerk, 'create_partner', { role: 'supplier', name: 'Preview Supplier Co' });
    if (!made.ok) throw new Error(made.reason);
    const partner = (await ownerPool.query(`select id::text as id, code from business_partner where legal_name = 'Preview Supplier Co'`)).rows[0] as { id: string; code: string };
    const partnerAt = { table: 'business_partner', id: partner.id };
    const second = await snapshot(partnerAt);
    const approving = await previewOf(world.manager, 'approve_partner', { document: partner.code });
    expect(approving).toMatch(/^PREVIEW — nothing was changed\./);
    expect(approving).toContain(`${partner.code}: prospect → active`);
    expect(approving).toContain('JOURNAL: it would write none.');
    expect(approving).toContain('STOCK: it would move none.');
    await expectNothingLeft(second, partnerAt, 1);
    expect((await auditRows('whatsapp.preview')).at(-1)).toMatchObject({ object_type: 'business_partner', object_id: partner.id, after_value: { action: 'approve_partner', step: null, outcome: 'would_succeed' } });
  });

  it('is not given for what is not a step on a document that exists — and what cannot be proposed cannot be previewed', async () => {
    const before = await snapshot();
    for (const action of ['create_draft', 'create_partner', 'run_plan']) {
      expect(await previewOf(boss, action, { kind: 'journal_entry', role: 'customer', name: 'Somebody', steps: [] })).toMatch(
        /^PREVIEW — not available for this, and nothing was changed: a preview is of a step on a document that exists\./,
      );
    }
    expect(await previewOf(boss, 'document_step', { step: 'post', document: 'API-BGW-2026-999999' })).toMatch(
      /^PREVIEW — not run, and nothing was changed: There is no purchase invoice API-BGW-2026-999999/,
    );
    expect(await previewOf(boss, 'document_step', { step: 'reverse', document: 'API-BGW-2026-999999' })).toMatch(/wants a reason/);
    // Nothing ran, so there is nothing to record either.
    await expectNothingLeft(before, undefined, 0);
  });

  it('a right the person does not hold: REFUSED in the system\'s words — and not written down as an attempt they never made', async () => {
    const invoice = await purchaseInvoice('draft');
    const at = { table: 'ap_invoice', id: invoice.id };
    const before = await snapshot(at);

    const text = await previewOf(nobody, 'document_step', { step: 'submit', document: invoice.no });
    expect(text).toBe(["PREVIEW — it would be REFUSED, and nothing was changed:", "Permission denied: 'submit' on 'ap_invoice' is not granted to this user."].join('\n'));
    // One row, the preview's own. `authorize` records a refusal on a
    // connection of its own; a rehearsal stops before it does.
    await expectNothingLeft(before, at, 1);
    expect(await auditRows('authorisation.denied')).toHaveLength(0);
    expect((await auditRows('whatsapp.preview'))[0]).toMatchObject({ actor_user_id: nobody.principal.userId, after_value: { outcome: 'would_be_refused' } });

    // The step itself, for real, is refused the same way — and that attempt IS recorded, as it always was.
    const real = await act(nobody, 'document_step', { step: 'submit', document: invoice.no });
    expect(real).toMatchObject({ ok: false, reason: "Permission denied: 'submit' on 'ap_invoice' is not granted to this user." });
    expect(await auditRows('authorisation.denied')).toHaveLength(1);
  });
});

describe('a plan: several steps, one yes, one at a time', () => {
  it('bring in the stock and post the invoice — proposed as numbered steps, run in order, each with its own audit row', async () => {
    const stock = await openingStock('draft');
    const invoice = await salesInvoice();

    const plan = await propose(boss, 'run_plan', {
      steps: [
        { action: 'document_step', step: 'submit', document: stock.no },
        // Not possible yet — it is a draft until step 1 has run. That is what a plan is for.
        { action: 'approve_opening_stock', document: stock.no.toLowerCase() },
        { action: 'document_step', step: 'post', document: invoice.no },
      ],
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.pending).toMatchObject({ action: 'run_plan', chat: CHAT, userId: boss.principal.userId, target: { kind: 'opening_stock', id: stock.id, documentNo: stock.no } });
    expect(plan.pending.plan).toHaveLength(3);
    expect(plan.pending.plan?.map((step) => step.action)).toEqual(['document_step', 'approve_opening_stock', 'document_step']);
    const lines = plan.pending.sentence.split('\n');
    expect(lines[0]).toBe('a plan of 3 steps, in this order:');
    expect(lines[1]).toMatch(new RegExp(`^1\\. submit opening stock ${stock.no} · it is draft now, branch BGW · Submitting sends it for approval`));
    expect(lines[2]).toMatch(new RegExp(`^2\\. approve opening stock ${stock.no} · it is draft now, and has to be submitted by the time this step runs · Approving posts the quantities`));
    expect(lines[3]).toMatch(new RegExp(`^3\\. post sales invoice ${invoice.no} · it is approved now, branch BGW, 975,000 IQD · Posting writes its journal`));
    expect(lines[4]).toMatch(/one at a time, each in its own transaction.*one yes for all of them.*stops at the first step the system refuses.*STAY done: nothing is rolled back/);
    expect(actionLabel('run_plan')).toBe('run the plan');
    expect(ACTION_NAMES).toContain('run_plan');

    // Proposing changed nothing.
    expect((await ownerPool.query(`select status::text as status from opening_stock where id = $1`, [stock.id])).rows[0].status).toBe('draft');
    expect((await ownerPool.query(`select count(*)::int as n from inventory_movement`)).rows[0].n).toBe(0);

    const ran = await confirm(boss, plan.pending);
    if (!ran.ok) throw new Error(ran.reason);
    const report = ran.said.split('\n');
    expect(report[0]).toBe('The plan is done: all 3 steps ran.');
    expect(report[1]).toBe(`1. ✓ opening stock ${stock.no} submitted. It is submitted now.`);
    expect(report[2]).toMatch(new RegExp(`^2\\. ✓ ${stock.no} approved\\. 1 stock movement\\(s\\) posted`));
    expect(report[3]).toBe(`3. ✓ sales invoice ${invoice.no} posted. It is posted now.`);
    expect(report).toHaveLength(4);

    expect((await ownerPool.query(`select status::text as status from opening_stock where id = $1`, [stock.id])).rows[0].status).toBe('approved');
    expect((await ownerPool.query(`select status::text as status from ar_invoice where id = $1`, [invoice.id])).rows[0].status).toBe('posted');
    expect((await ownerPool.query(`select sum(quantity)::text as held from inventory_movement where item_code = $1`, [PANEL])).rows[0].held).toBe('35.000000');

    // Each step left its own row, in order, and says where in the plan it stood; the plan left one of its own.
    const steps = (
      await ownerPool.query(
        `select action, outcome::text as outcome, after_value ->> 'planStep' as part, after_value ->> 'step' as step from audit_event where action like 'whatsapp.action.%' and after_value ? 'planStep' order by id`,
      )
    ).rows;
    expect(steps).toEqual([
      { action: 'whatsapp.action.document_step', outcome: 'success', part: '1 of 3', step: 'submit' },
      { action: 'whatsapp.action.approve_opening_stock', outcome: 'success', part: '2 of 3', step: null },
      { action: 'whatsapp.action.document_step', outcome: 'success', part: '3 of 3', step: 'post' },
    ]);
    const [whole] = await auditRows('whatsapp.action.run_plan');
    expect(whole).toMatchObject({ outcome: 'success', object_type: 'opening_stock', object_id: stock.id, after_value: { what: 'run the plan', confirmed: true } });
    expect((whole?.after_value.plan as unknown[]).length).toBe(3);
  });

  it('stops at the first refusal: the step before it stays done, the step after it is not run', async () => {
    const bought = await purchaseInvoice('draft');
    const sold = await salesInvoice(); // 65 panels, and there is no stock at all

    const plan = await propose(boss, 'run_plan', {
      steps: [
        { action: 'document_step', step: 'submit', document: bought.no },
        { action: 'document_step', step: 'post', document: sold.no },
        { action: 'document_step', step: 'post', document: bought.no },
      ],
    });
    if (!plan.ok) throw new Error(plan.reason);

    const ran = await confirm(boss, plan.pending);
    expect(ran.ok).toBe(false);
    if (ran.ok) throw new Error('a plan with a refused step said it was done');
    const report = ran.reason.split('\n');
    expect(report[0]).toBe('The plan stopped at step 2 of 3: 1 done, 2 not.');
    expect(report[1]).toBe(`1. ✓ purchase invoice ${bought.no} submitted. It is submitted now.`);
    expect(report[2]).toMatch(/^2\. ✗ refused — \S/);
    expect(report[2]).not.toMatch(/Failed query/);
    expect(report[3]).toBe(`3. not run — post purchase invoice ${bought.no}`);
    expect(report[4]).toMatch(/marked ✓ are done and stay done — nothing was rolled back/);

    // Step 1 is committed and stays; step 2 changed nothing; step 3 never started.
    expect((await ownerPool.query(`select status::text as status from ap_invoice where id = $1`, [bought.id])).rows[0].status).toBe('submitted');
    expect((await ownerPool.query(`select status::text as status from ar_invoice where id = $1`, [sold.id])).rows[0].status).toBe('approved');
    expect((await ownerPool.query(`select count(*)::int as n from journal_entry`)).rows[0].n).toBe(0);

    const steps = (
      await ownerPool.query(`select outcome::text as outcome, after_value ->> 'planStep' as part, object_id from audit_event where action = 'whatsapp.action.document_step' order by id`)
    ).rows;
    expect(steps).toEqual([
      { outcome: 'success', part: '1 of 3', object_id: bought.id },
      { outcome: 'denied', part: '2 of 3', object_id: sold.id },
    ]);
    expect((await auditRows('whatsapp.action.run_plan'))[0]).toMatchObject({ outcome: 'denied' });
  });

  it('is not proposed when its first step cannot be done, or a later one never could', async () => {
    const bought = await purchaseInvoice('draft');
    const before = await snapshot();

    expect(
      await propose(boss, 'run_plan', {
        steps: [
          { action: 'document_step', step: 'submit', document: 'API-BGW-2026-999999' },
          { action: 'document_step', step: 'post', document: bought.no },
        ],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^Step 1 cannot be done as things stand, so there is no plan to propose: There is no purchase invoice API-BGW-2026-999999/) });

    // A later step is held only to what cannot change: a document that is not there, a step its kind has not got, a missing reason.
    expect(
      await propose(boss, 'run_plan', {
        steps: [
          { action: 'document_step', step: 'submit', document: bought.no },
          { action: 'document_step', step: 'post', document: 'API-BGW-2026-999999' },
        ],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^Step 2 could not run whatever the steps before it do.*There is no purchase invoice/) });
    expect(
      await propose(boss, 'run_plan', {
        steps: [
          { action: 'document_step', step: 'submit', document: bought.no },
          { action: 'document_step', step: 'reverse', document: bought.no },
        ],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^Step 2 could not run.*wants a reason/) });
    expect(
      await propose(boss, 'run_plan', {
        steps: [
          { action: 'document_step', step: 'submit', document: bought.no },
          { action: 'approve_opening_stock', document: 'OPN-BGW-2026-999999' },
        ],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^Step 2 could not run.*no opening stock document OPN-BGW-2026-999999/) });

    await expectNothingLeft(before, undefined, 0);
  });

  it('is two to five steps on documents that exist: no fewer, no more, no plan inside a plan, no draft', async () => {
    const bought = await purchaseInvoice('draft');
    const step = { action: 'document_step', step: 'submit', document: bought.no };

    expect(await propose(boss, 'run_plan', { steps: [step] })).toMatchObject({ ok: false, reason: expect.stringMatching(/A plan is 2 to 5 steps, and this is 1/) });
    expect(await propose(boss, 'run_plan', { steps: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/2 to 5 steps, and this is 0/) });
    expect(await propose(boss, 'run_plan', { steps: [step, step, step, step, step, step] })).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 5 steps, and this is 6/) });
    expect(await propose(boss, 'run_plan', {})).toMatchObject({ ok: false, reason: expect.stringMatching(/A plan is a list of steps/) });
    expect(await propose(boss, 'run_plan', { steps: 'submit it then post it' })).toMatchObject({ ok: false, reason: expect.stringMatching(/A plan is a list of steps/) });
    expect(await propose(boss, 'run_plan', { steps: [step, { action: 'run_plan', steps: [step, step] }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Step 2: a plan cannot hold another plan/),
    });
    expect(await propose(boss, 'run_plan', { steps: [step, { action: 'create_draft', kind: 'journal_entry', lines: [] }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Step 2: a draft is not part of a plan/),
    });
    expect(await propose(boss, 'run_plan', { steps: [step, { action: 'delete_everything' }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/Step 2: "delete_everything" is not something a plan can hold/) });

    // Five is a plan; and a step the model sent as text is read as the list it is.
    const five = await propose(boss, 'run_plan', { steps: JSON.stringify([step, step, step, step, step]) });
    expect(five).toMatchObject({ ok: true });
    expect((await ownerPool.query(`select status::text as status from ap_invoice where id = $1`, [bought.id])).rows[0].status).toBe('draft');
  });
});
