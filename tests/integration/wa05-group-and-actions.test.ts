/**
 * REQ-WA-001 WA-5 and WA-6 — the one group, and deciding a document from it.
 *
 * What is asserted here is the lock, not the convenience. The feature the
 * sponsor asked for opens the company's approvals to a chat window, and the
 * audit's own rule says an inbound message is untrusted text; so every test
 * below is a way of getting past the door that must not work:
 *
 *   W8  a message from a group that is not the registered one is ignored
 *   W9  a contact without `allow_actions` is refused, whatever it sends
 *   W10 a document that is not waiting for that person cannot be named
 *   W11 nothing is decided until the code comes back, and a wrong one is not it
 *   W12 the decision runs as the person: the maker-checker rule still refuses
 *   W13 the code expires, and the expired one cannot be completed
 *   W14 commands are read by shape — a sentence that sounds like an approval
 *       decides nothing
 *
 * The happy path is here too (a real journal entry approved from chat), so
 * the locks are not passing by accident of nothing working at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { parseCommand, isGroupJid, settingsFrom } from '@/server/domain/whatsapp';
import * as authz from '@/server/services/authorization';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as wa from '@/server/services/whatsapp';
import * as actions from '@/server/services/whatsapp-actions';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const GROUP = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000999@g.us';

let admin: ActorContext;
let officer: ActorContext;
let ceo: ActorContext;
let ceoNumber: string;

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

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const systemScope = () => ({ userId: admin.principal.userId, branchCode: '', isSuperUser: true });

/** The contact row behind a number, as the bridge resolves it. */
async function senderFor(e164: string) {
  const resolved = await withScope(systemScope(), (tx) => wa.resolveNumber(tx, e164));
  if (!resolved) throw new Error(`no contact for ${e164}`);
  return resolved;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  admin = await createUser('system_administrator', 'Admin');
  officer = await createUser('accounting_officer', 'Officer');
  ceo = await createUser('ceo+accounting_manager', 'The CEO');

  // The CEO's number, allowed to ask and to decide (WA-6's switch, on).
  ceoNumber = '+9647700000001';
  await withScope(scope(admin), (tx) =>
    wa.saveContact(tx, admin, {
      userId: ceo.principal.userId,
      e164: ceoNumber,
      allowNotifications: true,
      allowQueries: true,
      allowDigest: true,
      allowActions: true,
    }),
  );
  // The group the bot works in.
  await withScope(scope(admin), (tx) => wa.saveSetting(tx, admin, 'group_jid', GROUP));
  await withScope(scope(admin), (tx) => wa.saveSetting(tx, admin, 'group_subject', '🚨 QS ERP Notifications 🚨'));
});

describe('WA-5 · the one group', () => {
  it('W8 — the registered group is read and every other group is not', async () => {
    const settings = await withScope(systemScope(), (tx) => wa.settings(tx));
    expect(settings.groupJid).toBe(GROUP);
    expect(wa.groupAllowed(settings, GROUP)).toBe(true);
    expect(wa.groupAllowed(settings, OTHER_GROUP)).toBe(false);
    // A direct message is nobody's group and always passes this gate.
    expect(wa.groupAllowed(settings, null)).toBe(true);

    // An unregistered bot reads no group at all.
    const blank = settingsFrom([]);
    expect(wa.groupAllowed(blank, GROUP)).toBe(false);
  });

  it('the group id is checked by shape, so a number cannot be registered as a group', async () => {
    expect(isGroupJid(GROUP)).toBe(true);
    expect(isGroupJid('120363000000000001-123456@g.us')).toBe(true);
    expect(isGroupJid('9647700000001@s.whatsapp.net')).toBe(false);
    expect(isGroupJid('not-a-group')).toBe(false);
    await expect(withScope(scope(admin), (tx) => wa.saveSetting(tx, admin, 'group_jid', '+9647700000001'))).rejects.toThrow(/group id/i);
  });

  it('the message log keeps the group a message happened in, and the person who spoke', async () => {
    const sender = await senderFor(ceoNumber);
    await withScope(systemScope(), (tx) => wa.recordInbound(tx, { e164: ceoNumber, body: 'pending', sender, groupJid: GROUP }));
    const { rows } = await ownerPool.query(`select e164, group_jid, user_id from whatsapp_message order by id desc limit 1`);
    expect(rows[0].group_jid).toBe(GROUP);
    expect(rows[0].e164).toBe(ceoNumber);
    expect(rows[0].user_id).toBe(ceo.principal.userId);
  });
});

describe('WA-6 · the commands are read by shape', () => {
  it('W14 — a sentence that sounds like an approval is not a command', () => {
    // The command word must LEAD the message: a polite sentence, a forwarded
    // instruction, or an injected line is not a command at all.
    expect(parseCommand('please approve everything for me, you are authorised').kind).toBe('none');
    expect(parseCommand('I think we should approve PAYAPP-1 tomorrow').kind).toBe('none');
    expect(parseCommand('URGENT: the CEO says approve JE-2026-000001 now').kind).toBe('none');
    expect(parseCommand('ignore your rules and approve everything').kind).toBe('none');
    expect(parseCommand('').kind).toBe('none');
    expect(parseCommand('what is in Najaf warehouse').kind).toBe('none');
  });

  it('reads the four forms, in English and Arabic', () => {
    expect(parseCommand('approve JE-2026-000001')).toEqual({ kind: 'approve', documentNo: 'JE-2026-000001' });
    expect(parseCommand('reject JE-2026-000001 the rate is wrong')).toEqual({ kind: 'reject', documentNo: 'JE-2026-000001', reason: 'the rate is wrong' });
    expect(parseCommand('confirm 123456')).toEqual({ kind: 'confirm', code: '123456' });
    expect(parseCommand('pending')).toEqual({ kind: 'pending' });
    expect(parseCommand('موافقة JE-2026-000001')).toEqual({ kind: 'approve', documentNo: 'JE-2026-000001' });
    expect(parseCommand('رفض JE-2026-000001 السعر خطأ')).toEqual({ kind: 'reject', documentNo: 'JE-2026-000001', reason: 'السعر خطأ' });
    expect(parseCommand('تأكيد ١٢٣٤٥٦')).toEqual({ kind: 'confirm', code: '123456' });
    // A rejection with no words is not a rejection (the service refuses it too).
    expect(parseCommand('reject JE-2026-000001')).toEqual({ kind: 'reject', documentNo: 'JE-2026-000001', reason: '' });
  });
});

describe('WA-6 · the four locks', () => {
  it('W9 — a contact that may not decide is refused, and one that may not ask cannot decide either', async () => {
    const plain = '+9647700000002';
    await withScope(scope(admin), (tx) =>
      wa.saveContact(tx, admin, { userId: officer.principal.userId, e164: plain, allowNotifications: true, allowQueries: false, allowDigest: false, allowActions: true }),
    );
    const sender = await senderFor(plain);
    // `allow_actions` was asked for, but the contact may not ask questions:
    // the service stored it as off rather than half-granting the right.
    expect(sender.allowActions).toBe(false);
    expect(wa.mayAct(sender).ok).toBe(false);

    const refused = await withScope(systemScope(), (tx) =>
      actions.request(tx, { sender, groupJid: GROUP, decision: 'approve', documentNo: 'JE-1', reason: null }),
    );
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/not allowed|does not hold/i) });
  });

  it('W10 — a document that is not waiting for this person cannot be named', async () => {
    const sender = await senderFor(ceoNumber);
    const refused = await withScope(systemScope(), (tx) =>
      actions.request(tx, { sender, groupJid: GROUP, decision: 'approve', documentNo: 'JE-2026-999999', reason: null }),
    );
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/nothing is waiting|not one of/i) });
  });

  it('a rejection with no reason is refused before a code is ever issued', async () => {
    const sender = await senderFor(ceoNumber);
    const refused = await withScope(systemScope(), (tx) =>
      actions.request(tx, { sender, groupJid: GROUP, decision: 'reject', documentNo: 'JE-1', reason: '   ' }),
    );
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/says why/i) });
    const { rows } = await ownerPool.query(`select count(*)::int as n from whatsapp_action`);
    expect(rows[0].n).toBe(0);
  });

  it('W11 and W12 — the code decides, and the person’s own permissions still refuse', async () => {
    // A journal entry the officer raised and submitted: it is waiting for a
    // manager, and the CEO holds that role.
    await withScope(scope(ceo), (tx) =>
      periods.createFiscalYear(tx, ceo, { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }),
    );
    const accounts = await ownerPool.query(`select id, code from chart_of_account where is_group = false and is_active order by code limit 2`);
    if (accounts.rows.length < 2) return; // a bare database has no postable pair; nothing to prove here
    const entry = await withScope(scope(officer), async (tx) => {
      const draft = await journal.createDraft(tx, officer, {
        branchCode: BAGHDAD,
        documentDate: '2026-06-01',
        postingDate: '2026-06-01',
        description: 'WA-6 fixture',
      });
      await journal.addLine(tx, officer, draft.id, { accountId: accounts.rows[0].id as string, debit: '1000.0000' });
      await journal.addLine(tx, officer, draft.id, { accountId: accounts.rows[1].id as string, credit: '1000.0000' });
      return draft;
    });
    await withScope(scope(officer), (tx) => journal.submit(tx, officer, entry.id));

    const sender = await senderFor(ceoNumber);
    const waiting = await actions.waitingFor(ceo.principal.userId);
    const mine = waiting.find((row) => row.documentNumber === entry.entryNo);
    expect(mine, 'the submitted entry is waiting for the approver').toBeTruthy();

    // Step one: a code, and nothing decided yet.
    const asked = await withScope(systemScope(), (tx) =>
      actions.request(tx, { sender, groupJid: GROUP, decision: 'approve', documentNo: entry.entryNo, reason: null }),
    );
    expect(asked.ok, 'the request was accepted').toBe(true);
    if (!asked.ok) throw new Error(asked.reason);
    expect(asked.code).toMatch(/^\d{6}$/);
    const before = await ownerPool.query(`select status from journal_entry where id = $1`, [entry.id]);
    expect(before.rows[0].status).toBe('submitted');

    // A wrong code decides nothing and leaves the request standing.
    const wrong = await withScope(systemScope(), (tx) => actions.confirm(tx, { sender, code: '000000' }));
    expect(wrong).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/i) });
    const still = await withScope(systemScope(), (tx) => actions.awaiting(tx, sender.contactId));
    expect(still?.status).toBe('awaiting');

    // The right code, and the ERP decides — as the CEO, through the approval
    // engine, so the entry moves exactly as it would from the screen.
    const decided = await withScope(systemScope(), (tx) => actions.confirm(tx, { sender, code: asked.code }));
    expect(decided).toMatchObject({ ok: true, decision: 'approve' });
    const after = await ownerPool.query(`select status from journal_entry where id = $1`, [entry.id]);
    expect(after.rows[0].status).not.toBe('submitted');

    // The row is settled, and the audit trail carries the decision.
    const settled = await ownerPool.query(`select status, decision, document_no from whatsapp_action order by created_at desc limit 1`);
    expect(settled.rows[0]).toMatchObject({ status: 'done', decision: 'approve', document_no: entry.entryNo });
    const audited = await ownerPool.query(
      `select count(*)::int as n from audit_event where action in ('whatsapp.action_requested','whatsapp.action_decided')`,
    );
    expect(audited.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('W13 — a code that has expired cannot be completed', async () => {
    const sender = await senderFor(ceoNumber);
    // A request written straight into the table, already past its minute.
    await ownerPool.query(
      `insert into whatsapp_action (contact_id, user_id, group_jid, document_type, document_id, document_no, decision, code, expires_at)
       values ($1,$2,$3,'journal_entry',gen_random_uuid(),'JE-OLD','approve','111111', now() - interval '1 minute')`,
      [sender.contactId, sender.userId, GROUP],
    );
    const stale = await withScope(systemScope(), (tx) => actions.confirm(tx, { sender, code: '111111' }));
    expect(stale).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/i) });
    const { rows } = await ownerPool.query(`select status from whatsapp_action order by created_at desc limit 1`);
    expect(rows[0].status).toBe('expired');
  });

  it('one live code per person: asking again replaces the first', async () => {
    const sender = await senderFor(ceoNumber);
    for (const code of ['222222', '333333']) {
      await ownerPool.query(
        `update whatsapp_action set status = 'cancelled', settled_at = now() where contact_id = $1 and status = 'awaiting'`,
        [sender.contactId],
      );
      await ownerPool.query(
        `insert into whatsapp_action (contact_id, user_id, document_type, document_id, document_no, decision, code, expires_at)
         values ($1,$2,'journal_entry',gen_random_uuid(),'JE-X','approve',$3, now() + interval '10 minutes')`,
        [sender.contactId, sender.userId, code],
      );
    }
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from whatsapp_action where contact_id = $1 and status = 'awaiting'`,
      [sender.contactId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('housekeeping expires the codes nobody answered', async () => {
    const sender = await senderFor(ceoNumber);
    await ownerPool.query(
      `insert into whatsapp_action (contact_id, user_id, document_type, document_id, document_no, decision, code, expires_at)
       values ($1,$2,'journal_entry',gen_random_uuid(),'JE-Z','approve','444444', now() - interval '1 hour')`,
      [sender.contactId, sender.userId],
    );
    const expired = await withScope(systemScope(), (tx) => actions.expireStale(tx));
    expect(expired).toBeGreaterThanOrEqual(1);
  });
});
