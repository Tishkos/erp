/**
 * Internal chat (platform phase, Agent 1) — the service and the database.
 *
 *   CH1  a direct conversation is found again, from either side; no grant, no chat
 *   CH2  receipts are real: sent → delivered (the recipient's browser acknowledged)
 *        → seen (read on screen); nobody can write them for somebody else
 *   CH3  replies keep the relation and quote the original; the original's
 *        withdrawal shows in the quote
 *   CH4  a message is never edited or deleted; the sender withdraws it with a
 *        reason, the text stays in the table and is never handed out again
 *   CH5  groups: nobody reads what was said before they came in; leaving and
 *        removal end reading; only an owner adds
 *   CH6  an outsider proves they see nothing: no grant → refused; a grant but
 *        not a member → nothing, and neither does a super user
 *   CH7  files hang on the message through the attachment service: members
 *        only, a cross-branch recipient too, nothing once withdrawn
 *   CH8  a record conversation never reaches somebody who cannot open the record
 *   CH9  notices: once per run of unread, a mention always, mute respected,
 *        read when the conversation is read
 *   CH10 presence, typing, reactions, search, unread and the badge
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { appPool, ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as authz from '@/server/services/authorization';
import * as chat from '@/server/services/chat';
import * as read from '@/server/services/chat-read';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BGW = 'BGW';
const ERB = 'ERB';

interface Person extends ActorContext {
  readonly name: string;
  readonly id: string;
  readonly superUser: boolean;
}

async function person(name: string, role: string | null, branch = BGW, superUser = false): Promise<Person> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [
    id,
    `${id}@example.com`,
    name,
    superUser,
  ]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, branch]);
  if (role) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  const principal = await withScope({ userId: id, branchCode: branch, isSuperUser: superUser }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch, name, id, superUser };
}

const run = <T>(p: Person, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: p.id, branchCode: p.branchCode, isSuperUser: p.superUser }, fn);

/** A raw connection as the application role, in one person's scope; always rolled back. */
async function asApp<T>(p: Person, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.user_id', $1, true), set_config('app.branch_code', $2, true), set_config('app.is_super_user', $3, true)`, [
      p.id,
      p.branchCode,
      p.superUser ? 'true' : 'false',
    ]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

/** A statement that must be refused; the transaction carries on after it. */
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
let dan: Person; // hr officer: holds chat, cannot open a port
let eve: Person; // no role at all: no chat grant
let frank: Person; // ceo: holds chat, in no one's conversation
let admin: Person; // super user, in no one's conversation
let gus: Person; // accounting officer in another branch

const send = (p: Person, conversationId: string, body: string, extra: Partial<chat.SendInput> = {}) =>
  run(p, (tx) => chat.sendMessage(tx, p, { conversationId, body, ...extra }));
const thread = (p: Person, conversationId: string) => run(p, (tx) => read.threadOf(tx, p, conversationId));
const direct = (p: Person, other: Person) => run(p, (tx) => chat.openDirect(tx, p, other.id));
const group = (p: Person, title: string, others: Person[]) =>
  run(p, (tx) => chat.createGroup(tx, p, { title, memberIds: others.map((o) => o.id) }));
const poll = (p: Person, input: Partial<read.SyncRequest> = {}) =>
  run(p, (tx) => read.sync(tx, p, { open: null, visible: true, active: true, revs: {}, ack: {}, ...input }));
const unread = async (p: Person) => (await run(p, (tx) => read.listConversations(tx, p))).map((c) => [c.name, c.unread]);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BGW, 'Baghdad');
  await seedBranch(ERB, 'Erbil');
  registerAllRecords();
  alice = await person('Alice Aziz', 'accounting_officer');
  bob = await person('Bob Barzani', 'accounting_manager');
  carol = await person('Carol Chalabi', 'accounting_officer');
  dan = await person('Dan Dulaimi', 'hr_officer');
  eve = await person('Eve Outsider', null);
  frank = await person('Frank Faraj', 'ceo');
  admin = await person('Ada Admin', null, BGW, true);
  gus = await person('Gus Gharib', 'accounting_officer', ERB);
});

describe('CH1 direct conversations', () => {
  it('opens one conversation per pair, from either side, and finds it again', async () => {
    const first = await direct(alice, bob);
    expect(first.created).toBe(true);
    const again = await direct(alice, bob);
    expect(again).toEqual({ conversationId: first.conversationId, created: false });
    const fromBob = await direct(bob, alice);
    expect(fromBob).toEqual({ conversationId: first.conversationId, created: false });
    const { rows } = await ownerPool.query(`select count(*)::int as n from chat_conversation`);
    expect(rows[0].n).toBe(1);
    // Named after the other person on each side.
    expect((await run(alice, (tx) => read.listConversations(tx, alice))).map((c) => c.name)).toEqual(['Bob Barzani']);
    expect((await run(bob, (tx) => read.listConversations(tx, bob))).map((c) => c.name)).toEqual(['Alice Aziz']);
  });

  it('refuses yourself, an inactive person and somebody without the chat grant', async () => {
    expect(await rejection(direct(alice, alice))).toMatch(/somebody else/);
    expect(await rejection(direct(alice, eve))).toMatch(/cannot be reached/);
    await ownerPool.query(`update app_user set is_active = false where id = $1`, [carol.id]);
    expect(await rejection(direct(alice, carol))).toMatch(/cannot be reached/);
  });

  it('refuses a caller without the chat grant, and writes the refusal', async () => {
    expect(await rejection(direct(eve, alice))).toMatch(/Permission denied/);
    const { rows } = await ownerPool.query(`select action, object_type from audit_event where actor_user_id = $1 and outcome = 'denied'`, [eve.id]);
    expect(rows).toEqual([{ action: 'authorisation.denied', object_type: 'chat' }]);
    expect(await rejection(poll(eve))).toMatch(/not available/);
  });
});

describe('CH2 receipts: sent, delivered, seen', () => {
  it('moves a message through the states only when the recipient acts', async () => {
    const { conversationId } = await direct(alice, bob);
    const sent = await send(alice, conversationId, 'Is the invoice posted?');
    expect(sent).toMatchObject({ seq: 1, duplicate: false });

    // The sender sees "sent": the server holds it, nobody has acknowledged it.
    let view = await thread(alice, conversationId);
    expect(view.messages[0]!.status).toMatchObject({ state: 'sent', total: 1, delivered: 0, seen: 0 });

    // Reading the list and even the thread as Bob is not an acknowledgement.
    await run(bob, (tx) => read.listConversations(tx, bob));
    await thread(bob, conversationId);
    await poll(bob, { open: conversationId, visible: true });
    view = await thread(alice, conversationId);
    expect(view.messages[0]!.status!.state).toBe('sent');

    // Bob's browser acknowledges what reached it: delivered.
    await poll(bob, { ack: { [conversationId]: 1 } });
    view = await thread(alice, conversationId);
    expect(view.messages[0]!.status).toMatchObject({ state: 'delivered', delivered: 1, seen: 0 });
    expect(view.messages[0]!.receipts[0]).toMatchObject({ name: 'Bob Barzani', seenAt: null });
    expect(view.messages[0]!.receipts[0]!.deliveredAt).not.toBeNull();

    // A hidden tab reads nothing, even when it says so.
    await poll(bob, { open: conversationId, visible: false, seen: { id: conversationId, upTo: 1 } });
    expect((await thread(alice, conversationId)).messages[0]!.status!.state).toBe('delivered');

    // On screen, read to the message: seen.
    await poll(bob, { open: conversationId, visible: true, seen: { id: conversationId, upTo: 1 } });
    view = await thread(alice, conversationId);
    expect(view.messages[0]!.status).toMatchObject({ state: 'seen', delivered: 1, seen: 1 });
    expect(await unread(bob)).toEqual([['Alice Aziz', 0]]);
  });

  it('records a read as a delivery at the same instant when no acknowledgement came first', async () => {
    const { conversationId } = await direct(alice, bob);
    await send(alice, conversationId, 'One');
    await poll(bob, { open: conversationId, seen: { id: conversationId, upTo: 1 } });
    const { rows } = await ownerPool.query(`select delivered_at, seen_at from chat_receipt`);
    expect(rows[0].delivered_at).not.toBeNull();
    expect(rows[0].seen_at.getTime()).toBeGreaterThanOrEqual(rows[0].delivered_at.getTime());
  });

  it('bumps the conversation revision so the sender’s next poll sees the change', async () => {
    const { conversationId } = await direct(alice, bob);
    await send(alice, conversationId, 'Hello');
    const before = (await poll(alice, { open: conversationId })).conversations[0]!.rev;
    await poll(bob, { ack: { [conversationId]: 1 } });
    const after = await poll(alice, { open: conversationId, revs: { [conversationId]: before } });
    expect(after.conversations[0]!.rev).toBeGreaterThan(before);
    expect(after.thread?.messages[0]!.status!.state).toBe('delivered');
    // Nothing moved since: the thread is not sent again.
    const quiet = await poll(alice, { open: conversationId, revs: { [conversationId]: after.conversations[0]!.rev } });
    expect(quiet.thread).toBeNull();
    expect(quiet.live?.id).toBe(conversationId);
  });

  it('in a group is delivered or seen only when every recipient has reached it', async () => {
    const { conversationId } = await group(alice, 'Month end', [bob, carol]);
    await send(alice, conversationId, 'Close at five');
    await poll(bob, { ack: { [conversationId]: 9 } });
    let status = (await thread(alice, conversationId)).messages.at(-1)!.status!;
    expect(status).toMatchObject({ state: 'sent', total: 2, delivered: 1 });
    await poll(carol, { ack: { [conversationId]: 9 } });
    status = (await thread(alice, conversationId)).messages.at(-1)!.status!;
    expect(status).toMatchObject({ state: 'delivered', delivered: 2, seen: 0 });
    await poll(bob, { open: conversationId, seen: { id: conversationId, upTo: 9 } });
    expect((await thread(alice, conversationId)).messages.at(-1)!.status).toMatchObject({ state: 'delivered', seen: 1 });
    await poll(carol, { open: conversationId, seen: { id: conversationId, upTo: 9 } });
    expect((await thread(alice, conversationId)).messages.at(-1)!.status).toMatchObject({ state: 'seen', seen: 2 });
  });

  it('cannot be written for somebody else, moved back, or skipped past delivery', async () => {
    const { conversationId } = await direct(alice, bob);
    await send(alice, conversationId, 'Hello');
    // The sender cannot mark the recipient's receipt: row-level security shows it to her, but will not let her update it.
    await asApp(alice, async (c) => {
      const seen = await c.query(`select count(*)::int as n from chat_receipt`);
      expect(seen.rows[0].n).toBe(1);
      const updated = await c.query(`update chat_receipt set delivered_at = now(), seen_at = now()`);
      expect(updated.rowCount).toBe(0);
    });
    // The recipient can mark their own, but not seen-before-delivered, nor backwards.
    await asApp(bob, async (c) => {
      expect(await refused(c, `update chat_receipt set seen_at = now()`)).toMatch(/chat_receipt_seen_after_delivered/);
    });
    await poll(bob, { open: conversationId, seen: { id: conversationId, upTo: 1 } });
    await asApp(bob, async (c) => {
      expect(await refused(c, `update chat_receipt set seen_at = null`)).toMatch(/cannot be unseen/);
      expect(await refused(c, `update chat_receipt set delivered_at = now() + interval '1 hour'`)).toMatch(/recorded once/);
      expect(await refused(c, `delete from chat_receipt`)).toMatch(/permission denied/);
    });
  });
});

describe('CH3 replies', () => {
  it('keeps the relation and shows the quoted original', async () => {
    const { conversationId } = await direct(alice, bob);
    const first = await send(alice, conversationId, 'Can you approve the payment run today before noon?');
    await send(bob, conversationId, 'Yes, after the call.', { replyToId: first.messageId });
    const view = await thread(alice, conversationId);
    const reply = view.messages.find((m) => m.body === 'Yes, after the call.')!;
    expect(reply.replyTo).toMatchObject({ id: first.messageId, seq: 1, senderName: 'Alice Aziz', retracted: false, available: true });
    expect(reply.replyTo!.preview).toBe('Can you approve the payment run today before noon?');
    const { rows } = await ownerPool.query(`select reply_to_id from chat_message where body = 'Yes, after the call.'`);
    expect(rows[0].reply_to_id).toBe(first.messageId);
  });

  it('refuses a reply to a message of another conversation, or one that does not exist', async () => {
    const one = await direct(alice, bob);
    const two = await direct(alice, carol);
    const other = await send(alice, two.conversationId, 'Elsewhere');
    expect(await rejection(send(alice, one.conversationId, 'Wrong place', { replyToId: other.messageId }))).toMatch(/not in this conversation/);
    expect(await rejection(send(alice, one.conversationId, 'Nowhere', { replyToId: randomUUID() }))).toMatch(/not in this conversation/);
    // The database holds the same rule.
    await expect(
      ownerPool.query(
        `insert into chat_message (conversation_id, sender_id, body, reply_to_id) values ($1,$2,'x',$3)`,
        [one.conversationId, alice.id, other.messageId],
      ),
    ).rejects.toThrow(/own conversation/);
  });

  it('says so in the quote when the original was withdrawn', async () => {
    const { conversationId } = await direct(alice, bob);
    const first = await send(alice, conversationId, 'Wrong number: 4,500');
    await send(bob, conversationId, 'Noted', { replyToId: first.messageId });
    await run(alice, (tx) => chat.retractMessage(tx, alice, first.messageId, 'typed the wrong figure'));
    const reply = (await thread(bob, conversationId)).messages.find((m) => m.body === 'Noted')!;
    expect(reply.replyTo).toMatchObject({ retracted: true, preview: '' });
  });
});

describe('CH4 messages are never edited or deleted', () => {
  it('withdraws with a reason: the text stays in the table and is never handed out', async () => {
    const { conversationId } = await direct(alice, bob);
    const m = await send(alice, conversationId, 'Password is hunter2');
    expect(await rejection(run(alice, (tx) => chat.retractMessage(tx, alice, m.messageId, 'no')))).toMatch(/Say why/);
    expect(await rejection(run(bob, (tx) => chat.retractMessage(tx, bob, m.messageId, 'not mine to withdraw')))).toMatch(/Only the person who wrote/);
    await run(alice, (tx) => chat.retractMessage(tx, alice, m.messageId, 'shared a secret by mistake'));
    expect(await rejection(run(alice, (tx) => chat.retractMessage(tx, alice, m.messageId, 'again please')))).toMatch(/already withdrawn/);

    for (const reader of [alice, bob]) {
      const shown = (await thread(reader, conversationId)).messages[0]!;
      expect(shown.body).toBe('');
      expect(shown.retracted).toMatchObject({ byName: 'Alice Aziz', reason: 'shared a secret by mistake' });
    }
    const { rows } = await ownerPool.query(`select body, retract_reason from chat_message where id = $1`, [m.messageId]);
    expect(rows[0]).toEqual({ body: 'Password is hunter2', retract_reason: 'shared a secret by mistake' });
    const audit = await ownerPool.query(`select reason, object_type from audit_event where action = 'chat.message_retracted'`);
    expect(audit.rows).toEqual([{ reason: 'shared a secret by mistake', object_type: 'chat_conversation' }]);
    // A withdrawn message is not unread.
    expect(await unread(bob)).toEqual([['Alice Aziz', 0]]);
  });

  it('is held by the database: no edit, no delete, no forged sender, no second withdrawal', async () => {
    const { conversationId } = await direct(alice, bob);
    const m = await send(alice, conversationId, 'Original');
    await asApp(alice, async (c) => {
      expect(await refused(c, `update chat_message set body = 'Edited'`)).toMatch(/permission denied/);
      expect(await refused(c, `delete from chat_message`)).toMatch(/permission denied/);
    });
    // Even the owner of the table cannot edit or delete one.
    await expect(ownerPool.query(`update chat_message set body = 'Edited' where id = $1`, [m.messageId])).rejects.toThrow(/not edited/);
    await expect(ownerPool.query(`delete from chat_message where id = $1`, [m.messageId])).rejects.toThrow(/append-only|not allowed|cannot/i);
    await expect(ownerPool.query(`delete from chat_conversation where id = $1`, [conversationId])).rejects.toThrow(/append-only|not allowed|cannot/i);
    await expect(ownerPool.query(`delete from chat_participant where conversation_id = $1`, [conversationId])).rejects.toThrow(/append-only|not allowed|cannot/i);
    // A message cannot be written in somebody else's name.
    await asApp(alice, async (c) => {
      expect(await refused(c, `insert into chat_message (conversation_id, sender_id, body) values ($1,$2,'forged')`, [conversationId, bob.id])).toMatch(/row-level security/);
    });
    // Only the sender may write the withdrawal.
    await asApp(bob, async (c) => {
      const r = await c.query(`update chat_message set retracted_at = now(), retracted_by = $1, retract_reason = 'not yours' where id = $2`, [bob.id, m.messageId]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('refuses an empty message, an over-long one and the same send twice', async () => {
    const { conversationId } = await direct(alice, bob);
    expect(await rejection(send(alice, conversationId, '   '))).toMatch(/Write something/);
    expect(await rejection(send(alice, conversationId, 'x'.repeat(4001)))).toMatch(/at most 4000/);
    const clientId = randomUUID();
    const one = await send(alice, conversationId, 'Once', { clientId });
    const again = await send(alice, conversationId, 'Once', { clientId });
    expect(again).toEqual({ messageId: one.messageId, seq: one.seq, duplicate: true });
    const { rows } = await ownerPool.query(`select count(*)::int as n from chat_message`);
    expect(rows[0].n).toBe(1);
  });

  it('numbers messages one after another, whoever writes', async () => {
    const { conversationId } = await direct(alice, bob);
    const seqs = [];
    for (let i = 0; i < 3; i += 1) {
      seqs.push((await send(i % 2 === 0 ? alice : bob, conversationId, `Line ${i}`)).seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
    await Promise.all([send(alice, conversationId, 'Parallel A'), send(bob, conversationId, 'Parallel B')]);
    const { rows } = await ownerPool.query(`select seq from chat_message order by seq`);
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('CH5 groups', () => {
  it('does not let a person added later read what was said before', async () => {
    const { conversationId } = await group(alice, 'Month end', [bob]);
    await send(alice, conversationId, 'Before Carol');
    await run(alice, (tx) => chat.addMembers(tx, alice, conversationId, [carol.id]));
    await send(bob, conversationId, 'After Carol');
    const seen = (await thread(carol, conversationId)).messages.map((m) => (m.kind === 'system' ? `[${m.body}]` : m.body));
    expect(seen).toEqual(['[added]', 'After Carol']);
    // The same is true of search and of the table itself.
    expect(await run(carol, (tx) => read.searchMessages(tx, carol, 'Before Carol'))).toEqual([]);
    await asApp(carol, async (c) => {
      const r = await c.query(`select body from chat_message where kind = 'text' order by seq`);
      expect(r.rows.map((x) => x.body)).toEqual(['After Carol']);
    });
    // Her unread starts from the next message too.
    expect(await unread(carol)).toEqual([['Month end', 1]]);
  });

  it('ends reading when somebody leaves or is removed, and keeps what they read before', async () => {
    const { conversationId } = await group(alice, 'Month end', [bob, carol]);
    await send(alice, conversationId, 'Everyone in');
    await run(carol, (tx) => chat.leaveConversation(tx, carol, conversationId));
    await run(alice, (tx) => chat.removeMember(tx, alice, conversationId, bob.id));
    await send(alice, conversationId, 'Only me now');
    for (const gone of [bob, carol]) {
      expect(await rejection(thread(gone, conversationId))).toMatch(/not exist or you are not in it/);
      expect(await run(gone, (tx) => read.listConversations(tx, gone))).toEqual([]);
      await asApp(gone, async (c) => {
        expect((await c.query(`select count(*)::int as n from chat_message`)).rows[0].n).toBe(0);
      });
      expect(await rejection(send(gone, conversationId, 'Let me back'))).toMatch(/not exist or you are not in it/);
    }
    // Their rows are kept: leaving is a date, not a deletion.
    const { rows } = await ownerPool.query(`select count(*)::int as n from chat_participant where left_at is not null`);
    expect(rows[0].n).toBe(2);
    // A person cannot put themselves back.
    await asApp(carol, async (c) => {
      expect(await refused(c, `update chat_participant set left_at = null, first_seq = 99 where user_id = $1`, [carol.id])).toMatch(/owner adds someone back|row-level security/);
    });
  });

  it('lets only an owner add, remove or rename; the last owner leaving hands the group on', async () => {
    const { conversationId } = await group(alice, 'Month end', [bob]);
    expect(await rejection(run(bob, (tx) => chat.addMembers(tx, bob, conversationId, [carol.id])))).toMatch(/Only an owner/);
    expect(await rejection(run(bob, (tx) => chat.renameGroup(tx, bob, conversationId, 'Mine')))).toMatch(/Only an owner/);
    await run(alice, (tx) => chat.renameGroup(tx, alice, conversationId, 'Quarter end'));
    await run(alice, (tx) => chat.leaveConversation(tx, alice, conversationId));
    // Bob became the owner when Alice left; he can add now.
    await run(bob, (tx) => chat.addMembers(tx, bob, conversationId, [carol.id]));
    const rows = (await thread(bob, conversationId)).members.map((m) => [m.name, m.role]);
    expect(rows).toEqual([['Bob Barzani', 'owner'], ['Carol Chalabi', 'member']]);
    expect((await thread(bob, conversationId)).title).toBe('Quarter end');
    // A direct conversation has no members to change.
    const pair = await direct(bob, carol);
    expect(await rejection(run(bob, (tx) => chat.addMembers(tx, bob, pair.conversationId, [alice.id])))).toMatch(/no members to change/);
  });

  it('refuses a group of nobody, with a stranger to chat, or without a name', async () => {
    expect(await rejection(group(alice, 'Alone', []))).toMatch(/at least one colleague/);
    expect(await rejection(group(alice, 'With Eve', [eve]))).toMatch(/cannot be reached/);
    expect(await rejection(group(alice, '  ', [bob]))).toMatch(/needs a name/);
  });
});

describe('CH6 an outsider sees nothing', () => {
  it('refuses a person with no chat grant, and shows a person with one nothing of other people’s conversations', async () => {
    const one = await direct(alice, bob);
    const many = await group(alice, 'Private', [bob, carol]);
    await send(alice, one.conversationId, 'Secret plan');
    await send(alice, many.conversationId, 'Secret plan for the group');

    // Frank holds the grant and is in neither: the service says there is nothing.
    for (const id of [one.conversationId, many.conversationId]) {
      expect(await rejection(thread(frank, id))).toMatch(/not exist or you are not in it/);
      expect(await rejection(send(frank, id, 'Let me in'))).toMatch(/not exist or you are not in it/);
      expect(await rejection(run(frank, (tx) => chat.markSeen(tx, frank, id, 99)))).toMatch(/not exist or you are not in it/);
      expect(await rejection(run(frank, (tx) => chat.setMuted(tx, frank, id, true)))).toMatch(/not exist or you are not in it/);
    }
    expect(await run(frank, (tx) => read.listConversations(tx, frank))).toEqual([]);
    expect(await run(frank, (tx) => read.searchMessages(tx, frank, 'Secret plan'))).toEqual([]);
    expect((await poll(frank, { open: one.conversationId })).closed).toBe(one.conversationId);

    // And the database agrees, for every table, for Frank, for the super user and for the person with no grant.
    for (const stranger of [frank, admin, eve]) {
      await asApp(stranger, async (c) => {
        for (const table of ['chat_conversation', 'chat_participant', 'chat_message', 'chat_receipt', 'chat_reaction']) {
          const r = await c.query(`select count(*)::int as n from ${table}`);
          expect(r.rows[0].n, `${stranger.name} reads ${table}`).toBe(0);
        }
      });
    }
    // Nor can they write into them.
    await asApp(frank, async (c) => {
      expect(await refused(c, `insert into chat_participant (conversation_id, user_id) values ($1,$2)`, [one.conversationId, frank.id])).toMatch(/row-level security/);
      expect(await refused(c, `insert into chat_message (conversation_id, sender_id, body) values ($1,$2,'hi')`, [one.conversationId, frank.id])).toMatch(/row-level security/);
      const r = await c.query(`update chat_conversation set title = 'Mine' where id = $1`, [many.conversationId]);
      expect(r.rowCount).toBe(0);
    });
    // The super user is not a member of a private conversation either.
    expect(await rejection(thread(admin, one.conversationId))).toMatch(/not exist or you are not in it/);
  });

  it('shows a person only the presence of those they share a conversation with', async () => {
    await direct(alice, bob);
    await poll(bob);
    await poll(frank);
    await asApp(alice, async (c) => {
      const r = await c.query(`select user_id from chat_presence order by user_id`);
      expect(r.rows.map((x) => x.user_id)).toEqual([bob.id].sort());
    });
  });
});

describe('CH7 files', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fileOf = (p: Person, id: string) => run(p, (tx) => read.fileOf(tx, p, id));

  it('stores a file through the attachment service, on the message, and shows name, size and type', async () => {
    const { conversationId } = await direct(alice, bob);
    const sent = await send(alice, conversationId, '', { files: [{ name: 'photo.png', content: PNG }] });
    const message = (await thread(bob, conversationId)).messages[0]!;
    expect(message.files).toHaveLength(1);
    expect(message.files[0]).toMatchObject({ fileName: 'photo.png', contentType: 'image/png', sizeBytes: PNG.length, kind: 'image' });
    const { rows } = await ownerPool.query(`select object_type, object_id, scan_status, uploaded_by from attachment`);
    expect(rows).toEqual([{ object_type: 'chat_message', object_id: sent.messageId, scan_status: 'clean', uploaded_by: alice.id }]);
    for (const member of [alice, bob]) {
      const file = await fileOf(member, message.files[0]!.id);
      expect(file.fileName).toBe('photo.png');
      expect(Buffer.compare(file.content, PNG)).toBe(0);
    }
    // The preview line of the list knows there is a file.
    expect((await run(bob, (tx) => read.listConversations(tx, bob)))[0]!.lastMessage).toMatchObject({ preview: '', fileCount: 1 });
  });

  it('is read by members only: a person with the chat grant who is not in it, and one without it, are refused', async () => {
    const { conversationId } = await direct(alice, bob);
    await send(alice, conversationId, 'See attached', { files: [{ name: 'note.txt', content: Buffer.from('quarter figures') }] });
    const id = (await thread(alice, conversationId)).messages[0]!.files[0]!.id;
    expect(await rejection(fileOf(frank, id))).toMatch(/cannot access this attachment|No such/);
    expect(await rejection(fileOf(admin, id))).toMatch(/Permission denied|cannot access|No such/);
    expect(await rejection(fileOf(eve, id))).toMatch(/Permission denied/);
    // Not through the general attachment door either: nobody has the attachment grant for it.
    expect(await rejection(run(frank, (tx) => import('@/server/services/attachments').then((a) => a.download(tx, frank, id))))).toMatch(/Permission denied|cannot access/);
    // A denial is written to the access log.
    const denied = await ownerPool.query(`select count(*)::int as n from attachment_access where denied`);
    expect(denied.rows[0].n).toBeGreaterThan(0);
  });

  it('reaches a recipient in another branch, and not a bystander in that branch', async () => {
    const { conversationId } = await direct(alice, gus);
    await send(alice, conversationId, 'For Erbil', { files: [{ name: 'erbil.txt', content: Buffer.from('erbil stock list') }] });
    const view = await thread(gus, conversationId);
    expect(view.messages[0]!.files[0]!.fileName).toBe('erbil.txt');
    expect((await fileOf(gus, view.messages[0]!.files[0]!.id)).fileName).toBe('erbil.txt');
    const other = await person('Hana Hadi', 'accounting_officer', ERB);
    expect(await rejection(fileOf(other, view.messages[0]!.files[0]!.id))).toMatch(/cannot access|No such/);
  });

  it('stops serving the files of a withdrawn message, and refuses a file that fails the scan', async () => {
    const { conversationId } = await direct(alice, bob);
    const sent = await send(alice, conversationId, 'Oops', { files: [{ name: 'oops.txt', content: Buffer.from('wrong file') }] });
    const id = (await thread(alice, conversationId)).messages[0]!.files[0]!.id;
    await run(alice, (tx) => chat.retractMessage(tx, alice, sent.messageId, 'sent the wrong file'));
    expect(await rejection(fileOf(bob, id))).toMatch(/cannot access|No such/);
    expect((await thread(bob, conversationId)).messages[0]!.files).toEqual([]);

    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    expect(await rejection(send(alice, conversationId, 'virus', { files: [{ name: 'eicar.txt', content: eicar }] }))).toMatch(/malware scan/);
    const { rows } = await ownerPool.query(`select count(*)::int as n from chat_message where body = 'virus'`);
    expect(rows[0].n).toBe(0);
    const refused = await ownerPool.query(`select action from audit_event where action = 'chat.file_refused'`);
    expect(refused.rows).toHaveLength(1);
  });

  it('limits the files in one message', async () => {
    const { conversationId } = await direct(alice, bob);
    const files = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, content: Buffer.from(`file ${i}`) }));
    expect(await rejection(send(alice, conversationId, 'Too many', { files }))).toMatch(/At most 5 files/);
  });
});

describe('CH8 conversations about a record', () => {
  async function port(): Promise<string> {
    await ownerPool.query(`insert into port (code, name) values ('KHOR','Khor Al Zubair') on conflict do nothing`);
    return 'KHOR';
  }
  const open = (p: Person, recordId: string, others: Person[], extra: Partial<chat.RecordConversationInput> = {}) =>
    run(p, (tx) =>
      chat.openRecordConversation(tx, p, {
        recordType: 'port',
        recordId,
        label: 'Port of Khor Al Zubair',
        href: '/logistics/ports',
        memberIds: others.map((o) => o.id),
        ...extra,
      }),
    );

  it('is found again by (type, id, members) and shows the record to the members who can open it', async () => {
    const id = await port();
    const first = await open(alice, id, [bob]);
    expect(first.created).toBe(true);
    expect(await open(alice, id, [bob])).toEqual({ conversationId: first.conversationId, created: false });
    expect(await open(bob, id, [alice])).toEqual({ conversationId: first.conversationId, created: false });
    const view = await thread(bob, first.conversationId);
    expect(view.record).toEqual({ accessible: true, type: 'port', id, label: 'Port of Khor Al Zubair', href: '/logistics/ports' });
    expect(await run(alice, (tx) => read.recordConversationsFor(tx, alice, 'port', id))).toEqual([{ id: first.conversationId, name: 'Bob Barzani', unread: 0 }]);
    // Another member set is another conversation about the same record.
    expect((await open(alice, id, [carol])).created).toBe(true);
  });

  it('refuses a record the opener cannot open, a colleague who cannot, a made-up type and a foreign link', async () => {
    const id = await port();
    expect(await rejection(open(dan, id, [alice]))).toMatch(/cannot open that record/);
    expect(await rejection(open(alice, id, [dan]))).toMatch(/Dan Dulaimi cannot open this record/);
    expect(await rejection(open(alice, id, [bob], { recordType: 'no_such_record' }))).toMatch(/cannot open that record/);
    expect(await rejection(open(alice, 'MISSING', [bob]))).toMatch(/cannot open that record/);
    expect(await rejection(open(alice, id, [bob], { href: 'https://evil.example/x' }))).toMatch(/path here/);
    expect(await rejection(open(alice, id, [bob], { href: '//evil.example/x' }))).toMatch(/path here/);
    const { rows } = await ownerPool.query(`select count(*)::int as n from chat_conversation`);
    expect(rows[0].n).toBe(0);
  });

  it('does not add a person to it who cannot open the record, and hides the record from a member who no longer can', async () => {
    const id = await port();
    const { conversationId } = await open(alice, id, [bob, carol]);
    expect(await rejection(run(alice, (tx) => chat.addMembers(tx, alice, conversationId, [dan.id])))).toMatch(/cannot open the record/);
    await send(alice, conversationId, 'About the port');
    // Carol's role is taken away: she is still in the conversation she was in, but the record is no longer shown to her.
    await ownerPool.query(`delete from user_role where user_id = $1`, [carol.id]);
    const carolPrincipal = { ...carol, principal: await withScope({ userId: carol.id, branchCode: BGW }, (tx) => authz.loadPrincipal(tx, carol.id)) };
    const view = await run(carolPrincipal, (tx) => read.threadOf(tx, carolPrincipal, conversationId));
    expect(view.record).toEqual({ accessible: false });
    expect(JSON.stringify(view)).not.toContain('Khor Al Zubair');
    expect(JSON.stringify(view)).not.toContain('KHOR');
    // Bob still sees it.
    const bobsRecord = (await thread(bob, conversationId)).record;
    expect(bobsRecord && bobsRecord.accessible ? bobsRecord.label : null).toBe('Port of Khor Al Zubair');
  });
});

describe('CH9 notices', () => {
  const notices = async () =>
    (await ownerPool.query(`select event_type, recipient_user_id, subject, read_at is not null as read, context from notification where event_type like 'chat.%' order by id`)).rows;

  it('raises one chat.message per run of unread messages, and the next run after they were read', async () => {
    const { conversationId } = await direct(alice, bob);
    await send(alice, conversationId, 'One');
    await send(alice, conversationId, 'Two');
    await send(alice, conversationId, 'Three');
    let rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'chat.message', recipient_user_id: bob.id, subject: 'Alice Aziz', read: false });
    expect(rows[0].context).toMatchObject({ conversationId, href: `/chat?c=${conversationId}` });

    // Reading the conversation reads the notice.
    await poll(bob, { open: conversationId, seen: { id: conversationId, upTo: 3 } });
    rows = await notices();
    expect(rows[0].read).toBe(true);
    // The run after that is a new notice.
    await send(alice, conversationId, 'Four');
    expect(await notices()).toHaveLength(2);
    // The sender is never told about their own message.
    expect((await notices()).every((n) => n.recipient_user_id === bob.id)).toBe(true);
  });

  it('raises chat.mention for each person named, even in a muted conversation, and none to the author', async () => {
    const { conversationId } = await group(alice, 'Month end', [bob, carol]);
    await run(bob, (tx) => chat.setMuted(tx, bob, conversationId, true));
    await send(alice, conversationId, 'Please check this @Bob Barzani and @Carol Chalabi, also @Alice Aziz');
    const rows = await notices();
    expect(rows.map((r) => [r.event_type, r.recipient_user_id]).sort()).toEqual(
      [['chat.mention', bob.id], ['chat.mention', carol.id]].sort(),
    );
    expect(rows[0]!.subject).toBe('Alice Aziz mentioned you in Month end');
    // A plain message raises nothing for the muted member and a notice for the other.
    await send(alice, conversationId, 'Plain message');
    const after = await notices();
    const plain = after.filter((r) => r.event_type === 'chat.message');
    expect(plain.map((r) => r.recipient_user_id)).toEqual([carol.id]);
    // The message records who it mentions.
    const { rows: stored } = await ownerPool.query(`select mentions from chat_message where body like 'Please check%'`);
    expect([...stored[0].mentions].sort()).toEqual([bob.id, carol.id].sort());
    expect((await thread(bob, conversationId)).messages.find((m) => m.body.startsWith('Please check'))!.mentionsMe).toBe(true);
  });
});

describe('CH10 presence, typing, reactions, search and unread', () => {
  it('derives presence from the heartbeat, and busy and offline from the rest', async () => {
    const { conversationId } = await direct(alice, bob);
    let view = await thread(alice, conversationId);
    expect(view.members.find((m) => m.userId === bob.id)).toMatchObject({ presence: 'offline', lastSeenAt: null });
    await poll(bob, { active: true });
    view = await thread(alice, conversationId);
    expect(view.members.find((m) => m.userId === bob.id)!.presence).toBe('online');
    await poll(bob, { active: false });
    await ownerPool.query(`update chat_presence set last_active_at = now() - interval '10 minutes' where user_id = $1`, [bob.id]);
    expect((await thread(alice, conversationId)).members.find((m) => m.userId === bob.id)!.presence).toBe('away');
    await run(bob, (tx) => chat.setBusy(tx, bob, true));
    expect((await thread(alice, conversationId)).members.find((m) => m.userId === bob.id)!.presence).toBe('busy');
    await ownerPool.query(`update chat_presence set last_seen_at = now() - interval '5 minutes' where user_id = $1`, [bob.id]);
    const gone = (await thread(alice, conversationId)).members.find((m) => m.userId === bob.id)!;
    expect(gone.presence).toBe('offline');
    expect(gone.lastSeenAt).not.toBeNull();
    // The conversation list carries the other person's presence for a direct conversation.
    expect((await run(alice, (tx) => read.listConversations(tx, alice)))[0]!.other!.presence).toBe('offline');
  });

  it('shows who is typing until it lapses', async () => {
    const { conversationId } = await group(alice, 'Month end', [bob, carol]);
    await run(bob, (tx) => chat.setTyping(tx, bob, conversationId, true));
    expect((await poll(alice, { open: conversationId, revs: { [conversationId]: 99 } })).live!.typing).toEqual(['Bob Barzani']);
    expect((await poll(bob, { open: conversationId })).live!.typing).toEqual([]);
    await ownerPool.query(`update chat_participant set typing_until = now() - interval '1 second' where user_id = $1`, [bob.id]);
    expect((await poll(alice, { open: conversationId })).live!.typing).toEqual([]);
    await run(bob, (tx) => chat.setTyping(tx, bob, conversationId, true));
    await run(bob, (tx) => chat.setTyping(tx, bob, conversationId, false));
    expect((await poll(alice, { open: conversationId })).live!.typing).toEqual([]);
  });

  it('reacts and un-reacts, one of each kind per person, only to what the person can read', async () => {
    const { conversationId } = await direct(alice, bob);
    const m = await send(alice, conversationId, 'Approved');
    await run(bob, (tx) => chat.react(tx, bob, m.messageId, 'thanks', true));
    await run(bob, (tx) => chat.react(tx, bob, m.messageId, 'thanks', true));
    await run(alice, (tx) => chat.react(tx, alice, m.messageId, 'thanks', true));
    await run(alice, (tx) => chat.react(tx, alice, m.messageId, 'done', true));
    let reactions = (await thread(bob, conversationId)).messages[0]!.reactions;
    expect(reactions.find((r) => r.reaction === 'thanks')).toMatchObject({ count: 2, mine: true });
    expect(reactions.find((r) => r.reaction === 'done')).toMatchObject({ count: 1, mine: false, names: ['Alice Aziz'] });
    await run(bob, (tx) => chat.react(tx, bob, m.messageId, 'thanks', false));
    reactions = (await thread(bob, conversationId)).messages[0]!.reactions;
    expect(reactions.find((r) => r.reaction === 'thanks')).toMatchObject({ count: 1, mine: false });
    expect(await rejection(run(bob, (tx) => chat.react(tx, bob, m.messageId, 'poop', true)))).toMatch(/not available/);
    expect(await rejection(run(frank, (tx) => chat.react(tx, frank, m.messageId, 'like', true)))).toMatch(/no such message/);
  });

  it('searches the messages a person can read, with a snippet, and nothing shorter than two characters', async () => {
    const one = await direct(alice, bob);
    const two = await direct(alice, carol);
    await send(alice, one.conversationId, 'The Zubair invoice is ready');
    await send(bob, one.conversationId, 'zubair confirmed');
    await send(alice, two.conversationId, 'Carol, the zubair shipment is late');
    const hits = await run(alice, (tx) => read.searchMessages(tx, alice, 'ZUBAIR'));
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.conversationName).sort()).toEqual(['Bob Barzani', 'Bob Barzani', 'Carol Chalabi']);
    expect(hits.find((h) => h.snippet.includes('shipment'))!.mine).toBe(true);
    // Bob reads only his own conversation's matches.
    expect(await run(bob, (tx) => read.searchMessages(tx, bob, 'zubair'))).toHaveLength(2);
    expect(await run(bob, (tx) => read.searchMessages(tx, bob, 'zubair', { conversationId: two.conversationId }))).toEqual([]);
    expect(await run(alice, (tx) => read.searchMessages(tx, alice, 'z'))).toEqual([]);
    expect(await run(alice, (tx) => read.searchMessages(tx, alice, '%'))).toEqual([]);
    // A withdrawn message is not found.
    const withdrawn = await send(alice, one.conversationId, 'Wrongly sent zubair');
    await run(alice, (tx) => chat.retractMessage(tx, alice, withdrawn.messageId, 'sent in error'));
    expect(await run(alice, (tx) => read.searchMessages(tx, alice, 'Wrongly'))).toEqual([]);
  });

  it('counts unread per conversation and leaves a muted one out of the badge', async () => {
    const one = await direct(alice, bob);
    const two = await group(alice, 'Month end', [bob, carol]);
    await send(alice, one.conversationId, 'a');
    await send(alice, one.conversationId, 'b');
    await send(alice, two.conversationId, 'c');
    let sync = await poll(bob);
    expect(sync.conversations.map((c) => [c.name, c.unread, c.muted]).sort()).toEqual([['Alice Aziz', 2, false], ['Month end', 1, false]].sort());
    expect(sync.badge).toBe(3);
    await run(bob, (tx) => chat.setMuted(tx, bob, two.conversationId, true));
    sync = await poll(bob);
    expect(sync.badge).toBe(2);
    expect(sync.conversations.find((c) => c.name === 'Month end')).toMatchObject({ unread: 1, muted: true });
    // The list is newest first, with the last message as its preview.
    expect(sync.conversations[0]!.name).toBe('Month end');
    expect(sync.conversations[0]!.lastMessage).toMatchObject({ preview: 'c', senderName: 'Alice Aziz' });
    // Alice's own messages are never unread for her.
    expect((await poll(alice)).badge).toBe(0);
  });

  it('finds colleagues to talk to: active, holding chat, never the asker', async () => {
    const names = (await run(alice, (tx) => read.searchPeople(tx, alice, ''))).map((p) => p.name);
    expect(names).toContain('Bob Barzani');
    expect(names).toContain('Ada Admin');
    expect(names).not.toContain('Alice Aziz');
    expect(names).not.toContain('Eve Outsider');
    expect((await run(alice, (tx) => read.searchPeople(tx, alice, 'carol'))).map((p) => p.name)).toEqual(['Carol Chalabi']);
    await ownerPool.query(`update app_user set is_active = false where id = $1`, [carol.id]);
    expect(await run(alice, (tx) => read.searchPeople(tx, alice, 'carol'))).toEqual([]);
  });
});
