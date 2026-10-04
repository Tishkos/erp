/**
 * Notification centre (platform phase, Agent 6) — the service and the database.
 *
 *   NC1  a notification is written once: repeated, at the same instant, and by a
 *        rule and by emit for the same event; recurrence only as the kind's window says
 *   NC2  read and unread are stored per recipient and idempotent; mark-all is
 *        audited once, reading is not audited at all
 *   NC3  isolation: a person reads and changes only their own — a super user and
 *        an outsider included; what a notification says never changes
 *   NC4  a recipient is told only what they may open: no grant, wrong branch,
 *        inactive, cannot open the record
 *   NC5  the target is worked out for the reader, now: a link while they can open
 *        the record, "no longer available" — text withheld — once they cannot
 *   NC6  approvals: the approvers are asked, the submitter is told how it ended,
 *        a resubmission is a new ask, a recall settles the asks
 *   NC7  a failing notification never changes the act that caused it
 *   NC8  the sweeps say it once: period-close failures, a late container
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appPool, ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { businessToday, addBusinessDays } from '@/server/domain/business-date';
import { clearAddedKinds, registerKind } from '@/server/domain/notification-center';
import { registerAllRecords } from '@/server/records';
import * as authz from '@/server/services/authorization';
import * as chat from '@/server/services/chat';
import * as closing from '@/server/services/closing-checks';
import * as coa from '@/server/services/chart-of-accounts';
import * as center from '@/server/services/notification-center';
import * as notifications from '@/server/services/notifications';
import * as workflow from '@/server/services/workflow';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BGW = 'BGW';
const ERB = 'ERB';
const TODAY = businessToday();

interface Person extends ActorContext {
  readonly name: string;
  readonly id: string;
  readonly superUser: boolean;
}

async function person(name: string, roles: readonly string[], branch = BGW, superUser = false): Promise<Person> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [id, `${id}@example.com`, name, superUser]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, branch]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  return reload({ name, id, superUser, branchCode: branch } as Person);
}

/** The same person with their grants read again — after a role was changed. */
async function reload(p: Pick<Person, 'name' | 'id' | 'superUser' | 'branchCode'>): Promise<Person> {
  const principal = await withScope({ userId: p.id, branchCode: p.branchCode, isSuperUser: p.superUser }, (tx) => authz.loadPrincipal(tx, p.id));
  return { ...p, principal };
}

const run = <T>(p: Person, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: p.id, branchCode: p.branchCode, isSuperUser: p.superUser }, fn);

/** A raw connection as the application role, in one person's scope; always rolled back. */
async function asApp<T>(p: Pick<Person, 'id' | 'branchCode' | 'superUser'>, fn: (c: PoolClient) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true), set_config('app.branch_code', $2, true), set_config('app.is_super_user', $3, true)`, [
      p.id,
      p.branchCode,
      p.superUser ? 'true' : 'false',
    ]);
    for (const [key, value] of Object.entries(extra)) await c.query(`select set_config($1, $2, true)`, [key, value]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

async function refused(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await c.query('savepoint refusal');
  try {
    await c.query(text, params);
  } catch (error) {
    await c.query('rollback to savepoint refusal');
    return (error as Error).message;
  }
  await c.query('release savepoint refusal');
  throw new Error(`Expected the statement to be refused: ${text}`);
}

let alice: Person; // accounting officer
let bob: Person; // accounting manager
let carol: Person; // accounting officer
let dan: Person; // hr officer: no accounts payable grant
let eve: Person; // no role at all
let frank: Person; // ceo
let admin: Person; // super user
let gus: Person; // accounting officer, Erbil

const emitAs = (actor: Person, input: Partial<notifications.EmitInput> & { readonly recipients: notifications.EmitInput['recipients'] }) =>
  run(actor, (tx) =>
    notifications.emit(tx, {
      kind: 'ap_invoice.overdue',
      objectType: 'ap_invoice',
      objectId: 'INV-1',
      subject: 'Invoice INV-1 is overdue',
      context: { reference: 'INV-1', party: 'ACME', days_overdue: 3 },
      occurrence: TODAY,
      branchCode: BGW,
      ...input,
    }),
  );

const rowsOf = async (p: Person, state: 'all' | 'unread' = 'all') => (await run(p, (tx) => notifications.listFor(tx, p.id, { state }))).rows;
const unreadOf = (p: Person) => run(p, (tx) => notifications.unreadCountFor(tx, p.id));
const countAll = async (userId: string) => (await ownerPool.query(`select count(*)::int as n from notification where recipient_user_id = $1`, [userId])).rows[0].n as number;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BGW, 'Baghdad');
  await seedBranch(ERB, 'Erbil');
  registerAllRecords();
  alice = await person('Alice Aziz', ['accounting_officer']);
  bob = await person('Bob Barzani', ['accounting_manager']);
  carol = await person('Carol Chalabi', ['accounting_officer']);
  dan = await person('Dan Dulaimi', ['hr_officer']);
  eve = await person('Eve Outsider', []);
  frank = await person('Frank Faraj', ['ceo']);
  admin = await person('Ada Admin', [], BGW, true);
  gus = await person('Gus Gharib', ['accounting_officer'], ERB);
});

afterEach(() => clearAddedKinds());

// ---------------------------------------------------------------------------
describe('NC1 written once', () => {
  it('writes one row for a subject however often it is told', async () => {
    const first = await emitAs(alice, { recipients: [bob.id] });
    expect(first).toMatchObject({ created: 1, suppressed: 0, skipped: 0 });
    for (let i = 0; i < 3; i += 1) {
      expect(await emitAs(alice, { recipients: [bob.id] })).toMatchObject({ created: 0, suppressed: 1 });
    }
    expect(await countAll(bob.id)).toBe(1);
    const [row] = await rowsOf(bob);
    expect(row).toMatchObject({ kind: 'ap_invoice.overdue', objectType: 'ap_invoice', objectId: 'INV-1', category: 'invoices', readAt: null });
  });

  it('writes one row per person when the same event arrives at the same instant', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => emitAs(alice, { recipients: [bob.id, carol.id] })));
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(2);
    expect(results.reduce((n, r) => n + r.suppressed, 0)).toBe(14);
    expect(await countAll(bob.id)).toBe(1);
    expect(await countAll(carol.id)).toBe(1);
  });

  it('keeps one key for an event told by a rule and by emit, whichever comes first', async () => {
    const viaRule = await run(alice, (tx) =>
      notifications.raise(tx, { eventType: 'ap_invoice.overdue', objectType: 'ap_invoice', objectId: 'INV-1', occurrence: TODAY }, { reference: 'INV-1', party: 'ACME', days_overdue: 3 }, { branchCode: BGW }),
    );
    expect(viaRule.created).toBe(1); // bob holds the accounting_manager role the seeded rule names
    expect(await emitAs(alice, { recipients: [bob.id] })).toMatchObject({ created: 0, suppressed: 1 });
    expect(await countAll(bob.id)).toBe(1);

    await emitAs(alice, { recipients: [carol.id], objectId: 'INV-2' });
    const second = await run(alice, (tx) =>
      notifications.raise(tx, { eventType: 'ap_invoice.overdue', objectType: 'ap_invoice', objectId: 'INV-2', occurrence: TODAY }, { reference: 'INV-2' }, { branchCode: BGW }),
    );
    // Bob was not yet told of INV-2; carol was, and the rule does not name her role.
    expect(second.created).toBe(1);
    expect(await countAll(carol.id)).toBe(1);
  });

  it('tells again only as the kind says: a new day, a new occurrence, never a repeat of a once-kind', async () => {
    await emitAs(alice, { recipients: [bob.id], occurrence: '2026-10-04' });
    expect(await emitAs(alice, { recipients: [bob.id], occurrence: '2026-10-04' })).toMatchObject({ created: 0 });
    expect(await emitAs(alice, { recipients: [bob.id], occurrence: '2026-10-05' })).toMatchObject({ created: 1 });
    expect(await countAll(bob.id)).toBe(2);

    // A `day` kind with no occurrence named is told once per business day.
    await emitAs(alice, { recipients: [carol.id], occurrence: undefined, objectId: 'INV-9' });
    expect(await emitAs(alice, { recipients: [carol.id], occurrence: undefined, objectId: 'INV-9' })).toMatchObject({ created: 0, suppressed: 1 });

    // A `once` kind is told once whatever the day.
    const paid = { kind: 'supplier_payment.made', objectType: 'supplier_payment', objectId: 'PAY-1', subject: 'Payment PAY-1', occurrence: undefined } as const;
    expect(await emitAs(alice, { recipients: [bob.id], ...paid })).toMatchObject({ created: 1 });
    expect(await emitAs(alice, { recipients: [bob.id], ...paid })).toMatchObject({ created: 0, suppressed: 1 });
  });

  it('refuses an occurrence kind with no occurrence, rather than drop its second event as a repeat', async () => {
    const message = await rejection(emitAs(alice, { recipients: [bob.id], kind: 'approval.required', objectType: 'chart_of_account', objectId: 'x', occurrence: null }));
    expect(message).toMatch(/occurrence/);
    expect(await countAll(bob.id)).toBe(0);
  });

  it('takes a kind added at run time and lists it under the category it names', async () => {
    registerKind('automation.rule_fired', { category: 'tasks', window: 'occurrence' });
    await emitAs(alice, { recipients: [bob.id], kind: 'automation.rule_fired', objectType: 'automation_rule', objectId: 'R-1', subject: 'Rule R-1 fired' });
    const tasks = await run(bob, (tx) => notifications.listFor(tx, bob.id, { category: 'tasks' }));
    expect(tasks.rows.map((r) => r.kind)).toEqual(['automation.rule_fired']);
    const invoices = await run(bob, (tx) => notifications.listFor(tx, bob.id, { category: 'invoices' }));
    expect(invoices.rows).toEqual([]);
  });

  it('does not tell the same person twice in one call, nor the ones named as except', async () => {
    const result = await emitAs(alice, { recipients: [bob.id, bob.id, carol.id, null, undefined], except: [carol.id] });
    expect(result.created).toBe(1);
    expect(await countAll(carol.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('NC2 read state', () => {
  it('is stored per recipient, both ways, and is idempotent', async () => {
    await emitAs(alice, { recipients: [bob.id, carol.id] });
    const [mine] = await rowsOf(bob);
    const id = BigInt(mine!.id);
    expect(await unreadOf(bob)).toBe(1);

    expect(await run(bob, (tx) => notifications.markRead(tx, id, bob.id))).toBe(1);
    expect(await run(bob, (tx) => notifications.markRead(tx, id, bob.id))).toBe(0);
    expect(await unreadOf(bob)).toBe(0);
    // Stored: a new transaction, a new session, sees the same.
    expect((await rowsOf(bob))[0]!.readAt).not.toBeNull();
    expect(await rowsOf(bob, 'unread')).toEqual([]);

    expect(await run(bob, (tx) => notifications.markUnread(tx, id, bob.id))).toBe(1);
    expect(await run(bob, (tx) => notifications.markUnread(tx, id, bob.id))).toBe(0);
    expect(await unreadOf(bob)).toBe(1);

    // Carol's copy is her own: Bob's marks never touched it.
    expect(await unreadOf(carol)).toBe(1);
  });

  it('cannot be marked by somebody else, however the id was got', async () => {
    await emitAs(alice, { recipients: [bob.id] });
    const [row] = await rowsOf(bob);
    const id = BigInt(row!.id);
    expect(await run(carol, (tx) => notifications.markRead(tx, id, carol.id))).toBe(0);
    expect(await run(carol, (tx) => notifications.markRead(tx, id, bob.id))).toBe(0);
    expect(await run(admin, (tx) => notifications.markRead(tx, id, bob.id))).toBe(0);
    expect(await unreadOf(bob)).toBe(1);
  });

  it('counts per category and marks one category or all', async () => {
    await emitAs(alice, { recipients: [bob.id], objectId: 'INV-1' });
    await emitAs(alice, { recipients: [bob.id], objectId: 'INV-2' });
    await emitAs(alice, { recipients: [bob.id], kind: 'supplier_payment.made', objectType: 'supplier_payment', objectId: 'PAY-1', subject: 'Payment PAY-1', occurrence: undefined });
    const counts = await run(bob, (tx) => notifications.countsFor(tx, bob.id));
    expect(counts).toMatchObject({ unread: 3, total: 3 });
    expect(counts.categories.find((c) => c.category === 'invoices')).toMatchObject({ unread: 2, total: 2 });
    expect(counts.categories.find((c) => c.category === 'payments')).toMatchObject({ unread: 1, total: 1 });

    expect(await run(bob, (tx) => center.markAllReadAudited(tx, bob, { category: 'payments' }))).toBe(1);
    expect(await unreadOf(bob)).toBe(2);
    expect(await run(bob, (tx) => center.markAllReadAudited(tx, bob))).toBe(2);
    expect(await unreadOf(bob)).toBe(0);
    expect(await run(bob, (tx) => center.markAllReadAudited(tx, bob))).toBe(0);
  });

  it('audits marking all read once, with its count — and nothing for reading, un-reading or opening', async () => {
    for (const n of [1, 2, 3, 4]) await emitAs(alice, { recipients: [bob.id], objectId: `INV-${n}` });
    const rows = await rowsOf(bob);
    await run(bob, (tx) => notifications.markRead(tx, BigInt(rows[0]!.id), bob.id));
    await run(bob, (tx) => notifications.markUnread(tx, BigInt(rows[0]!.id), bob.id));
    await run(bob, (tx) => center.open(tx, bob, BigInt(rows[1]!.id)));
    const before = await ownerPool.query(`select count(*)::int as n from audit_event where action like 'notification.%'`);
    expect(before.rows[0].n).toBe(0);

    await run(bob, (tx) => center.markAllReadAudited(tx, bob));
    await run(bob, (tx) => center.markAllReadAudited(tx, bob)); // nothing left: no second row
    const { rows: audit } = await ownerPool.query(`select action, actor_user_id, object_id, after_value from audit_event where action like 'notification.%'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'notification.marked_all_read', actor_user_id: bob.id, object_id: bob.id });
    expect(audit[0].after_value).toMatchObject({ count: 4, category: 'all' });
  });

  it('lists newest first with a true count and fifty to a page', async () => {
    for (let n = 1; n <= 53; n += 1) await emitAs(alice, { recipients: [bob.id], objectId: `INV-${n}` });
    const first = await run(bob, (tx) => notifications.listFor(tx, bob.id, { state: 'all', page: 1, pageSize: 50 }));
    expect(first.total).toBe(53);
    expect(first.pages).toBe(2);
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]!.objectId).toBe('INV-53');
    const second = await run(bob, (tx) => notifications.listFor(tx, bob.id, { state: 'all', page: 2, pageSize: 50 }));
    expect(second.rows.map((r) => r.objectId)).toEqual(['INV-3', 'INV-2', 'INV-1']);

    const found = await run(bob, (tx) => notifications.listFor(tx, bob.id, { state: 'all', q: 'inv-17' }));
    expect(found.rows.map((r) => r.objectId)).toEqual(['INV-17']);
    // A search is a phrase, not a pattern.
    const wild = await run(bob, (tx) => notifications.listFor(tx, bob.id, { state: 'all', q: '%' }));
    expect(wild.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('NC3 isolation', () => {
  beforeEach(async () => {
    await emitAs(alice, { recipients: [bob.id, carol.id, frank.id], subject: 'Invoice INV-1 is overdue: ACME owes 1,200,000' });
  });

  it('shows each person their own and nobody else’s — a super user and an outsider included', async () => {
    for (const [who, expected] of [[bob, 1], [carol, 1], [frank, 1], [alice, 0], [dan, 0], [eve, 0], [admin, 0]] as const) {
      const n = await asApp(who, async (c) => (await c.query(`select count(*)::int as n from notification`)).rows[0].n as number);
      expect(n, who.name).toBe(expected);
    }
    // By name, by id and by recipient: still nothing of Bob's for the others.
    for (const who of [eve, admin, carol]) {
      const seen = await asApp(who, async (c) => (await c.query(`select id from notification where recipient_user_id = $1`, [bob.id])).rows);
      expect(seen, who.name).toEqual([]);
    }
  });

  it('lets nobody change, mark or remove anybody else’s', async () => {
    for (const who of [eve, admin, carol]) {
      await asApp(who, async (c) => {
        const changed = await c.query(`update notification set read_at = now() where recipient_user_id = $1`, [bob.id]);
        expect(changed.rowCount, who.name).toBe(0);
        const wiped = await c.query(`delete from notification where recipient_user_id = $1`, [bob.id]).catch(() => ({ rowCount: 0 }));
        expect(wiped.rowCount, who.name).toBe(0);
      });
    }
    expect(await unreadOf(bob)).toBe(1);
  });

  it('is read in full only by a scheduled job that says so (a system sweep)', async () => {
    const n = await asApp(admin, async (c) => (await c.query(`select count(*)::int as n from notification`)).rows[0].n as number, { 'app.system_sweep': 'on' });
    expect(n).toBe(3);
  });

  it('fixes what a notification says: only its read mark moves, and the acted and escalated marks only forward', async () => {
    await asApp(bob, async (c) => {
      expect(await refused(c, `update notification set subject = 'changed' where recipient_user_id = $1`, [bob.id])).toMatch(/not edited/);
      expect(await refused(c, `update notification set body = 'changed' where recipient_user_id = $1`, [bob.id])).toMatch(/not edited/);
      expect(await refused(c, `update notification set recipient_user_id = $2 where recipient_user_id = $1`, [bob.id, carol.id])).toMatch(/not edited|row-level/i);
      expect(await refused(c, `update notification set dedupe_key = 'x' where recipient_user_id = $1`, [bob.id])).toMatch(/cannot be changed/);
      expect(await refused(c, `update notification set created_at = now() - interval '9 days' where recipient_user_id = $1`, [bob.id])).toMatch(/not edited/);
      const marked = await c.query(`update notification set read_at = now(), acted_at = now() where recipient_user_id = $1`, [bob.id]);
      expect(marked.rowCount).toBe(1);
      expect(await refused(c, `update notification set acted_at = null where recipient_user_id = $1`, [bob.id])).toMatch(/acted upon/);
      const unread = await c.query(`update notification set read_at = null where recipient_user_id = $1`, [bob.id]);
      expect(unread.rowCount).toBe(1);
    });
  });

  it('answers the list, the count and the click with nothing for a notification that is not theirs', async () => {
    const [mine] = await rowsOf(bob);
    expect(await run(eve, (tx) => notifications.listFor(tx, eve.id, { state: 'all' }))).toMatchObject({ total: 0, rows: [] });
    expect(await run(eve, (tx) => notifications.findFor(tx, eve.id, BigInt(mine!.id)))).toBeNull();
    // Even the super user, naming Bob’s id and Bob’s user: a missing notification.
    expect(await run(admin, (tx) => notifications.findFor(tx, admin.id, BigInt(mine!.id)))).toBeNull();
    expect(await run(admin, (tx) => notifications.findFor(tx, bob.id, BigInt(mine!.id)))).toBeNull();
    expect(await run(admin, (tx) => center.open(tx, admin, BigInt(mine!.id)))).toEqual({ status: 'missing' });
    expect(await run(eve, (tx) => center.open(tx, eve, BigInt(mine!.id)))).toEqual({ status: 'missing' });
  });
});

// ---------------------------------------------------------------------------
describe('NC4 the recipient may be told', () => {
  it('skips a person without the grant of the kind’s object, in another branch, or inactive — and counts them skipped', async () => {
    await ownerPool.query(`update app_user set is_active = false where id = $1`, [carol.id]);
    const result = await emitAs(alice, { recipients: [bob.id, dan.id, eve.id, gus.id, carol.id, admin.id] });
    // Bob (grant, branch) and the super user are told; Dan lacks ap_invoice, Eve any role, Gus the branch, Carol is inactive.
    expect(result).toMatchObject({ created: 2, skipped: 4, suppressed: 0 });
    expect(await countAll(bob.id)).toBe(1);
    expect(await countAll(admin.id)).toBe(1);
    for (const left of [dan, eve, gus, carol]) expect(await countAll(left.id), left.name).toBe(0);
  });

  it('applies the same filter to the rule path', async () => {
    await ownerPool.query(`update user_role set role_code = 'accounting_manager' where user_id = $1`, [dan.id]);
    // Dan now holds the role the rule names, but his branch is not the event’s.
    await ownerPool.query(`delete from user_branch_scope where user_id = $1`, [dan.id]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [dan.id, ERB]);
    const result = await run(alice, (tx) =>
      notifications.raise(tx, { eventType: 'ap_invoice.overdue', objectType: 'ap_invoice', objectId: 'INV-5', occurrence: TODAY }, { reference: 'INV-5' }, { branchCode: BGW }),
    );
    expect(result.created).toBe(1);
    expect(await countAll(bob.id)).toBe(1);
    expect(await countAll(dan.id)).toBe(0);
  });

  it('can ask whether the person can open the record itself, as them', async () => {
    const group = await run(bob, (tx) => chat.createGroup(tx, bob, { title: 'Finance', memberIds: [alice.id] }));
    const told = await emitAs(bob, {
      recipients: [alice.id, carol.id],
      kind: 'document.linked',
      objectType: 'chat_conversation',
      objectId: group.conversationId,
      subject: 'A file was linked',
      occurrence: 'link-1',
      recordAccess: true,
    });
    // Alice is in the conversation; Carol holds the chat grant but is not in it.
    expect(told).toMatchObject({ created: 1, skipped: 1 });
    expect(await countAll(alice.id)).toBe(1);
    expect(await countAll(carol.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('NC5 the target, for this reader, now', () => {
  async function conversationWithNotice() {
    const group = await run(bob, (tx) => chat.createGroup(tx, bob, { title: 'Finance team', memberIds: [alice.id, carol.id] }));
    await run(bob, (tx) => chat.sendMessage(tx, bob, { conversationId: group.conversationId, body: 'Please review the March close' }));
    return group.conversationId;
  }

  it('leads to the record while the reader can open it, and marks it read only then', async () => {
    const conversationId = await conversationWithNotice();
    const feed = await run(alice, (tx) => center.feedFor(tx, alice, { state: 'all' }));
    expect(feed.unread).toBe(1);
    expect(feed.items[0]).toMatchObject({ kind: 'chat.message', category: 'chat', openable: true, reason: null, read: false, userText: true });
    expect(feed.items[0]!.body).toBe('Please review the March close');

    const opened = await run(alice, (tx) => center.open(tx, alice, BigInt(feed.items[0]!.id)));
    expect(opened).toEqual({ status: 'ok', href: `/chat?c=${conversationId}` });
    expect(await unreadOf(alice)).toBe(0);
  });

  it('answers "no longer available" — and withholds the text — once the reader lost the record', async () => {
    const conversationId = await conversationWithNotice();
    await run(bob, (tx) => chat.removeMember(tx, bob, conversationId, alice.id));

    const feed = await run(alice, (tx) => center.feedFor(tx, alice, { state: 'all' }));
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ openable: false, reason: 'not_found', subject: '', body: '' });
    expect(JSON.stringify(feed)).not.toMatch(/March close|Finance team/);

    const opened = await run(alice, (tx) => center.open(tx, alice, BigInt(feed.items[0]!.id)));
    expect(opened).toEqual({ status: 'unavailable', reason: 'not_found' });
    // A refused click is not a read.
    expect(await unreadOf(alice)).toBe(1);

    // Carol is still in it: hers works.
    const hers = await run(carol, (tx) => center.feedFor(tx, carol, { state: 'all' }));
    expect(hers.items[0]).toMatchObject({ openable: true });
  });

  it('answers "no longer available" once the grant behind the record is taken away', async () => {
    await ownerPool.query(`insert into role (code, name) values ('nc_chat', 'Notification test chat')`);
    await ownerPool.query(`insert into role_grant (role_code, object, verb) values ('nc_chat','chat','view'), ('nc_chat','chat','create'), ('nc_chat','notification','view')`);
    const henry = await person('Henry Hamid', ['nc_chat']);
    const group = await run(bob, (tx) => chat.createGroup(tx, bob, { title: 'Wider', memberIds: [henry.id] }));
    await run(bob, (tx) => chat.sendMessage(tx, bob, { conversationId: group.conversationId, body: 'Numbers attached' }));

    const before = await run(henry, (tx) => center.feedFor(tx, henry, { state: 'all' }));
    expect(before.items[0]).toMatchObject({ openable: true });

    await ownerPool.query(`delete from role_grant where role_code = 'nc_chat' and object = 'chat'`);
    const after = await reload(henry);
    const feed = await run(after, (tx) => center.feedFor(tx, after, { state: 'all' }));
    expect(feed.items[0]).toMatchObject({ openable: false, reason: 'no_access', subject: '', body: '' });
    expect(await run(after, (tx) => center.open(tx, after, BigInt(feed.items[0]!.id)))).toEqual({ status: 'unavailable', reason: 'no_access' });
  });

  it('never follows an address that leaves the site, or one the reader’s screen grant does not cover', async () => {
    const mk = (extra: Record<string, unknown>) =>
      emitAs(alice, { recipients: [bob.id], kind: 'hr.leave_lapsing', objectType: 'something_else', objectId: `o-${Object.values(extra)[0]}`, subject: 'x', occurrence: String(Object.values(extra)[0]), context: extra });
    await mk({ href: 'https://evil.example/x' });
    await mk({ href: '//evil.example' });
    await mk({ href: '/administration/users' }); // a screen bob’s role cannot view
    await mk({ href: '/approvals' });
    const feed = await run(bob, (tx) => center.feedFor(tx, bob, { state: 'all' }));
    const byHref = new Map(feed.items.map((item, index) => [index, item]));
    const reasons = [...byHref.values()].map((i) => `${i.openable}:${i.reason}`).sort();
    expect(reasons).toEqual(['false:no_access', 'false:no_target', 'false:no_target', 'true:null'].sort());
  });
});

// ---------------------------------------------------------------------------
describe('NC6 approvals', () => {
  let rootId: string;

  beforeEach(async () => {
    const { rows } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
    rootId = rows[0].id as string;
  });

  const raise = (officer: Person, name = 'Petty Cash NC') =>
    run(officer, (tx) => coa.createAccount(tx, officer, { name, parentId: rootId, currencyRestriction: 'IQD' }));

  it('asks the approvers, never the submitter; tells the submitter how it ended, never the decider', async () => {
    const account = await raise(alice);
    await run(alice, (tx) => coa.submitForApproval(tx, alice, account.id));

    const asked = await rowsOf(bob);
    expect(asked.map((r) => [r.kind, r.objectType, r.objectId, r.category])).toEqual([['approval.required', 'chart_of_account', account.id, 'approvals']]);
    expect(await countAll(alice.id)).toBe(0);
    expect(await countAll(carol.id)).toBe(0);

    // The ask is a link to the account for Bob, and Alice sees nothing yet.
    const feed = await run(bob, (tx) => center.feedFor(tx, bob, { state: 'all' }));
    expect(feed.items[0]).toMatchObject({ openable: true, kind: 'approval.required' });
    expect(feed.items[0]!.params.ref).toMatch(/^[A-Z]\d+$/);
    const opened = await run(bob, (tx) => center.open(tx, bob, BigInt(feed.items[0]!.id)));
    expect(opened).toMatchObject({ status: 'ok' });
    expect((opened as { href: string }).href).toMatch(/^\/master-data\/chart-of-accounts\//);

    await run(bob, (tx) => coa.approve(tx, bob, account.id));
    const told = await rowsOf(alice);
    expect(told.map((r) => r.kind)).toEqual(['approval.completed']);
    expect(await countAll(bob.id)).toBe(1); // the ask only: Bob decided, Bob is not told
    // The ask is settled: acted upon.
    expect((await rowsOf(bob))[0]!.actedAt).not.toBeNull();
  });

  it('tells the submitter of a rejection with its reason, and a resubmission is a new ask', async () => {
    const account = await raise(alice);
    await run(alice, (tx) => coa.submitForApproval(tx, alice, account.id));
    await run(bob, (tx) => coa.reject(tx, bob, account.id, 'Wrong parent group'));

    const rejected = await rowsOf(alice);
    expect(rejected.map((r) => r.kind)).toEqual(['approval.rejected']);
    expect(rejected[0]!.body).toBe('Wrong parent group');
    expect((rejected[0]!.context as { reason: string }).reason).toBe('Wrong parent group');

    await run(alice, (tx) => coa.returnToDraft(tx, alice, account.id));
    await run(alice, (tx) => coa.submitForApproval(tx, alice, account.id));
    const asks = (await rowsOf(bob)).filter((r) => r.kind === 'approval.required');
    expect(asks).toHaveLength(2);
    expect(asks.filter((r) => r.actedAt === null)).toHaveLength(1); // the first was settled by the rejection
  });

  it('settles the asks when the submitter recalls', async () => {
    const account = await raise(alice);
    await run(alice, (tx) => coa.submitForApproval(tx, alice, account.id));
    expect((await rowsOf(bob))[0]!.actedAt).toBeNull();
    await run(alice, (tx) =>
      workflow.recall(tx, 'chart_of_account', account.id, { userId: alice.id, roles: alice.principal.roleCodes, isDepartmentManager: false }, 'Raised by mistake'),
    );
    expect((await rowsOf(bob))[0]!.actedAt).not.toBeNull();
    expect(await countAll(alice.id)).toBe(0);
  });

  it('writes one ask for one submission however the engine is driven', async () => {
    const account = await raise(alice);
    await run(alice, (tx) => coa.submitForApproval(tx, alice, account.id));
    // The same revision and step, told again (a retry): no second ask.
    const again = await run(alice, (tx) =>
      notifications.emit(tx, {
        kind: 'approval.required',
        objectType: 'chart_of_account',
        objectId: account.id,
        recipients: [bob.id],
        subject: 'Approval required',
        occurrence: '1:1',
      }),
    );
    expect(again).toMatchObject({ created: 0, suppressed: 1 });
    expect(await countAll(bob.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('NC7 a notification never changes the act', () => {
  it('leaves the approval standing when the notification step fails, and says so in the log', async () => {
    const { rows } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
    const account = await run(alice, (tx) => coa.createAccount(tx, alice, { name: 'Safe NC', parentId: rows[0].id, currencyRestriction: 'IQD' }));
    // A trigger that makes every notification insert fail.
    await ownerPool.query(`create or replace function nc_fail() returns trigger language plpgsql as $$ begin raise exception 'notifications are down'; end $$`);
    await ownerPool.query(`create trigger nc_fail before insert on notification for each row execute function nc_fail()`);
    try {
      await run(alice, (tx) => coa.submitForApproval(tx, alice, account.id));
      const { rows: status } = await ownerPool.query(`select approval_status from chart_of_account where id = $1`, [account.id]);
      expect(status[0].approval_status).toBe('submitted');
      const { rows: instances } = await ownerPool.query(`select count(*)::int as n from workflow_instance where document_id = $1`, [account.id]);
      expect(instances[0].n).toBe(1);
      expect(await countAll(bob.id)).toBe(0);
      // And the rest of the act still works.
      await run(bob, (tx) => coa.approve(tx, bob, account.id));
      const { rows: done } = await ownerPool.query(`select approval_status from chart_of_account where id = $1`, [account.id]);
      expect(done[0].approval_status).toBe('approved');
    } finally {
      await ownerPool.query(`drop trigger if exists nc_fail on notification`);
      await ownerPool.query(`drop function if exists nc_fail()`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('NC8 the sweeps say it once', () => {
  const report = (id: string) =>
    ({
      mayClose: false,
      period: { id, name: 'September 2026' },
      checks: [
        { code: 'journals_posted', state: 'fail', figure: '2', detail: ['JE-1', 'JE-2'] },
        { code: 'bank_reconciled', state: 'pass', figure: '0', detail: [] },
      ],
    }) as unknown as Parameters<typeof closing.notifyFailures>[1];

  it('tells the accounting managers and super users of a blocked close once a day, and again for a new failure', async () => {
    const period = randomUUID();
    const first = await run(admin, (tx) => closing.notifyFailures(tx, report(period), TODAY));
    expect(first.notified).toBe(2); // Bob (accounting_manager) and Ada (super user)
    const again = await run(admin, (tx) => closing.notifyFailures(tx, report(period), TODAY));
    expect(again.notified).toBe(0);
    const tomorrow = await run(admin, (tx) => closing.notifyFailures(tx, report(period), addBusinessDays(TODAY, 1)));
    expect(tomorrow.notified).toBe(2);

    const mine = await rowsOf(bob);
    expect(mine.map((r) => [r.kind, r.category])).toEqual([['fiscal_period.close_blocked', 'accounting'], ['fiscal_period.close_blocked', 'accounting']]);
    // A super user reads their own too, and not Bob's.
    expect((await rowsOf(admin)).length).toBe(2);
    expect(await rowsOf(carol)).toEqual([]);
  });

  it('tells a late container once per ETA to the shipment desk of its branch and the person who raised the import', async () => {
    const container = await lateContainer();
    expect(await container.sweep('2026-10-12')).toBe(1);
    const told = await ownerPool.query(`select recipient_user_id, event_type, dedupe_key from notification where event_type = 'container.late' order by recipient_user_id`);
    expect(told.rows.length).toBeGreaterThanOrEqual(1);
    expect(told.rows.map((r) => r.recipient_user_id)).toContain(container.clerkId);
    const first = told.rows.length;

    // Seen again, same ETA: late once more would be a repeat.
    await ownerPool.query(`update shipment_container set status_code = 'on_sea' where id = $1`, [container.containerId]);
    await container.sweep('2026-10-13');
    expect((await ownerPool.query(`select count(*)::int as n from notification where event_type = 'container.late'`)).rows[0].n).toBe(first);

    // A new ETA that passes too is a new event.
    await ownerPool.query(`update shipment_container set status_code = 'on_sea', eta = '2026-10-20' where id = $1`, [container.containerId]);
    await container.sweep('2026-10-21');
    expect((await ownerPool.query(`select count(*)::int as n from notification where event_type = 'container.late'`)).rows[0].n).toBe(first * 2);
  });
});

/** A container whose ETA has passed, on a real import with a B/L (the AP05 fixture, trimmed). */
async function lateContainer() {
  const [{ buildTradingWorld, BAGHDAD, PANEL, WAREHOUSE, scope }, ap, shipments, { parseDecimal }, { parseQuantity }] = await Promise.all([
    import('./trading-fixture'),
    import('@/server/services/ap-invoice'),
    import('@/server/services/shipments'),
    import('@/server/domain/money'),
    import('@/server/domain/uom'),
  ]);
  const world = await buildTradingWorld();
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage) values ('WH-NC-INPROC','In Process',$1,'transit',true,'in_process')`,
    [BAGHDAD],
  );
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'CSA-NC-0001',
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: parseQuantity('10'), unitPriceIqd: parseDecimal('10000', 4n), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
    }),
  );
  const { rows } = await ownerPool.query(`select p.id from payable p join ap_invoice i on i.payable_id = p.id where i.id = $1`, [made.id]);
  const payableId = rows[0].id as string;
  await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: 'MEDUNC804404',
      blDate: '2026-09-20',
      vessel: 'MSC Aurora',
      eta: '2026-10-05',
      portOfDischargeCode: 'PRT-0001',
      containers: 'MSCU1234566',
      sizeType: '40HC',
      spreadLines: true,
    }),
  );
  const { rows: found } = await ownerPool.query(`select id from shipment_container where payable_id = $1`, [payableId]);
  const superScope = { userId: world.manager.principal.userId, branchCode: BAGHDAD, isSuperUser: true };
  return {
    containerId: found[0].id as string,
    clerkId: world.clerk.principal.userId,
    sweep: (asOf: string) => withScope(superScope, (tx) => shipments.lateSweep(tx, asOf)),
  };
}
