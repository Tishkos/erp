/**
 * The ERP's own alerts in the WhatsApp group — `domain/whatsapp-alerts.ts`,
 * the marks in `services/whatsapp-alerts.ts`, and the one exception they are
 * to "he speaks only when called".
 *
 * By direction (2026-10-05): "let Tishko know in the WhatsApp group and tag
 * them — you have notifications, date, time and a short summary … task due,
 * task alert … automatically … when what a user requested is approved, let
 * them know too … nicely, very interactive … it is so important, tag the
 * person."
 *
 * No database and no WhatsApp here: what an alert says and does not say, when
 * it waits, how the marks are kept, and — read from the source — that the
 * exception is exactly as wide as it was asked to be.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@domain/whatsapp';
import {
  ALERT_LINE_MAX,
  ALERT_MAX_LINES,
  alertLine,
  alertMessage,
  alertTime,
  briefHour,
  briefLine,
  byRecipient,
  decisionLine,
  decisionOf,
  fill,
  hintsFor,
  iconOf,
  isPrivateObject,
  morningBrief,
  quietNow,
  referenceOf,
  splitShared,
  teamMessage,
  type AlertRow,
  type DecisionRow,
  type KindWords,
} from '@domain/whatsapp-alerts';
import { kindWords, markAfter, readMarks, writeMarks } from '@/server/services/whatsapp-alerts';

const at = new Date('2026-10-05T11:05:00Z'); // 14:05 in Baghdad
const row = (over: Partial<AlertRow> = {}): AlertRow => ({
  id: '1',
  kind: 'task.assigned',
  subject: 'Task TASK-2026-000007 was assigned to you',
  body: 'Call the bank about the loan renewal',
  objectId: 'a3f0',
  context: { taskNo: 'TASK-2026-000007', title: 'Call the bank about the loan renewal' },
  createdAt: at,
  ...over,
});
const decision = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: '90',
  action: 'payment_application.approved',
  objectType: 'payment_application',
  reference: 'PAP-HQ-2026-000003',
  actorName: 'Tishko',
  reason: null,
  occurredAt: new Date('2026-10-05T11:07:00Z'),
  ...over,
});
const WORDS: KindWords = {
  task_assigned: { title: 'Task {ref} was assigned to you', detail: '{name}' },
  ar_invoice_overdue: { title: '{count, plural, one {An invoice is} other {# invoices are}} overdue' },
};

describe('what one line of an alert says', () => {
  it('the day and the time by the books\' clock, a sign for its kind, the bell\'s own title, and the short detail', () => {
    expect(alertTime(at, 'en')).toBe('05 Oct 14:05');
    expect(alertLine(row(), WORDS, 'en')).toBe('05 Oct 14:05 — 📌 Task TASK-2026-000007 was assigned to you — Call the bank about the loan renewal');
    // The catalogue in the group's language, where it has the kind.
    expect(alertLine(row(), kindWords('ar'), 'ar')).toMatch(/📌 أُسندت إليك المهمة TASK-2026-000007 — Call the bank about the loan renewal$/);
    expect(alertLine(row(), kindWords('ar'), 'ar')).toMatch(/^05 .+ 14:05 — /);
  });

  it('a sign per kind, so a list is read at a glance', () => {
    expect(['task.assigned', 'task.due_soon', 'task.overdue', 'task.completed', 'task.blocked', 'task.submitted', 'task.returned'].map(iconOf)).toEqual(['📌', '⏰', '🔴', '✅', '⛔', '📝', '📋']);
    expect(['approval.required', 'approval.completed', 'approval.rejected', 'journal_entry.submitted', 'journal_entry.rejected'].map(iconOf)).toEqual(['✍️', '✅', '❌', '✍️', '❌']);
    expect(['chat.message', 'hr.leave_approved', 'exception.inventory', 'ap_invoice.overdue', 'supplier_payment.made', 'container.late', 'document.linked', 'system.health'].map(iconOf)).toEqual(['💬', '👤', '⚠️', '🧾', '💵', '🚢', '📎', '🛠']);
  });

  it('with no label for its kind — or one that needs more than names — it is the text it was raised with', () => {
    expect(alertLine(row({ kind: 'task.returned', subject: 'Task TASK-2026-000007 was returned for more work', body: 'Add the bank\'s letter' }), WORDS, 'en')).toBe(
      '05 Oct 14:05 — 📋 Task TASK-2026-000007 was returned for more work — Add the bank\'s letter',
    );
    expect(fill('{count, plural, one {An invoice is} other {# invoices are}} overdue', row())).toBeNull();
    expect(alertLine(row({ kind: 'ar_invoice.overdue', subject: '3 invoices are overdue', body: '' }), WORDS, 'en')).toBe('05 Oct 14:05 — 🧾 3 invoices are overdue');
    // A label whose fact is missing is not printed with a hole in it.
    expect(fill('Task {ref} was assigned by {actor}', row())).toBeNull();
    expect(fill('Task {ref}', row({ context: null }))).toBe('Task a3f0');
  });

  it('a group is not a private inbox: a chat message is announced without its words, an HR notice without its content', () => {
    const chat = alertLine(row({ kind: 'chat.message', subject: 'Shene', body: 'the salary list is wrong, look at row 4', context: { senderName: 'Shene' } }), WORDS, 'en');
    expect(chat).toBe('05 Oct 14:05 — 💬 New message in Chat from Shene');
    expect(alertLine(row({ kind: 'chat.mention', subject: 'Finance', body: 'secret', context: { senderName: 'Zhyar' } }), WORDS, 'en')).toBe('05 Oct 14:05 — 💬 You were mentioned in Chat from Zhyar');
    expect(alertLine(row({ kind: 'chat.message', subject: 'x', body: 'secret', context: null }), WORDS, 'ar')).toMatch(/رسالة جديدة في المحادثات$/);
    for (const kind of ['hr.leave_approved', 'hr.payslip_ready', 'hr.advance_refused']) {
      const said = alertLine(row({ kind, subject: 'Your leave of 5 days was approved', body: 'salary 1,500,000' }), WORDS, 'en');
      expect(said, kind).toBe('05 Oct 14:05 — 👤 An HR notice (open it in the ERP)');
    }
  });

  it('never runs longer than a line', () => {
    const long = alertLine(row({ kind: 'task.updated', subject: 'x'.repeat(400), body: 'y'.repeat(400) }), WORDS, 'en');
    expect(long.length).toBeLessThanOrEqual(ALERT_LINE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('a decision on what somebody raised', () => {
  it('says who decided, what, on which document — and the reason of a refusal', () => {
    expect(decisionLine(decision(), 'en')).toBe('05 Oct 14:07 — ✅ Tishko approved your payment application PAP-HQ-2026-000003');
    expect(decisionLine(decision({ action: 'journal_entry.rejected', objectType: 'journal_entry', reference: 'JE-2026-000012', reason: '  the rent is charged to the wrong department  ' }), 'en')).toBe(
      '05 Oct 14:07 — ❌ Tishko rejected your journal entry JE-2026-000012 — reason: the rent is charged to the wrong department',
    );
    expect(decisionLine(decision({ action: 'partner_bank_account.returned', objectType: 'partner_bank_account', reference: null, reason: 'IBAN missing' }), 'en')).toBe(
      '05 Oct 14:07 — ↩️ Tishko returned your partner bank account for changes — reason: IBAN missing',
    );
    expect(decisionLine(decision({ action: 'customer_receipt.posted', objectType: 'customer_receipt', reference: 'RCT-HQ-2026-000004', reason: 'not shown for a posting' }), 'en')).toBe(
      '05 Oct 14:07 — 📗 Tishko posted your customer receipt RCT-HQ-2026-000004',
    );
    expect(decisionLine(decision(), 'ar')).toMatch(/✅ تمت الموافقة على ما قدّمته: payment application PAP-HQ-2026-000003 — Tishko$/);
    expect(decisionLine(decision({ action: 'journal_entry.rejected', reason: 'x' }), 'ar')).toMatch(/❌ رُفض ما قدّمته: .+ — السبب: x$/);
  });

  it('reads the decision off the audit action, and nothing that is not one', () => {
    expect(['opening_stock.approved', 'journal_entry.rejected', 'landed_cost.returned', 'goods_receipt.posted'].map(decisionOf)).toEqual(['approved', 'rejected', 'returned', 'posted']);
    expect(['task.accepted', 'ap_invoice.submitted', 'whatsapp.screenshot', 'approved'].map(decisionOf)).toEqual([null, null, null, 'approved']);
  });

  it('finds the number a person knows the record by, and never shows an internal id', () => {
    expect(referenceOf({ invoiceNo: 'API-HQ-2026-000005', status: 'posted' }, null, '7c0e1c1e-0000-4000-8000-000000000000')).toBe('API-HQ-2026-000005');
    expect(referenceOf(null, { documentNo: 'OPN-HQ-2026-000001' }, null)).toBe('OPN-HQ-2026-000001');
    expect(referenceOf({ status: 'approved' }, null, 'JE-2026-000012')).toBe('JE-2026-000012');
    expect(referenceOf({ status: 'approved' }, null, '7c0e1c1e-0000-4000-8000-000000000000')).toBeNull();
    expect(referenceOf({ reference: '7c0e1c1e-0000-4000-8000-000000000000' }, null, null)).toBeNull();
    expect(referenceOf(null, null, '12345')).toBeNull();
  });

  it('HR\'s documents are nobody\'s business in a group', () => {
    for (const type of ['payroll_run', 'employee_advance', 'leave_request', 'performance_review', 'applicant', 'vacancy']) expect(isPrivateObject(type), type).toBe(true);
    for (const type of ['payment_application', 'journal_entry', 'opening_stock', 'purchase_order']) expect(isPrivateObject(type), type).toBe(false);
  });
});

describe('the alert for one person', () => {
  const tasks = (count: number) => Array.from({ length: count }, (_, index) => row({ id: String(index + 1), body: `job ${index + 1}`, context: { taskNo: `TASK-${index + 1}`, title: `job ${index + 1}` } }));
  const message = (count: number, locale: 'en' | 'ar' = 'en') => alertMessage({ tag: '@9647701929191', rows: tasks(count), words: WORDS, locale, appUrl: 'https://erp.example' });

  it('starts with their tag, says how many, lists them, says where to open them — and what to type to ask', () => {
    const one = message(1).split('\n');
    expect(one[0]).toBe('@9647701929191 🔔 *You have a new notification in the ERP*');
    expect(one[1]).toBe('• 05 Oct 14:05 — 📌 Task TASK-1 was assigned to you — job 1');
    expect(one[2]).toBe('Open them: https://erp.example/notifications');
    expect(one[3]).toBe('Ask me: *!ai explain TASK-1* · *!ai my tasks*');
    expect(one[4]).toBe('_Automatic alert from the ERP._');
    expect(message(3).split('\n')[0]).toBe('@9647701929191 🔔 *You have 3 new notifications in the ERP*');
    expect(message(2, 'ar').split('\n')[0]).toBe('@9647701929191 🔔 *لديك 2 إشعارات جديدة في النظام*');
    expect(message(1, 'ar')).toMatch(/اسألني: \*!ai اشرح TASK-1\* · \*!ai شنو مهامي\*/);
  });

  it('puts a notification and a decision in one message, in the order they happened', () => {
    const said = alertMessage({ tag: '@1', rows: tasks(1), decisions: [decision()], words: WORDS, locale: 'en', appUrl: 'https://erp.example' }).split('\n');
    expect(said[0]).toBe('@1 🔔 *You have 2 new notifications in the ERP*');
    expect(said[1]).toContain('📌 Task TASK-1 was assigned to you');
    expect(said[2]).toBe('• 05 Oct 14:07 — ✅ Tishko approved your payment application PAP-HQ-2026-000003');
  });

  it('what to type follows what is in it: the task named, the thing refused, what waits on them', () => {
    expect(hintsFor(tasks(2), [], 'en')).toEqual(['!ai explain TASK-2', '!ai my tasks']);
    expect(hintsFor([], [decision({ action: 'journal_entry.rejected', reference: 'JE-2026-000012' })], 'en')).toEqual(['!ai why was JE-2026-000012 rejected']);
    expect(hintsFor([row({ kind: 'approval.required', context: { reference: 'API-HQ-2026-000005' } })], [], 'en')).toEqual(['!ai what is waiting for my approval']);
    expect(hintsFor([row({ kind: 'chat.message', context: null })], [], 'en')).toEqual(['!ai my notifications']);
    expect(hintsFor([], [decision()], 'ar')).toEqual(['!ai شنو إشعاراتي']);
    // Never more than three, whatever is in it.
    expect(hintsFor([...tasks(1), row({ kind: 'approval.required' })], [decision({ action: 'x.returned', reference: 'R-1' })], 'en')).toHaveLength(3);
  });

  it('is one message however many there are: the newest few, and the rest counted', () => {
    const many = message(40).split('\n');
    expect(many.filter((line) => line.startsWith('• '))).toHaveLength(ALERT_MAX_LINES);
    expect(many[1]).toBe(`… ${40 - ALERT_MAX_LINES} earlier, and:`);
    expect(many[2]).toContain('TASK-35');
    expect(many.at(-4)).toContain('TASK-40');
    expect(message(40).length).toBeLessThan(1_900);
  });

  it('groups a batch by the person it is for, each person\'s in the order they were raised', () => {
    const rows = [
      { id: '12', recipientUserId: 'b' },
      { id: '9', recipientUserId: 'a' },
      { id: '100', recipientUserId: 'a' },
      { id: '11', recipientUserId: 'b' },
    ];
    const grouped = byRecipient(rows);
    expect([...grouped.keys()]).toEqual(['a', 'b']);
    expect(grouped.get('a')!.map((one) => one.id)).toEqual(['9', '100']);
    expect(grouped.get('b')!.map((one) => one.id)).toEqual(['11', '12']);
  });
});

describe('what was raised for several people at once is said once', () => {
  const to = (recipientUserId: string, over: Partial<AlertRow> = {}) => ({ ...row(over), recipientUserId });

  it('the same notice to three people or more is for the team; anything else stays with the person it is for', () => {
    const health = { kind: 'system.health', objectId: 'health-2026-10-06', subject: 'System health needs attention', context: null };
    const rows = [
      to('a', { id: '1', ...health }),
      to('b', { id: '2', ...health }),
      to('c', { id: '3', ...health }),
      to('a', { id: '4' }), // her own task
      to('a', { id: '5', kind: 'ap_invoice.overdue', objectId: 'inv-1', subject: 'Invoice API-1 is overdue', context: null }),
      to('b', { id: '6', kind: 'ap_invoice.overdue', objectId: 'inv-1', subject: 'Invoice API-1 is overdue', context: null }), // two people: not the team's
    ];
    const { personal, shared } = splitShared(rows);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.row.kind).toBe('system.health');
    expect(shared[0]!.recipients).toEqual(['a', 'b', 'c']);
    expect(personal.map((one) => one.id)).toEqual(['4', '5', '6']);
    // Nothing is lost and nothing is said twice.
    expect(personal.length + shared.reduce((sum, one) => sum + one.recipients.length, 0)).toBe(rows.length);
    expect(splitShared(rows, 2).shared.map((one) => one.row.kind)).toEqual(['system.health', 'ap_invoice.overdue']);
  });

  it('one message, everybody it concerns tagged on one line, each notice once', () => {
    const said = teamMessage({
      tags: ['@111', '@222', '@333'],
      rows: [row({ kind: 'system.health', subject: 'System health needs attention', body: 'restore drill failed', context: null })],
      words: WORDS,
      locale: 'en',
      appUrl: 'https://erp.example',
    }).split('\n');
    expect(said).toEqual([
      '📣 *For the team — new in the ERP*',
      '@111 @222 @333',
      '• 05 Oct 14:05 — 🛠 System health needs attention — restore drill failed',
      'Open them: https://erp.example/notifications',
      '_Automatic alert from the ERP._',
    ]);
    expect(teamMessage({ tags: ['@1'], rows: [row()], words: WORDS, locale: 'ar', appUrl: 'x' }).split('\n')[0]).toBe('📣 *للفريق — جديد في النظام*');
  });
});

describe('the morning note', () => {
  const none = { dueToday: 0, overdue: 0, toReview: 0, approvals: 0 };

  it('is one message: a line for each person with something today, and nobody else', () => {
    const said = morningBrief({
      day: 'Mon 05 Oct',
      locale: 'en',
      people: [
        { tag: '@111', counts: { dueToday: 2, overdue: 1, toReview: 0, approvals: 3 } },
        { tag: '@222', counts: none },
        { tag: '@333', counts: { ...none, toReview: 1 } },
      ],
    })!.split('\n');
    expect(said).toEqual([
      '☀️ *Good morning — your day in the ERP* (Mon 05 Oct)',
      '@111 — 🔴 1 overdue · ⏰ 2 due today · ✍️ 3 waiting for your approval',
      '@333 — 📝 1 to review',
      'Ask me: *!ai my tasks* · *!ai what is waiting for my approval*',
      '_Automatic morning note from the ERP._',
    ]);
    expect(briefLine('@1', { dueToday: 1, overdue: 0, toReview: 0, approvals: 0 }, 'ar')).toBe('@1 — ⏰ 1 مهمة موعدها اليوم');
  });

  it('a morning with nothing in it says nothing', () => {
    expect(morningBrief({ day: 'Mon 05 Oct', locale: 'en', people: [{ tag: '@1', counts: none }] })).toBeNull();
    expect(morningBrief({ day: 'Mon 05 Oct', locale: 'ar', people: [] })).toBeNull();
  });
});

describe('not at night, and good morning only in the morning', () => {
  const baghdad = (hour: number) => new Date(Date.UTC(2026, 9, 5, hour - 3, 30));

  it('alerts wait from ten at night to seven in the morning, by Baghdad\'s clock', () => {
    for (const hour of [22, 23, 24, 25, 28, 30]) expect(quietNow(baghdad(hour)), String(hour % 24)).toBe(true);
    for (const hour of [7, 8, 12, 17, 21]) expect(quietNow(baghdad(hour)), String(hour)).toBe(false);
  });

  it('the morning note is said between eight and noon: a bridge that comes up at four does not say good morning', () => {
    for (const hour of [8, 9, 11]) expect(briefHour(baghdad(hour)), String(hour)).toBe(true);
    for (const hour of [0, 6, 7, 12, 16, 23]) expect(briefHour(baghdad(hour)), String(hour)).toBe(false);
  });
});

describe('the marks of what has been told', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-alerts-'));
  const was = process.env.NOAH_ALERTS_FILE;
  beforeEach(() => {
    process.env.NOAH_ALERTS_FILE = join(dir, 'alerts.json');
  });
  afterEach(() => {
    if (was === undefined) delete process.env.NOAH_ALERTS_FILE;
    else process.env.NOAH_ALERTS_FILE = was;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('are nothing until alerts have run once; each is moved on its own and the others are kept', () => {
    rmSync(join(dir, 'alerts.json'), { force: true });
    expect(readMarks()).toEqual({ toldUpTo: null, decidedUpTo: null, briefDay: null });
    writeMarks({ toldUpTo: 41n, decidedUpTo: 900n }, new Date('2026-10-05T11:00:00Z'));
    expect(readMarks()).toEqual({ toldUpTo: 41n, decidedUpTo: 900n, briefDay: null });
    expect(JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8'))).toEqual({ toldUpTo: '41', decidedUpTo: '900', briefDay: null, at: '2026-10-05T11:00:00.000Z' });
    writeMarks({ briefDay: '2026-10-05' });
    expect(readMarks()).toEqual({ toldUpTo: 41n, decidedUpTo: 900n, briefDay: '2026-10-05' });
    writeMarks({ toldUpTo: 50n });
    expect(readMarks()).toEqual({ toldUpTo: 50n, decidedUpTo: 900n, briefDay: '2026-10-05' });
  });

  it('a file somebody damaged is "never run", which tells nothing old: it does not flood the group', () => {
    writeFileSync(join(dir, 'alerts.json'), '{ not json');
    expect(readMarks()).toEqual({ toldUpTo: null, decidedUpTo: null, briefDay: null });
    writeFileSync(join(dir, 'alerts.json'), JSON.stringify({ toldUpTo: 'DROP TABLE', decidedUpTo: 12, briefDay: 'yesterday' }));
    expect(readMarks()).toEqual({ toldUpTo: null, decidedUpTo: null, briefDay: null });
  });

  it('a mark moves to the newest there is — or, when a batch was cut, only as far as was read', () => {
    const rows = [{ id: '45' }, { id: '50' }];
    expect(markAfter({ rows, head: 90n, full: false })).toBe(90n);
    expect(markAfter({ rows, head: 90n, full: true })).toBe(50n);
    expect(markAfter({ rows: [], head: 90n, full: false })).toBe(90n);
    // Decisions say themselves how far the audit trail was read, whether or not a row made an alert.
    expect(markAfter({ rows: [], head: 90n, full: true, last: 70n })).toBe(70n);
  });
});

describe('the one exception to "he speaks only when called" is as wide as it was asked to be, and no wider', () => {
  const bridge = readFileSync('scripts/ops/whatsapp-bridge.ts', 'utf8');
  const service = readFileSync('src/server/services/whatsapp-alerts.ts', 'utf8');
  const domain = readFileSync('src/server/domain/whatsapp-alerts.ts', 'utf8');
  const alerts = bridge.slice(bridge.indexOf('async function sendAlerts('), bridge.indexOf('async function sendDigest('));

  it('is off unless the owner switches Group notifications on — the alerts and the morning note alike', () => {
    expect(DEFAULT_SETTINGS.groupNotifications).toBe(false);
    expect(bridge.match(/\): Promise<void> \{\s+if \(!settings\.groupJid \|\| !settings\.groupNotifications\) return;/g)).toHaveLength(2);
  });

  it('leaves through the same transport, which lets it pass only to the registered group, as text, with the switch on', () => {
    expect(bridge).toMatch(
      /const alertToItsGroup =\s+Boolean\(alert\) && Boolean\(to\.groupJid\) && to\.groupJid === alert!\.groupJid && to\.groupJid === current\(\)\.groupJid && current\(\)\.groupNotifications && !message\.attachment;/,
    );
    expect(bridge).toMatch(/if \(current\(\)\.groupOnly && !called\.getStore\(\) && !alertToItsGroup\) \{\s+throw new Error\('unasked:/);
    // Three places set it — a person's alert, the team's, the morning note — and each sends to the group it was set for.
    expect(bridge.match(/alerting\.run\(/g)).toHaveLength(3);
    expect(bridge.match(/alerting\.run\(\{ groupJid: settings\.groupJid \}, \(\) => send\(\{ e164, groupJid: settings\.groupJid \}, \{ text, quote: false \}\)\)/g)).toHaveLength(2);
    expect(bridge).toMatch(/alerting\.run\(\{ groupJid: settings\.groupJid \}, \(\) => send\(\{ e164, groupJid: settings\.groupJid \}, \{ text, quote: false \}\)\)/);
    expect(bridge).toMatch(/alerting\.run\(\{ groupJid: first \}, \(\) => send\(\{ e164, groupJid: first \}, \{ text, quote: false \}\)\)/);
    // The group-only rule on WHERE he writes is untouched by it.
    expect(bridge).toMatch(/if \(!toSelf && !maySendTo\(current\(\), to\)\) \{/);
  });

  it('tags the whole group on the team’s message, and only there (2026-10-13: "the tagging should be @all, not specific names")', () => {
    // The team's message carries the one tag for everybody; a person's own alert keeps their own.
    expect(alerts).toMatch(/const text = teamMessage\(\{ tags: \[EVERYONE_TAG\], rows: shared\.map/);
    expect(alerts).toMatch(/const text = alertMessage\(\{ tag: `@\$\{member\.tag\.replace/);
    // @all becomes every member's address inside an alert to its group — and nowhere else: what the model writes goes through writeTags.
    expect(bridge).toMatch(/const everyone = alertToItsGroup && roster && roster\.jid === to\.groupJid \? tagEveryone\(message\.text, roster\.members\) : null;/);
    expect(bridge.match(/tagEveryone\(/g)).toHaveLength(1);
    expect(teamMessage({ tags: ['@all'], rows: [row()], words: WORDS, locale: 'ar', appUrl: 'x' }).split(/\r?\n/)[1]).toBe('@all');
  });

  it('is the system speaking, never the model: nothing in it is generated', () => {
    expect(alerts.length).toBeGreaterThan(2_000);
    expect(alerts).not.toMatch(/runAgentFor|agent\(|wa\.answer|client\.|readerFor/);
    for (const source of [service, domain]) expect(source).not.toMatch(/runAgent|anthropic|whatsapp-agent|cli-brain/i);
    // It waits at night, tells only members of the group, and logs counts — never what an alert says.
    expect(alerts).toMatch(/if \(quietNow\(new Date\(\)\)\) return;/);
    expect(alerts.match(/const member = group\.find\(\(one\) => one\.e164 === \w+(\.e164)?\);\s+if \(!member\) continue;/g)).toHaveLength(2);
    expect(alerts.match(/log\(/g)!.length).toBeGreaterThan(2);
    expect(alerts).not.toMatch(/log\([^)]*\btext\b/);
  });

  it('the first time, it tells nothing: the marks are set to the newest and it returns', () => {
    expect(alerts).toMatch(/if \(marks\.toldUpTo === null \|\| marks\.decidedUpTo === null\) \{[\s\S]{0,420}alerts\.writeMarks\(\{ toldUpTo: told, decidedUpTo: decided \}\);[\s\S]{0,200}return;\s+\}/);
  });

  it('the morning note is said once a business day, and marked before it is sent', () => {
    const brief = bridge.slice(bridge.indexOf('async function sendMorningBrief('), bridge.indexOf('async function sendDigest('));
    expect(brief).toMatch(/if \(!briefHour\(now\) \|\| briefBusy\) return;/);
    expect(brief).toMatch(/if \(alerts\.readMarks\(\)\.briefDay === today\) return;/);
    expect(brief.indexOf('alerts.writeMarks({ briefDay: today });')).toBeLessThan(brief.indexOf('alerting.run('));
    expect(brief).toMatch(/const text = morningBrief\(\{ day, people, locale \}\);\s+if \(!text\) return;/);
  });

  it('reads other people\'s notifications the one way a process may, and only for contacts who allow it', () => {
    expect(service.match(/await markSystemSweep\(tx\);/g)).toHaveLength(2);
    expect(service.match(/join whatsapp_contact c on c\.user_id = \S+ and c\.active and c\.allow_notifications/g)).toHaveLength(2);
    expect(service).toMatch(/where c\.active and c\.allow_notifications/);
    expect(service).toMatch(/and n\.read_at is null/);
    // A person is not told of their own decision, nor twice of one the application already told them of.
    expect(service).toMatch(/and maker\.actor_user_id <> d\.actor_user_id/);
    expect(service).toMatch(/and not exists \(\s+select 1\s+from notification n\s+where n\.recipient_user_id = maker\.actor_user_id\s+and n\.object_id = d\.object_id/);
    expect(service).toMatch(/\.filter\(\(row\) => !isPrivateObject\(String\(row\.object_type\)\)\)/);
    // The day is counted AS the person, under their own scope.
    expect(service).toMatch(/const mine = \{ userId, branchCode: principal\.defaultBranchCode \?\? '', isSuperUser: principal\.isSuperUser \};/);
  });
});
