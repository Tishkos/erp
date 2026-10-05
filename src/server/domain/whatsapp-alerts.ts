/**
 * The ERP's own alerts in the WhatsApp group — what they say.
 *
 * By direction (2026-10-05), from the owner who had ruled the day before that
 * nothing is ever said unasked: "I want the AI aware a notification went to
 * Tishko, so it lets Tishko know in the WhatsApp group and tags them — you
 * have notifications, date, time and a short summary … task due, task alert
 * … automatically … it is so important, tag the person", and then: "when
 * what a user requested is approved, let them know too … think, be creative
 * about what needs to be alerted … nicely, very interactive".
 *
 * So these are the things said in the group without an `!ai`, and they are
 * kept narrow on purpose:
 *
 *   * It is the SYSTEM speaking, not the model: every word below is composed
 *     here from what the person already has in the application — a
 *     notification, or a decision the audit trail recorded on something they
 *     raised. Nothing is generated, so nothing can be invented.
 *   * One message per person, with their tag, listing what is new for them
 *     with its date and time — not one message per event. And one line each
 *     morning for whoever has something due, in a single message.
 *   * A group is not a private inbox. What a colleague wrote in Chat, and
 *     anything from HR (leave, pay, an advance), is announced WITHOUT its
 *     content: "a new chat message from Shene", "an HR notice". Everything
 *     else is the title the bell already shows, which names a document and
 *     never a figure nobody asked for.
 *   * Not at night: between `QUIET_FROM` and `QUIET_TO` (Baghdad) alerts wait
 *     for the morning.
 *   * Every alert ends with what to type to ask about it — that is the
 *     interactive part: the alert is the system's, the answer is Noah's, and
 *     he still speaks only when called.
 *
 * Pure: rows and words in, text out. Who is told, and when, is the service's
 * (`services/whatsapp-alerts.ts`) and the bridge's.
 */
import { categoryOf, kindDef, kindKey, labelParams } from './notification-center';

export interface AlertRow {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly objectId: string;
  readonly context: Readonly<Record<string, unknown>> | null;
  readonly createdAt: Date;
}

/** What somebody decided about a thing another person raised, as the audit trail recorded it. */
export interface DecisionRow {
  readonly id: string;
  /** `payment_application.approved`, `journal_entry.rejected`, … */
  readonly action: string;
  readonly objectType: string;
  /** Its number or code, when the trail carries one. */
  readonly reference: string | null;
  /** Who decided. */
  readonly actorName: string;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

/** The catalogue's words for a kind (`notifications.kind.<key>`), in one language. */
export type KindWords = Readonly<Record<string, { readonly title?: string; readonly detail?: string } | undefined>>;

/** No message lists more than this; the rest are counted. */
export const ALERT_MAX_LINES = 6;
/** One line never runs longer than this. */
export const ALERT_LINE_MAX = 170;
/** Alerts wait from this hour until `QUIET_TO`, by the books' clock. */
export const QUIET_FROM = 22;
export const QUIET_TO = 7;
/** The morning note is said from this hour, and not after `BRIEF_UNTIL` (a bridge that comes up at four does not say good morning). */
export const BRIEF_FROM = 8;
export const BRIEF_UNTIL = 12;

const ZONE = 'Asia/Baghdad';

const hourIn = (at: Date, zone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(at));

/** Is it night by the books' clock? Alerts are held, not dropped. */
export function quietNow(at: Date, zone: string = ZONE): boolean {
  const hour = hourIn(at, zone);
  return QUIET_FROM > QUIET_TO ? hour >= QUIET_FROM || hour < QUIET_TO : hour >= QUIET_FROM && hour < QUIET_TO;
}

/** Is it the part of the morning the day's note is said in? */
export function briefHour(at: Date, zone: string = ZONE): boolean {
  const hour = hourIn(at, zone);
  return hour >= BRIEF_FROM && hour < BRIEF_UNTIL;
}

/** "05 Oct 14:05" — the day and the time it was raised, by the books' clock. */
export function alertTime(at: Date, locale: 'en' | 'ar', zone: string = ZONE): string {
  const parts = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { timeZone: zone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`;
}

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** One sign in front of a line, so a list is read at a glance: what kind of thing it is. */
export function iconOf(kind: string): string {
  if (kind === 'task.assigned' || kind === 'task.reassigned') return '📌';
  if (kind === 'task.due_soon') return '⏰';
  if (kind === 'task.overdue' || kind === 'automation.task_overdue') return '🔴';
  if (kind === 'task.completed') return '✅';
  if (kind === 'task.blocked') return '⛔';
  if (kind === 'task.submitted') return '📝';
  if (kind.startsWith('task.')) return '📋';
  if (kind === 'approval.completed') return '✅';
  if (kind === 'approval.required' || kind.endsWith('.submitted')) return '✍️';
  if (kind.endsWith('.rejected')) return '❌';
  if (kind.startsWith('exception.')) return '⚠️';
  switch (categoryOf(kind)) {
    case 'chat':
      return '💬';
    case 'hr':
      return '👤';
    case 'invoices':
      return '🧾';
    case 'payments':
      return '💵';
    case 'logistics':
      return '🚢';
    case 'documents':
      return '📎';
    case 'system':
      return '🛠';
    case 'approvals':
      return '✍️';
    default:
      return '🔔';
  }
}

/**
 * A catalogue sentence with its `{ref}`, `{name}` … filled in. A sentence that
 * needs more than plain names (a plural, a choice) is not attempted: null, and
 * the caller uses the text the notification was raised with.
 */
export function fill(template: string | undefined, row: Pick<AlertRow, 'objectId' | 'context'>): string | null {
  if (!template) return null;
  if (/\{[^{}]*,/.test(template)) return null;
  const params = labelParams(row) as unknown as Record<string, string | number>;
  let missing = false;
  const said = template.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined || value === '' || value === null) {
      missing = true;
      return '';
    }
    return String(value);
  });
  return missing ? null : tidy(said);
}

/**
 * One notification as one line of an alert.
 *
 * Chat and HR are announced without their content (see the note at the top).
 * Everything else: the catalogue's title for its kind in the group's language
 * where there is one, else the subject it was raised with — and after it the
 * short detail, when it adds something.
 */
export function alertLine(row: AlertRow, words: KindWords, locale: 'en' | 'ar'): string {
  const when = alertTime(row.createdAt, locale);
  const icon = iconOf(row.kind);
  const category = categoryOf(row.kind);
  if (category === 'chat' || kindDef(row.kind).userText) {
    const from = tidy(String(row.context?.senderName ?? row.context?.actorName ?? row.context?.actor ?? ''));
    const mention = row.kind === 'chat.mention';
    const said =
      locale === 'ar'
        ? `${mention ? 'ذُكرت في محادثة' : 'رسالة جديدة في المحادثات'}${from ? ` — ${from}` : ''}`
        : `${mention ? 'You were mentioned in Chat' : 'New message in Chat'}${from ? ` from ${from}` : ''}`;
    return `${when} — ${icon} ${said}`;
  }
  if (category === 'hr') {
    return `${when} — ${icon} ${locale === 'ar' ? 'إشعار من الموارد البشرية (افتحه في النظام)' : 'An HR notice (open it in the ERP)'}`;
  }
  const label = words[kindKey(row.kind)];
  const title = fill(label?.title, row) ?? tidy(row.subject);
  const detail = fill(label?.detail, row) ?? (label?.title ? '' : tidy(row.body));
  const extra = detail && !title.toLowerCase().includes(detail.toLowerCase()) ? ` — ${detail}` : '';
  return clip(`${when} — ${icon} ${title}${extra}`, ALERT_LINE_MAX);
}

export type Decision = 'approved' | 'rejected' | 'returned' | 'posted';

/** What an audit action says was decided: its last word, when it is one of the four. */
export function decisionOf(action: string): Decision | null {
  const last = action.slice(action.lastIndexOf('.') + 1);
  return last === 'approved' || last === 'rejected' || last === 'returned' || last === 'posted' ? last : null;
}

/** Document kinds whose decisions are a person's own business, not the group's: they are not announced here. */
const PRIVATE_OBJECTS = /^(employee|payroll|payslip|leave|performance|review_|applicant|vacancy|attendance|hr_)/;
export const isPrivateObject = (objectType: string) => PRIVATE_OBJECTS.test(objectType);

const NUMBER_KEYS = ['documentNo', 'invoiceNo', 'entryNo', 'payableNo', 'applicationNo', 'paymentNo', 'receiptNo', 'orderNo', 'returnNo', 'memoNo', 'noteNo', 'transferNo', 'countNo', 'requestNo', 'runNo', 'taskNo', 'contractNo', 'reference', 'code', 'no'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The number a person knows a record by, from what the audit row carries: a
 * `…No` in what was written, else the id when the record is kept by its
 * number. Null when there is only an internal id — the line then names the
 * kind of document alone.
 */
export function referenceOf(after: unknown, before: unknown, objectId: string | null): string | null {
  for (const side of [after, before]) {
    if (!side || typeof side !== 'object') continue;
    const values = side as Record<string, unknown>;
    for (const key of NUMBER_KEYS) {
      const value = values[key];
      if (typeof value === 'string' && value.trim() !== '' && value.length <= 40 && !UUID.test(value)) return value.trim();
    }
  }
  const id = (objectId ?? '').trim();
  return id && id.length <= 40 && !UUID.test(id) && /[A-Za-z]/.test(id) && /\d/.test(id) ? id : null;
}

/** "payment application" from `payment_application`. */
const objectWords = (objectType: string) => objectType.replace(/_/g, ' ').trim();

/**
 * A decision on something the person raised, as one line: who decided, what,
 * on which document — and, for a refusal, the reason that was given.
 */
export function decisionLine(row: DecisionRow, locale: 'en' | 'ar'): string {
  const when = alertTime(row.occurredAt, locale);
  const decision = decisionOf(row.action) ?? 'approved';
  const what = `${objectWords(row.objectType)}${row.reference ? ` ${row.reference}` : ''}`;
  const who = tidy(row.actorName) || (locale === 'ar' ? 'أحدهم' : 'Somebody');
  const reason = row.reason && (decision === 'rejected' || decision === 'returned') ? clip(tidy(row.reason), 80) : '';
  const icon = decision === 'approved' ? '✅' : decision === 'rejected' ? '❌' : decision === 'returned' ? '↩️' : '📗';
  const said =
    locale === 'ar'
      ? `${decision === 'approved' ? 'تمت الموافقة على' : decision === 'rejected' ? 'رُفض' : decision === 'returned' ? 'أُعيد للتعديل' : 'تم ترحيل'} ما قدّمته: ${what} — ${who}${reason ? ` — السبب: ${reason}` : ''}`
      : `${who} ${decision === 'returned' ? 'returned' : decision} your ${what}${decision === 'returned' ? ' for changes' : ''}${reason ? ` — reason: ${reason}` : ''}`;
  return clip(`${when} — ${icon} ${said}`, ALERT_LINE_MAX + 40);
}

/**
 * What to type to ask about this alert — at most three, built from what is in
 * it: the task it names, the thing that was refused, what waits on them.
 */
export function hintsFor(rows: readonly AlertRow[], decisions: readonly DecisionRow[], locale: 'en' | 'ar'): string[] {
  const ar = locale === 'ar';
  const hints: string[] = [];
  const task = [...rows].reverse().find((row) => row.kind.startsWith('task.') || row.kind === 'automation.task_overdue');
  const taskNo = task ? tidy(String(task.context?.taskNo ?? '')) : '';
  if (taskNo) hints.push(ar ? `!ai اشرح ${taskNo}` : `!ai explain ${taskNo}`);
  const refused = [...decisions].reverse().find((row) => (decisionOf(row.action) === 'rejected' || decisionOf(row.action) === 'returned') && row.reference);
  if (refused) hints.push(ar ? `!ai ليش انرفض ${refused.reference}` : `!ai why was ${refused.reference} ${decisionOf(refused.action) === 'returned' ? 'returned' : 'rejected'}`);
  if (rows.some((row) => row.kind === 'approval.required' || row.kind.endsWith('.submitted'))) hints.push(ar ? '!ai شنو ينتظر موافقتي' : '!ai what is waiting for my approval');
  if (rows.some((row) => row.kind.startsWith('task.')) && hints.length < 3) hints.push(ar ? '!ai شنو مهامي' : '!ai my tasks');
  if (hints.length === 0) hints.push(ar ? '!ai شنو إشعاراتي' : '!ai my notifications');
  return hints.slice(0, 3);
}

/**
 * The whole alert for one person: their tag, how many, the lines in the order
 * things happened (at most `ALERT_MAX_LINES`, the newest kept), where to open
 * them, and what to type to ask about them.
 */
export function alertMessage(input: {
  /** As WhatsApp tags them: `@<digits>`. */
  readonly tag: string;
  readonly rows: readonly AlertRow[];
  readonly decisions?: readonly DecisionRow[];
  readonly words: KindWords;
  readonly locale: 'en' | 'ar';
  /** The application's address, without a trailing slash. */
  readonly appUrl: string;
}): string {
  const { rows, locale } = input;
  const decisions = input.decisions ?? [];
  const ar = locale === 'ar';
  const lines = [
    ...rows.map((row) => ({ at: row.createdAt.getTime(), text: alertLine(row, input.words, locale) })),
    ...decisions.map((row) => ({ at: row.occurredAt.getTime(), text: decisionLine(row, locale) })),
  ].sort((a, b) => a.at - b.at);
  const shown = lines.slice(-ALERT_MAX_LINES);
  const more = lines.length - shown.length;
  const count = lines.length;
  const head = ar
    ? count === 1
      ? '*لديك إشعار جديد في النظام*'
      : `*لديك ${count} إشعارات جديدة في النظام*`
    : count === 1
      ? '*You have a new notification in the ERP*'
      : `*You have ${count} new notifications in the ERP*`;
  return [
    `${input.tag} 🔔 ${head}`,
    ...(more > 0 ? [ar ? `… و${more} قبلها` : `… ${more} earlier, and:`] : []),
    ...shown.map((line) => `• ${line.text}`),
    `${ar ? 'افتحها' : 'Open them'}: ${input.appUrl}/notifications`,
    `${ar ? 'اسألني' : 'Ask me'}: ${hintsFor(rows, decisions, locale)
      .map((hint) => `*${hint}*`)
      .join(' · ')}`,
    ar ? '_تنبيه تلقائي من النظام._' : '_Automatic alert from the ERP._',
  ].join('\n');
}

/** The same notice raised for this many people or more is the team's, said once — not once per person. */
export const SHARED_MIN = 3;

/**
 * A batch, divided: what is one person's own, and what was raised for several
 * people at once (the day's system-health notice, an overdue invoice told to
 * every accountant). The second kind is said ONCE in the group with
 * everybody it concerns tagged — four people do not need four copies.
 */
export function splitShared<T extends AlertRow & { readonly recipientUserId: string }>(
  rows: readonly T[],
  min: number = SHARED_MIN,
): { readonly personal: T[]; readonly shared: Array<{ readonly row: T; readonly recipients: string[] }> } {
  const keyOf = (row: T) => [row.kind, row.objectId, row.subject].join('\u0001');
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  const personal: T[] = [];
  const shared: Array<{ row: T; recipients: string[] }> = [];
  for (const group of groups.values()) {
    const recipients = [...new Set(group.map((row) => row.recipientUserId))];
    if (recipients.length >= min) shared.push({ row: group[0]!, recipients });
    else personal.push(...group);
  }
  return { personal, shared };
}

/**
 * What was raised for several people at once, as one message: everybody it
 * concerns tagged on one line, then each notice once.
 */
export function teamMessage(input: { readonly tags: readonly string[]; readonly rows: readonly AlertRow[]; readonly words: KindWords; readonly locale: 'en' | 'ar'; readonly appUrl: string }): string {
  const ar = input.locale === 'ar';
  const shown = input.rows.slice(-ALERT_MAX_LINES);
  const more = input.rows.length - shown.length;
  return [
    ar ? '📣 *للفريق — جديد في النظام*' : '📣 *For the team — new in the ERP*',
    input.tags.join(' '),
    ...(more > 0 ? [ar ? `… و${more} قبلها` : `… ${more} earlier, and:`] : []),
    ...shown.map((row) => `• ${alertLine(row, input.words, input.locale)}`),
    `${ar ? 'افتحها' : 'Open them'}: ${input.appUrl}/notifications`,
    ar ? '_تنبيه تلقائي من النظام._' : '_Automatic alert from the ERP._',
  ].join('\n');
}

/** What one person has on their plate this morning. */
export interface DayCounts {
  /** Tasks given to them that are due today. */
  readonly dueToday: number;
  /** Tasks given to them that are past their date. */
  readonly overdue: number;
  /** Tasks they gave to others that were handed in and wait for their review. */
  readonly toReview: number;
  /** Documents waiting for their decision. */
  readonly approvals: number;
}

export const hasSomething = (counts: DayCounts) => counts.dueToday + counts.overdue + counts.toReview + counts.approvals > 0;

/** One person's line of the morning note: their tag and what is theirs today, nothing that is zero. */
export function briefLine(tag: string, counts: DayCounts, locale: 'en' | 'ar'): string {
  const ar = locale === 'ar';
  const parts = [
    counts.overdue > 0 ? (ar ? `🔴 ${counts.overdue} مهمة متأخرة` : `🔴 ${counts.overdue} overdue`) : '',
    counts.dueToday > 0 ? (ar ? `⏰ ${counts.dueToday} مهمة موعدها اليوم` : `⏰ ${counts.dueToday} due today`) : '',
    counts.toReview > 0 ? (ar ? `📝 ${counts.toReview} بانتظار مراجعتك` : `📝 ${counts.toReview} to review`) : '',
    counts.approvals > 0 ? (ar ? `✍️ ${counts.approvals} بانتظار موافقتك` : `✍️ ${counts.approvals} waiting for your approval`) : '',
  ].filter((part) => part !== '');
  return `${tag} — ${parts.join(' · ')}`;
}

/**
 * The morning note: ONE message for the group, a line for each person who has
 * something due, overdue, to review or to approve today — and nobody else.
 * Null when nobody has: a morning with nothing in it says nothing.
 */
export function morningBrief(input: { readonly day: string; readonly people: ReadonlyArray<{ readonly tag: string; readonly counts: DayCounts }>; readonly locale: 'en' | 'ar' }): string | null {
  const people = input.people.filter((person) => hasSomething(person.counts));
  if (people.length === 0) return null;
  const ar = input.locale === 'ar';
  return [
    ar ? `☀️ *صباح الخير — يومكم في النظام* (${input.day})` : `☀️ *Good morning — your day in the ERP* (${input.day})`,
    ...people.map((person) => briefLine(person.tag, person.counts, input.locale)),
    ar ? 'اسألني: *!ai شنو مهامي* · *!ai شنو ينتظر موافقتي*' : 'Ask me: *!ai my tasks* · *!ai what is waiting for my approval*',
    ar ? '_ملاحظة الصباح التلقائية من النظام._' : '_Automatic morning note from the ERP._',
  ].join('\n');
}

/** The rows of one batch, by the person they are for, each person's in the order they were raised. */
export function byRecipient<T extends { readonly recipientUserId: string; readonly id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  const sorted = [...rows].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  for (const row of sorted) out.set(row.recipientUserId, [...(out.get(row.recipientUserId) ?? []), row]);
  return out;
}
