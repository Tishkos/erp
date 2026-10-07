/**
 * The status a person chooses, and the chat windows' poll (2026-10-06, 0410) —
 * the service and the database.
 *
 *   PS1  the choice is kept, `busy` follows it, the poll hands it back
 *   PS2  what colleagues see: Busy, Away, and Appear offline (no "last seen")
 *   PS3  the people search wears the dot for the people one talks to, and only them
 *   PS4  nobody writes another's status; an unknown one is refused twice over
 *   PS5  the docked windows: each moved one comes back in the same poll; one no longer theirs is closed
 *
 * Runs on its own database (`DATABASE_URL_TEST`, e.g. erp_test_chat).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { appPool, ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as authz from '@/server/services/authorization';
import * as chat from '@/server/services/chat';
import * as read from '@/server/services/chat-read';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BGW = 'BGW';

interface Person extends ActorContext {
  readonly name: string;
  readonly id: string;
}

async function person(name: string, role: string): Promise<Person> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,false)`, [id, `${id}@example.com`, name]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BGW]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  const principal = await withScope({ userId: id, branchCode: BGW, isSuperUser: false }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BGW, name, id };
}

const run = <T>(p: Person, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: p.id, branchCode: p.branchCode, isSuperUser: false }, fn);
const poll = (p: Person, input: Partial<read.SyncRequest> = {}) =>
  run(p, (tx) => read.sync(tx, p, { open: null, visible: true, active: true, revs: {}, ack: {}, ...input }));
const choose = (p: Person, status: Parameters<typeof chat.setStatus>[2]) => run(p, (tx) => chat.setStatus(tx, p, status));

/** How `viewer` sees `other` in their direct conversation: on the list's row and among the thread's members. */
async function seenAs(viewer: Person, other: Person, conversationId: string) {
  const rows = await run(viewer, (tx) => read.listConversations(tx, viewer));
  const row = rows.find((c) => c.id === conversationId)!;
  const thread = await run(viewer, (tx) => read.threadOf(tx, viewer, conversationId));
  const member = thread.members.find((m) => m.userId === other.id)!;
  return { row: row.other!, member };
}

async function asApp<T>(p: Person, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true), set_config('app.branch_code', $2, true), set_config('app.is_super_user', 'false', true)`, [p.id, BGW]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

let alice: Person;
let bob: Person;
let carol: Person;
let conversation: string;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BGW, 'Baghdad');
  registerAllRecords();
  alice = await person('Alice Aziz', 'accounting_officer');
  bob = await person('Bob Barzani', 'accounting_manager');
  carol = await person('Carol Chalabi', 'accounting_officer');
  conversation = (await run(alice, (tx) => chat.openDirect(tx, alice, bob.id))).conversationId;
  // Both are at the page, and active.
  await poll(alice);
  await poll(bob);
});

describe('PS1 · the choice is kept', () => {
  it('stores the status, keeps busy in step, and hands it back in the poll', async () => {
    expect((await poll(bob)).me.status).toBe('available');
    await choose(bob, 'busy');
    const { rows } = await ownerPool.query(`select status, busy from chat_presence where user_id = $1`, [bob.id]);
    expect(rows[0]).toEqual({ status: 'busy', busy: true });
    expect((await poll(bob)).me).toMatchObject({ status: 'busy', busy: true });
    await choose(bob, 'away');
    expect((await poll(bob)).me).toMatchObject({ status: 'away', busy: false });
    // The chat screen's own switch is the same choice.
    await run(bob, (tx) => chat.setBusy(tx, bob, true));
    expect((await poll(bob)).me.status).toBe('busy');
    await run(bob, (tx) => chat.setBusy(tx, bob, false));
    expect((await poll(bob)).me.status).toBe('available');
  });
});

describe('PS2 · what colleagues see', () => {
  it('Busy is red, Away amber, Available online', async () => {
    expect((await seenAs(alice, bob, conversation)).row.presence).toBe('online');
    await choose(bob, 'busy');
    expect((await seenAs(alice, bob, conversation)).row.presence).toBe('busy');
    await choose(bob, 'away');
    const away = await seenAs(alice, bob, conversation);
    expect(away.row.presence).toBe('away');
    expect(away.member.presence).toBe('away');
  });
  it('Appear offline shows Offline and no last seen — and the person still receives', async () => {
    await choose(bob, 'invisible');
    await poll(bob);
    const hidden = await seenAs(alice, bob, conversation);
    expect(hidden.row).toMatchObject({ presence: 'offline', lastSeenAt: null });
    expect(hidden.member).toMatchObject({ presence: 'offline', lastSeenAt: null });
    await run(alice, (tx) => chat.sendMessage(tx, alice, { conversationId: conversation, body: 'Are you there?' }));
    const bobs = await poll(bob);
    expect(bobs.conversations.find((c) => c.id === conversation)?.unread).toBe(1);
    // Bob still sees himself as he chose.
    expect(bobs.me.status).toBe('invisible');
  });
});

describe('PS3 · the people search wears the dot', () => {
  it('for a colleague one talks to; no dot for one never talked to', async () => {
    await choose(bob, 'busy');
    await poll(carol);
    const hits = await run(alice, (tx) => read.searchPeople(tx, alice, ''));
    expect(hits.find((h) => h.userId === bob.id)?.presence).toBe('busy');
    // Carol is at her page, but shares no conversation with Alice: the presence policy keeps it from her.
    expect(hits.find((h) => h.userId === carol.id)?.presence).toBeNull();
    // The batched read the users list and the task list use: the same answer, in one query.
    const dots = await run(alice, (tx) => read.presenceOfUsers(tx, [bob.id, carol.id, alice.id]));
    expect(dots[bob.id]).toBe('busy');
    expect(dots[carol.id]).toBeUndefined();
    expect(dots[alice.id]).toBe('online');
  });
});

describe('PS4 · only one\'s own, and only the four', () => {
  it('nobody rewrites another\'s status, and the table refuses an unknown one', async () => {
    await choose(bob, 'available');
    const changed = await asApp(alice, (c) => c.query(`update chat_presence set status = 'busy' where user_id = $1`, [bob.id]));
    expect(changed.rowCount).toBe(0);
    await expect(ownerPool.query(`update chat_presence set status = 'sleeping' where user_id = $1`, [bob.id])).rejects.toThrow(/chat_presence_status_known/);
    await expect(choose(bob, 'sleeping' as never)).rejects.toThrow(/not a status/);
  });
});

describe('PS5 · the docked windows ride on the same poll', () => {
  it('each window that moved comes back with its thread; one already held only with its live part', async () => {
    const group = (await run(alice, (tx) => chat.createGroup(tx, alice, { title: 'Month end', memberIds: [bob.id, carol.id] }))).conversationId;
    await run(bob, (tx) => chat.sendMessage(tx, bob, { conversationId: group, body: 'Ready?' }));
    const first = await poll(alice, { open: conversation, windows: [group] });
    expect(first.thread?.id).toBe(conversation);
    expect(first.windows).toHaveLength(1);
    expect(first.windows[0]).toMatchObject({ id: group, closed: false });
    expect(first.windows[0]!.thread?.messages.map((m) => m.body)).toContain('Ready?');

    // Held at its revision: no thread again, only who is typing and the members.
    const rev = first.windows[0]!.thread!.rev;
    const again = await poll(alice, { open: conversation, revs: { [conversation]: first.thread!.rev, [group]: rev }, windows: [group] });
    expect(again.windows[0]!.thread).toBeNull();
    expect(again.windows[0]!.live?.members.map((m) => m.name).sort()).toEqual(['Alice Aziz', 'Bob Barzani', 'Carol Chalabi']);
  });
  it('a window on a conversation that is not theirs comes back closed, and never more than three', async () => {
    const theirs = (await run(bob, (tx) => chat.openDirect(tx, bob, carol.id))).conversationId;
    const answer = await poll(alice, { windows: [theirs] });
    expect(answer.windows).toEqual([{ id: theirs, thread: null, live: null, closed: true }]);
    const many = await poll(alice, { windows: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] });
    expect(many.windows).toHaveLength(read.SYNC_WINDOWS_MAX);
  });
});
