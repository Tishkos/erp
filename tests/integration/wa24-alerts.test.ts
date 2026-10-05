/**
 * The ERP's own alerts in the WhatsApp group — who is told, read from a real
 * database (`services/whatsapp-alerts.ts`), and the two tools Noah reads the
 * same things with when somebody asks him about one.
 *
 * By direction (2026-10-05): "let Tishko know in the WhatsApp group and tag
 * them — you have notifications … automatically". The wording, the quiet
 * hours and the exception in the bridge are held in `tests/unit/wa24-alerts`;
 * here it is the reading: a notification belongs to its recipient at the
 * database (C-70), so this is the proof that the sweep reads exactly the
 * people who are to be told — and that nobody reads anybody else's by asking.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { businessToday } from '@/server/domain/business-date';
import { DEFAULT_SETTINGS } from '@/server/domain/whatsapp';
import { alertMessage, byRecipient } from '@/server/domain/whatsapp-alerts';
import * as audit from '@/server/services/audit';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as notifications from '@/server/services/notifications';
import * as wa from '@/server/services/whatsapp';
import { toolRunnerFor } from '@/server/services/whatsapp-agent';
import * as alerts from '@/server/services/whatsapp-alerts';

const BAGHDAD = 'BGW';

let admin: ActorContext;
let shene: ActorContext;
let zhyar: ActorContext;
let diana: ActorContext;
let gone: ActorContext;

async function createUser(roles: string, name: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles.split('+')) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const systemScope = () => ({ userId: admin.principal.userId, branchCode: '', isSuperUser: true });

/** Tell these people one thing, as the platform does (`emit`: no rule, so no delivery rows). */
const tell = (who: readonly ActorContext[], kind: string, subject: string, body = '', context: Record<string, unknown> = {}) =>
  withScope(scope(admin), (tx) =>
    notifications.emit(tx, {
      kind,
      objectType: 'task',
      objectId: randomUUID(),
      recipients: who.map((one) => one.principal.userId),
      subject,
      body,
      context,
      occurrence: randomUUID(),
      actorUserId: admin.principal.userId,
    }),
  );

const tool = (ctx: ActorContext, name: string, args: Record<string, unknown> = {}) =>
  wa
    .withReadOnlyScope({ userId: ctx.principal.userId, branchCode: BAGHDAD, isSuperUser: ctx.principal.isSuperUser }, (tx) =>
      toolRunnerFor({ tx, principal: ctx.principal, branchCode: BAGHDAD, locale: 'en', settings: DEFAULT_SETTINGS, today: businessToday() }, [], undefined, { userName: 'Tester', chat: 'test' })(name, args),
    )
    .then((outcome) => outcome.text);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  admin = await createUser('system_administrator', 'The Administrator');
  shene = await createUser('accounting_officer', 'Shene');
  zhyar = await createUser('accounting_officer', 'Zhyar');
  diana = await createUser('accounting_officer', 'Diana');
  gone = await createUser('accounting_officer', 'Somebody Who Left');
  const contact = (who: ActorContext, e164: string, allowNotifications: boolean) =>
    withScope(scope(admin), (tx) => wa.saveContact(tx, admin, { userId: who.principal.userId, e164, allowNotifications, allowQueries: true, allowDigest: false }));
  await contact(shene, '+9647701929191', true);
  // Zhyar has a number on file and has notifications switched OFF on it; Diana has no number at all.
  await contact(zhyar, '+9647507539005', false);
  await contact(gone, '+9647700000009', true);
  await ownerPool.query(`update app_user set is_active = false where id = $1`, [gone.principal.userId]);
});

describe('who the group is told about', () => {
  it('only somebody with a contact that allows notifications, who is still a user — and only what they have not read', async () => {
    await tell([shene, zhyar, diana, gone], 'task.assigned', 'Task TASK-2026-000001 was assigned to you', 'Call the bank', { taskNo: 'TASK-2026-000001', title: 'Call the bank' });
    await tell([shene], 'chat.message', 'Zhyar', 'the words of a private message', { senderName: 'Zhyar' });

    const batch = await alerts.pending(systemScope(), { after: 0n });
    expect(batch.rows.map((row) => [row.displayName, row.kind, row.e164])).toEqual([
      ['Shene', 'task.assigned', '+9647701929191'],
      ['Shene', 'chat.message', '+9647701929191'],
    ]);
    expect(batch.rows[0]).toMatchObject({ subject: 'Task TASK-2026-000001 was assigned to you', body: 'Call the bank', context: { taskNo: 'TASK-2026-000001', title: 'Call the bank' }, recipientUserId: shene.principal.userId });
    expect(batch.rows[0]!.createdAt).toBeInstanceOf(Date);
    // The newest there is — Diana's and Zhyar's included: the mark passes over what nobody is told of.
    const { rows: newest } = await ownerPool.query(`select max(id)::text as head from notification`);
    expect(batch.head).toBe(BigInt(newest[0].head));
    expect(batch.full).toBe(false);
    expect(alerts.markAfter(batch)).toBe(batch.head);

    // As one alert: her tag, both lines, and not one word of the chat message.
    const [mine] = [...byRecipient(batch.rows).values()];
    const said = alertMessage({ tag: '@9647701929191', rows: mine!, words: alerts.kindWords('en'), locale: 'en', appUrl: 'https://erp.example' });
    expect(said).toMatch(/^@9647701929191 🔔 \*You have 2 new notifications in the ERP\*/);
    expect(said).toMatch(/Task TASK-2026-000001 was assigned to you — Call the bank/);
    expect(said).toMatch(/New message in Chat from Zhyar/);
    expect(said).not.toMatch(/private message/);

    // Read in the application before the sweep comes round: there is nothing left to tell her.
    await ownerPool.query(`update notification set read_at = now() where recipient_user_id = $1 and event_type = 'task.assigned'`, [shene.principal.userId]);
    expect((await alerts.pending(systemScope(), { after: 0n })).rows.map((row) => row.kind)).toEqual(['chat.message']);
  });

  it('tells each thing once: nothing at or before the mark, and a cut batch stops the mark where it stopped', async () => {
    await tell([shene], 'task.assigned', 'first');
    const first = await alerts.pending(systemScope(), { after: 0n });
    expect(first.rows).toHaveLength(1);
    expect((await alerts.pending(systemScope(), { after: alerts.markAfter(first) })).rows).toEqual([]);

    await tell([shene], 'task.due_soon', 'second');
    await tell([shene], 'task.overdue', 'third');
    const next = await alerts.pending(systemScope(), { after: alerts.markAfter(first) });
    expect(next.rows.map((row) => row.subject)).toEqual(['second', 'third']);

    const cut = await alerts.pending(systemScope(), { after: alerts.markAfter(first), limit: 1 });
    expect(cut.rows.map((row) => row.subject)).toEqual(['second']);
    expect(cut.full).toBe(true);
    expect(alerts.markAfter(cut)).toBe(BigInt(cut.rows[0]!.id));
    expect((await alerts.pending(systemScope(), { after: alerts.markAfter(cut) })).rows.map((row) => row.subject)).toEqual(['third']);
  });

  it('is the sweep that reads them: asked as a person, nobody sees a notification that is not theirs', async () => {
    await tell([shene], 'task.assigned', 'for Shene only');
    const seenBy = async (who: ActorContext) =>
      withScope(scope(who), async (tx) => (await notifications.inboxFor(tx, shene.principal.userId)).length);
    expect(await seenBy(shene)).toBe(1);
    expect(await seenBy(zhyar)).toBe(0);
    expect(await seenBy(admin)).toBe(0);
  });
});

describe('asked about it, Noah reads the asker\'s own', () => {
  it('my_notifications lists theirs with the time and the way to open each, and nobody else\'s', async () => {
    await tell([shene], 'task.assigned', 'Task TASK-2026-000001 was assigned to you', 'Call the bank');
    await tell([zhyar], 'task.assigned', 'Task TASK-2026-000002 was assigned to you', 'Count the stock');

    const hers = await tool(shene, 'my_notifications');
    expect(hers).toMatch(/^1 unread notification\(s\) for this person, newest first/);
    expect(hers).toMatch(/• \d\d \w{3} \d\d:\d\d — Task TASK-2026-000001 was assigned to you — Call the bank \[task\.assigned, unread\] · opens at \S+\/notifications\/open\/\d+/);
    expect(hers).not.toMatch(/TASK-2026-000002|Count the stock/);
    expect(await tool(zhyar, 'my_notifications')).toMatch(/TASK-2026-000002/);
    expect(await tool(diana, 'my_notifications')).toMatch(/^They have no unread notifications\./);

    // It marks nothing as read: asking again says the same.
    expect(await tool(shene, 'my_notifications')).toBe(hers);
    await ownerPool.query(`update notification set read_at = now() where recipient_user_id = $1`, [shene.principal.userId]);
    expect(await tool(shene, 'my_notifications')).toMatch(/^They have no unread notifications\./);
    expect(await tool(shene, 'my_notifications', { unread: false })).toMatch(/\[task\.assigned, read\]/);
  });

  it('my_tasks answers for the Task Center as they see it — an empty list, and a number that is not theirs to open', async () => {
    expect(await tool(shene, 'my_tasks')).toMatch(/^No tasks in "mine" \/ "open" for this person\./);
    expect(await tool(shene, 'my_tasks', { view: 'assigned', bucket: 'overdue' })).toMatch(/^No tasks in "assigned" \/ "overdue"/);
    expect(await tool(shene, 'my_tasks', { task: 'task-2026-999999' })).toMatch(/^There is no task TASK-2026-999999 that this person may open\./);
  });
});

describe('a decision on what somebody raised is told to the person who raised it', () => {
  /** One row of the trail, written as the services write it. */
  const trail = (who: ActorContext, action: string, objectType: string, objectId: string, extra: { after?: Record<string, unknown>; reason?: string } = {}) =>
    withScope(scope(who), (tx) =>
      audit.record(tx, {
        actorUserId: who.principal.userId,
        action,
        objectType,
        objectId,
        branchCode: BAGHDAD,
        outcome: 'success',
        ...(extra.after ? { after: extra.after } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      }),
    );
  const startOfTrail = async () => BigInt((await ownerPool.query(`select coalesce(max(id), 0)::text as head from audit_event`)).rows[0].head);

  it('approved, rejected, returned or posted by somebody else — with who decided, the number, and the reason of a refusal', async () => {
    const from = await startOfTrail();
    const application = randomUUID();
    const journal = randomUUID();
    const account = randomUUID();
    const receipt = randomUUID();
    await trail(shene, 'payment_application.created', 'payment_application', application);
    await trail(shene, 'payment_application.submitted', 'payment_application', application);
    await trail(admin, 'payment_application.approved', 'payment_application', application, { after: { applicationNo: 'PAP-BGW-2026-000003', status: 'approved' } });
    await trail(shene, 'journal_entry.created', 'journal_entry', journal, { after: { entryNo: 'JE-2026-000012' } });
    await trail(admin, 'journal_entry.rejected', 'journal_entry', journal, { after: { entryNo: 'JE-2026-000012' }, reason: 'the rent is charged to the wrong department' });
    await trail(shene, 'partner_bank_account.created', 'partner_bank_account', account);
    await trail(admin, 'partner_bank_account.returned', 'partner_bank_account', account, { reason: 'IBAN missing' });
    await trail(shene, 'customer_receipt.created', 'customer_receipt', receipt);
    await trail(admin, 'customer_receipt.posted', 'customer_receipt', receipt, { after: { receiptNo: 'RCT-BGW-2026-000004' } });

    const batch = await alerts.pendingDecisions(systemScope(), { after: from });
    expect(batch.rows.map((row) => [row.displayName, row.action, row.reference, row.actorName, row.reason])).toEqual([
      ['Shene', 'payment_application.approved', 'PAP-BGW-2026-000003', 'The Administrator', null],
      ['Shene', 'journal_entry.rejected', 'JE-2026-000012', 'The Administrator', 'the rent is charged to the wrong department'],
      ['Shene', 'partner_bank_account.returned', null, 'The Administrator', 'IBAN missing'],
      ['Shene', 'customer_receipt.posted', 'RCT-BGW-2026-000004', 'The Administrator', null],
    ]);
    expect(batch.rows.every((row) => row.e164 === '+9647701929191' && row.recipientUserId === shene.principal.userId)).toBe(true);
    expect(batch.full).toBe(false);
    expect(alerts.markAfter(batch)).toBe(batch.head);

    // As her alert: four lines, each with who and what, and what to type about the refusal.
    const said = alertMessage({ tag: '@9647701929191', rows: [], decisions: batch.rows, words: alerts.kindWords('en'), locale: 'en', appUrl: 'https://erp.example' });
    expect(said).toMatch(/✅ The Administrator approved your payment application PAP-BGW-2026-000003/);
    expect(said).toMatch(/❌ The Administrator rejected your journal entry JE-2026-000012 — reason: the rent is charged to the wrong department/);
    expect(said).toMatch(/↩️ The Administrator returned your partner bank account for changes — reason: IBAN missing/);
    expect(said).toMatch(/📗 The Administrator posted your customer receipt RCT-BGW-2026-000004/);
    expect(said).toMatch(/Ask me: \*!ai why was JE-2026-000012 rejected\*/);

    // Told once: nothing after the mark.
    expect((await alerts.pendingDecisions(systemScope(), { after: alerts.markAfter(batch) })).rows).toEqual([]);
  });

  it('not their own decision, not somebody who is not told, not the business of HR — and not twice what the application already told them', async () => {
    const from = await startOfTrail();
    // Her own approval of her own document.
    const own = randomUUID();
    await trail(shene, 'opening_stock.created', 'opening_stock', own);
    await trail(shene, 'opening_stock.approved', 'opening_stock', own);
    // Raised by somebody with notifications off, by somebody with no number, by somebody who left.
    for (const maker of [zhyar, diana, gone]) {
      const id = randomUUID();
      await trail(maker, 'purchase_order.created', 'purchase_order', id);
      await trail(admin, 'purchase_order.approved', 'purchase_order', id);
    }
    // A payroll run: private.
    const run = randomUUID();
    await trail(shene, 'payroll_run.created', 'payroll_run', run);
    await trail(admin, 'payroll_run.approved', 'payroll_run', run);
    // Already told by the application: the approval workflow has said "Approved: …" about the same record.
    const told = randomUUID();
    await trail(shene, 'journal_entry.created', 'journal_entry', told);
    await withScope(scope(admin), (tx) =>
      notifications.emit(tx, { kind: 'approval.completed', objectType: 'journal_entry', objectId: told, recipients: [shene.principal.userId], subject: 'Approved: JE-2026-000020', occurrence: randomUUID(), actorUserId: admin.principal.userId }),
    );
    await trail(admin, 'journal_entry.approved', 'journal_entry', told);
    // A thing nobody is recorded as having raised, and an action that is no decision.
    await trail(admin, 'cash_count.approved', 'cash_count', randomUUID());
    await trail(admin, 'task.accepted', 'task', own);

    expect((await alerts.pendingDecisions(systemScope(), { after: from })).rows).toEqual([]);
  });

  it('who submitted it last is who is told, and a cut batch stops the mark at the last row it read', async () => {
    const from = await startOfTrail();
    const invoice = randomUUID();
    // Zhyar created it; Shene is the one who sent it for approval.
    await trail(zhyar, 'ap_invoice.created', 'ap_invoice', invoice, { after: { invoiceNo: 'API-BGW-2026-000001' } });
    await trail(shene, 'ap_invoice.submitted', 'ap_invoice', invoice);
    await trail(admin, 'ap_invoice.posted', 'ap_invoice', invoice, { after: { invoiceNo: 'API-BGW-2026-000001' } });
    const other = randomUUID();
    await trail(shene, 'goods_return.created', 'goods_return', other);
    await trail(admin, 'goods_return.approved', 'goods_return', other);

    const cut = await alerts.pendingDecisions(systemScope(), { after: from, limit: 1 });
    expect(cut.rows.map((row) => [row.displayName, row.action, row.reference])).toEqual([['Shene', 'ap_invoice.posted', 'API-BGW-2026-000001']]);
    expect(cut.full).toBe(true);
    expect(alerts.markAfter(cut)).toBe(cut.last);
    expect(cut.last).toBeLessThan(cut.head);
    expect((await alerts.pendingDecisions(systemScope(), { after: alerts.markAfter(cut) })).rows.map((row) => row.action)).toEqual(['goods_return.approved']);
  });
});

describe('the day, as one person has it', () => {
  it('is counted as that person — nothing due is nothing said — and nobody who has left is counted', async () => {
    expect(await alerts.dayOf(shene.principal.userId, businessToday())).toEqual({ dueToday: 0, overdue: 0, toReview: 0, approvals: 0 });
    expect(await alerts.dayOf(gone.principal.userId, businessToday())).toBeNull();
    expect((await alerts.alertContacts(systemScope())).map((one) => [one.displayName, one.e164])).toEqual([['Shene', '+9647701929191']]);
  });
});
