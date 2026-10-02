/**
 * The WhatsApp bridge's service — REQ-WA-001 WA-1 (contacts, settings, the
 * session store, the message log, the outbound sender) and WA-2 (the answer).
 *
 * ── The boundary ────────────────────────────────────────────────────────────
 * A question is answered inside a transaction the database itself holds
 * read-only (`set local transaction_read_only = on`), under the asker's own
 * user and branch, with the asker's own grants (W-R1): the figures are the
 * screen's, and an INSERT from this path is refused by PostgreSQL before any
 * policy is consulted. The only rows a question ever causes are the message
 * log and the audit trail (W-R4), written by the bridge in its own
 * transaction after the read — by code, never by the text of the message.
 *
 * Who may ask is two facts, both checked on every message: the user holds the
 * `ceo` role (D-WA-3 as ratified: "only ceo role"), and their contact row says
 * `allow_queries`. Anybody else gets silence (W-R3).
 */
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { applyScope, db, withScope, type RequestScope, type Tx } from '../db/client';
import { appUser, businessPartner, notificationRule, payableHold, userRole, warehouse, whatsappContact, whatsappMessage, whatsappSession, whatsappSetting } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { can, type Principal } from '../domain/permissions';
import {
  DEFAULT_SETTINGS,
  WhatsappValidationError,
  daysBetween,
  detectLocale,
  footer,
  helpText,
  money,
  nameKey,
  normaliseE164,
  quantity,
  route,
  settingsFrom,
  validateSetting,
  words,
  type BotLocale,
  type BotSettings,
  type Intent,
} from '../domain/whatsapp';
import { AdminNotFoundError, permit, recordChange } from './administration';
import { loadPrincipal, scopeFor } from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as dashboard from './dashboard';
import * as notifications from './notifications';
import * as partners from './partners';
import * as partnerStatement from './partner-statement';
import * as payables from './payables';
import * as payablesSweep from './payables-sweep';
import * as paymentApplications from './payment-applications';
import * as audit from './audit';
import { letterheadFor } from '../print/letterhead';
import { messagesFor } from '../print/i18n';
import { CONTENT_TYPE, rowsIn, type Letterhead, type PrintModel } from '../print/model';
import { renderPdf } from '../print/pdf';
import { renderXlsx } from '../print/xlsx';
import * as reports from '../print/reports';
import { registerAllLists } from '../lists';

export const PERMISSION_OBJECT = 'whatsapp';
/** The role that may ask (D-WA-3, ratified 2026-10-02). */
export const QUERY_ROLE = 'ceo';

// ---------------------------------------------------------------------------
// Contacts — the allow-list (W-R3)
// ---------------------------------------------------------------------------

export interface ContactInput {
  readonly userId: string;
  readonly e164: string;
  readonly allowNotifications: boolean;
  readonly allowQueries: boolean;
  readonly allowDigest: boolean;
  /**
   * WA-6 — may decide a document from chat; off unless deliberately granted.
   * Optional so every form and fixture written before WA-6 still means "no".
   */
  readonly allowActions?: boolean;
}

async function holdsRole(tx: Tx, userId: string, roleCode: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: userRole.userId })
    .from(userRole)
    .where(and(eq(userRole.userId, userId), eq(userRole.roleCode, roleCode)))
    .limit(1);
  return Boolean(row);
}

/** Creates or updates a user's contact row — one per user, one number per row. */
export async function saveContact(tx: Tx, ctx: ActorContext, input: ContactInput): Promise<{ id: string; created: boolean }> {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const e164 = normaliseE164(input.e164);
  if (!e164) throw new WhatsappValidationError('e164', 'is not a phone number (+9647xxxxxxxxx)');
  const [user] = await tx.select({ id: appUser.id, isActive: appUser.isActive }).from(appUser).where(eq(appUser.id, input.userId)).limit(1);
  if (!user) throw new AdminNotFoundError('user', input.userId);
  if (input.allowQueries && !(await holdsRole(tx, input.userId, QUERY_ROLE))) {
    throw new WhatsappValidationError('allow_queries', `only a user holding the ${QUERY_ROLE} role may ask questions (D-WA-3)`);
  }
  const [taken] = await tx.select({ id: whatsappContact.id, userId: whatsappContact.userId }).from(whatsappContact).where(eq(whatsappContact.e164, e164)).limit(1);
  if (taken && taken.userId !== input.userId) throw new WhatsappValidationError('e164', 'is already another user\'s number');

  // WA-6 — deciding a document is the asking right plus one more: a contact
  // that may not ask may not decide either, whatever the form sent.
  const allowActions = (input.allowActions ?? false) && input.allowQueries;
  const values = { e164, allowNotifications: input.allowNotifications, allowQueries: input.allowQueries, allowDigest: input.allowDigest, allowActions };
  const [existing] = await tx.select().from(whatsappContact).where(eq(whatsappContact.userId, input.userId)).limit(1);
  if (existing) {
    await tx.update(whatsappContact).set({ ...values, updatedAt: new Date() }).where(eq(whatsappContact.id, existing.id));
    await recordChange(tx, ctx, {
      action: 'whatsapp_contact.updated',
      objectType: 'whatsapp_contact',
      objectId: existing.id,
      before: { e164: existing.e164, allowNotifications: existing.allowNotifications, allowQueries: existing.allowQueries, allowDigest: existing.allowDigest, allowActions: existing.allowActions },
      after: values,
    });
    return { id: existing.id, created: false };
  }
  const [created] = await tx
    .insert(whatsappContact)
    .values({ userId: input.userId, ...values, createdBy: ctx.principal.userId })
    .returning({ id: whatsappContact.id });
  await recordChange(tx, ctx, { action: 'whatsapp_contact.created', objectType: 'whatsapp_contact', objectId: created!.id, after: { userId: input.userId, ...values } });
  return { id: created!.id, created: true };
}

export async function setContactActive(tx: Tx, ctx: ActorContext, id: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, id);
  const [before] = await tx.select().from(whatsappContact).where(eq(whatsappContact.id, id)).limit(1);
  if (!before) throw new AdminNotFoundError('whatsapp_contact', id);
  const why = (reason ?? '').trim();
  if (!active && !why) throw new WhatsappValidationError('reason', 'say why it is deactivated');
  await tx
    .update(whatsappContact)
    .set({ active, deactivatedReason: active ? null : why, updatedAt: new Date() })
    .where(eq(whatsappContact.id, id));
  await recordChange(tx, ctx, {
    action: active ? 'whatsapp_contact.activated' : 'whatsapp_contact.deactivated',
    objectType: 'whatsapp_contact',
    objectId: id,
    before: { active: before.active },
    after: { active },
    reason: active ? null : why,
  });
}

export interface ContactRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly userActive: boolean;
  readonly e164: string;
  readonly allowNotifications: boolean;
  readonly allowQueries: boolean;
  readonly allowDigest: boolean;
  readonly allowActions: boolean;
  readonly active: boolean;
  readonly deactivatedReason: string | null;
  readonly isCeo: boolean;
}

export async function contacts(tx: Tx): Promise<ContactRow[]> {
  const rows = await tx
    .select({
      id: whatsappContact.id,
      userId: whatsappContact.userId,
      displayName: appUser.displayName,
      email: appUser.email,
      userActive: appUser.isActive,
      e164: whatsappContact.e164,
      allowNotifications: whatsappContact.allowNotifications,
      allowQueries: whatsappContact.allowQueries,
      allowDigest: whatsappContact.allowDigest,
      allowActions: whatsappContact.allowActions,
      active: whatsappContact.active,
      deactivatedReason: whatsappContact.deactivatedReason,
      isCeo: sql<boolean>`exists (select 1 from user_role r where r.user_id = ${whatsappContact.userId} and r.role_code = ${QUERY_ROLE})`,
    })
    .from(whatsappContact)
    .innerJoin(appUser, eq(appUser.id, whatsappContact.userId))
    .orderBy(desc(whatsappContact.active), asc(appUser.displayName));
  return rows;
}

/** The users who may be given a contact row: active, without one yet. */
export async function usersWithoutContact(tx: Tx) {
  return tx
    .select({ id: appUser.id, displayName: appUser.displayName, email: appUser.email })
    .from(appUser)
    .where(and(eq(appUser.isActive, true), sql`not exists (select 1 from whatsapp_contact c where c.user_id = ${appUser.id})`))
    .orderBy(asc(appUser.displayName));
}

export interface ResolvedSender {
  readonly contactId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly e164: string;
  readonly allowNotifications: boolean;
  readonly allowQueries: boolean;
  readonly allowDigest: boolean;
  /** WA-6 — may decide a document from chat. */
  readonly allowActions: boolean;
  readonly active: boolean;
  readonly userActive: boolean;
  readonly isCeo: boolean;
}

/** The contact behind a number — or null, which the bridge answers with silence. */
export async function resolveNumber(tx: Tx, e164: string): Promise<ResolvedSender | null> {
  const [row] = await tx
    .select({
      contactId: whatsappContact.id,
      userId: whatsappContact.userId,
      displayName: appUser.displayName,
      e164: whatsappContact.e164,
      allowNotifications: whatsappContact.allowNotifications,
      allowQueries: whatsappContact.allowQueries,
      allowDigest: whatsappContact.allowDigest,
      allowActions: whatsappContact.allowActions,
      active: whatsappContact.active,
      userActive: appUser.isActive,
      isCeo: sql<boolean>`exists (select 1 from user_role r where r.user_id = ${whatsappContact.userId} and r.role_code = ${QUERY_ROLE})`,
    })
    .from(whatsappContact)
    .innerJoin(appUser, eq(appUser.id, whatsappContact.userId))
    .where(eq(whatsappContact.e164, e164))
    .limit(1);
  return row ?? null;
}

/** W-R3 + D-WA-3: may this number ask? Every condition, so the log can say which failed. */
export function mayAsk(sender: ResolvedSender | null): { ok: true } | { ok: false; reason: string } {
  if (!sender) return { ok: false, reason: 'unlisted number' };
  if (!sender.active) return { ok: false, reason: 'contact deactivated' };
  if (!sender.userActive) return { ok: false, reason: 'user deactivated' };
  if (!sender.isCeo) return { ok: false, reason: `user does not hold the ${QUERY_ROLE} role` };
  if (!sender.allowQueries) return { ok: false, reason: 'queries not allowed for this contact' };
  return { ok: true };
}

export async function contactForUser(tx: Tx, userId: string): Promise<ResolvedSender | null> {
  const [row] = await tx.select({ e164: whatsappContact.e164 }).from(whatsappContact).where(eq(whatsappContact.userId, userId)).limit(1);
  return row ? resolveNumber(tx, row.e164) : null;
}

// ---------------------------------------------------------------------------
// WA-5 — the one group
// ---------------------------------------------------------------------------

/**
 * Is this the group the bot works in?
 *
 * One group, by its id, and no other: the bot is in whatever groups somebody
 * added it to, and all but the registered one are silence — the same answer
 * an unlisted number gets (W-R3). An unregistered bot (`group_jid` empty)
 * reads no group at all.
 */
export function groupAllowed(settings: BotSettings, groupJid: string | null | undefined): boolean {
  if (!groupJid) return true; // a direct message is not a group's business
  return settings.groupJid !== '' && settings.groupJid === groupJid;
}

/**
 * WA-6 — may this person decide a document from chat?
 *
 * The contact's own flag, on top of everything `mayAsk` demands. It says
 * nothing about *this* document: whether they may approve this one is the
 * approval engine's answer, under their own principal, a moment later.
 */
export function mayAct(sender: ResolvedSender | null): { ok: true } | { ok: false; reason: string } {
  const asking = mayAsk(sender);
  if (!asking.ok) return asking;
  if (!sender!.allowActions) return { ok: false, reason: 'deciding documents is not allowed for this contact' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function settings(tx: Tx): Promise<BotSettings> {
  const rows = await tx.select({ key: whatsappSetting.key, value: whatsappSetting.value }).from(whatsappSetting);
  return settingsFrom(rows);
}

export async function settingRows(tx: Tx) {
  return tx.select().from(whatsappSetting).orderBy(asc(whatsappSetting.key));
}

export async function saveSetting(tx: Tx, ctx: ActorContext, key: string, value: string): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, key);
  const checked = validateSetting(key, value);
  const [before] = await tx.select({ value: whatsappSetting.value }).from(whatsappSetting).where(eq(whatsappSetting.key, checked.key)).limit(1);
  await tx
    .insert(whatsappSetting)
    .values({ key: checked.key, value: checked.value, updatedBy: ctx.principal.userId })
    .onConflictDoUpdate({ target: whatsappSetting.key, set: { value: checked.value, updatedAt: new Date(), updatedBy: ctx.principal.userId } });
  await recordChange(tx, ctx, {
    action: 'whatsapp_setting.updated',
    objectType: 'whatsapp_setting',
    objectId: checked.key,
    before: { value: before?.value ?? null },
    after: { value: checked.value },
  });
}

/** The notification rules, with whether each reaches WhatsApp. */
export async function rules(tx: Tx) {
  const rows = await tx.select().from(notificationRule).orderBy(asc(notificationRule.code));
  return rows.map((r) => ({ ...r, whatsapp: r.channels.includes('whatsapp') }));
}

/** Turns the `whatsapp` channel on or off for one rule — the sponsor's "customize". */
export async function setRuleWhatsapp(tx: Tx, ctx: ActorContext, code: string, on: boolean): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [rule] = await tx.select().from(notificationRule).where(eq(notificationRule.code, code)).limit(1);
  if (!rule) throw new AdminNotFoundError('notification_rule', code);
  const without = rule.channels.filter((c) => c !== 'whatsapp');
  const channels = on ? [...without, 'whatsapp'] : without;
  if (channels.length === 0) throw new WhatsappValidationError('channels', 'a rule keeps at least one channel');
  if (channels.join(',') === rule.channels.join(',')) return;
  await tx.update(notificationRule).set({ channels }).where(eq(notificationRule.code, code));
  await recordChange(tx, ctx, {
    action: 'notification_rule.updated',
    objectType: 'notification_rule',
    objectId: code,
    before: { channels: rule.channels },
    after: { channels },
  });
}

// ---------------------------------------------------------------------------
// The session store (the bridge's pairing)
// ---------------------------------------------------------------------------

export async function sessionGet(tx: Tx, key: string): Promise<unknown | null> {
  const [row] = await tx.select({ value: whatsappSession.value }).from(whatsappSession).where(eq(whatsappSession.key, key)).limit(1);
  return row ? row.value : null;
}

export async function sessionSet(tx: Tx, key: string, value: unknown): Promise<void> {
  await tx
    .insert(whatsappSession)
    .values({ key, value: value as Record<string, unknown> })
    .onConflictDoUpdate({ target: whatsappSession.key, set: { value: value as Record<string, unknown>, updatedAt: new Date() } });
}

export async function sessionDelete(tx: Tx, key: string): Promise<void> {
  await tx.delete(whatsappSession).where(eq(whatsappSession.key, key));
}

/** Forgets the pairing — the next bridge start prints a new QR code. */
export async function sessionClear(tx: Tx, ctx: ActorContext, reason: string): Promise<number> {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const removed = await tx.delete(whatsappSession).returning({ key: whatsappSession.key });
  await recordChange(tx, ctx, { action: 'whatsapp_session.cleared', objectType: 'whatsapp_session', objectId: 'bridge', after: { keys: removed.length }, reason });
  return removed.length;
}

export interface BridgeStatus {
  readonly paired: boolean;
  /** The bot's own number, once paired. */
  readonly me: string | null;
  readonly state: string | null;
  readonly lastSeenAt: Date | null;
  readonly pendingDeliveries: number;
  readonly failedDeliveries: number;
}

const STATUS_KEYS = { state: 'bridge_state', seen: 'bridge_last_seen', me: 'bridge_me' } as const;

/** Written by the bridge every minute and on every change of connection. */
export async function heartbeat(tx: Tx, input: { readonly state: string; readonly me: string | null; readonly at?: Date }): Promise<void> {
  const at = input.at ?? new Date();
  for (const [key, value] of [
    [STATUS_KEYS.state, input.state],
    [STATUS_KEYS.seen, at.toISOString()],
    [STATUS_KEYS.me, input.me ?? ''],
  ] as const) {
    await tx
      .insert(whatsappSetting)
      .values({ key, value })
      .onConflictDoUpdate({ target: whatsappSetting.key, set: { value, updatedAt: at } });
  }
}

export async function bridgeStatus(tx: Tx): Promise<BridgeStatus> {
  const rows = await tx.select({ key: whatsappSetting.key, value: whatsappSetting.value }).from(whatsappSetting).where(inArray(whatsappSetting.key, [STATUS_KEYS.state, STATUS_KEYS.seen, STATUS_KEYS.me]));
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const creds = await sessionGet(tx, 'creds');
  const paired = Boolean(creds && typeof creds === 'object' && (creds as { me?: unknown }).me);
  const [counts] = (
    await tx.execute(sql`
      select count(*) filter (where d.status = 'pending')::int as pending,
             count(*) filter (where d.status = 'failed')::int  as failed
        from notification_delivery d
       where d.channel = 'whatsapp'`)
  ).rows as { pending: number; failed: number }[];
  const seen = map.get(STATUS_KEYS.seen);
  return {
    paired,
    me: map.get(STATUS_KEYS.me) || null,
    state: map.get(STATUS_KEYS.state) ?? null,
    lastSeenAt: seen ? new Date(seen) : null,
    pendingDeliveries: counts?.pending ?? 0,
    failedDeliveries: counts?.failed ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The morning digest (WA-4)
// ---------------------------------------------------------------------------

const DIGEST_SENT_KEY = 'digest_last_sent_day';

/** The contacts the digest goes to: active, opted in, and allowed to ask (the digest is an answer). */
export async function digestRecipients(tx: Tx): Promise<ResolvedSender[]> {
  const rows = await tx.select({ e164: whatsappContact.e164 }).from(whatsappContact).where(and(eq(whatsappContact.active, true), eq(whatsappContact.allowDigest, true))).orderBy(asc(whatsappContact.e164));
  const out: ResolvedSender[] = [];
  for (const row of rows) {
    const sender = await resolveNumber(tx, row.e164);
    if (sender && mayAsk(sender).ok) out.push(sender);
  }
  return out;
}

export async function digestLastSentDay(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ value: whatsappSetting.value }).from(whatsappSetting).where(eq(whatsappSetting.key, DIGEST_SENT_KEY)).limit(1);
  return row?.value || null;
}

export async function markDigestSent(tx: Tx, day: string): Promise<void> {
  await tx
    .insert(whatsappSetting)
    .values({ key: DIGEST_SENT_KEY, value: day })
    .onConflictDoUpdate({ target: whatsappSetting.key, set: { value: day, updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// The message log (W-R4 made readable; D-WA-8)
// ---------------------------------------------------------------------------

export async function recordInbound(
  tx: Tx,
  input: { readonly e164: string; readonly body: string; readonly waMessageId?: string | null; readonly sender: ResolvedSender | null },
): Promise<bigint> {
  const [row] = await tx
    .insert(whatsappMessage)
    .values({
      direction: 'in',
      e164: input.e164,
      contactId: input.sender?.contactId ?? null,
      userId: input.sender?.userId ?? null,
      waMessageId: input.waMessageId ?? null,
      body: input.body,
      status: 'received',
    })
    .returning({ id: whatsappMessage.id });
  return row!.id;
}

export async function finishInbound(
  tx: Tx,
  id: bigint,
  outcome: { readonly status: 'answered' | 'refused' | 'failed'; readonly intent?: string | null; readonly detail?: Record<string, unknown> | null; readonly errorMessage?: string | null },
): Promise<void> {
  await tx
    .update(whatsappMessage)
    .set({
      status: outcome.status,
      intent: outcome.intent ?? null,
      detail: outcome.detail ?? null,
      errorMessage: outcome.status === 'failed' ? (outcome.errorMessage ?? 'failed') : null,
    })
    .where(eq(whatsappMessage.id, id));
}

export async function recordOutbound(
  tx: Tx,
  input: {
    readonly e164: string;
    readonly body: string;
    readonly sender?: ResolvedSender | null;
    readonly attachment?: { readonly name: string; readonly type: string; readonly bytes: number } | null;
    readonly inReplyTo?: bigint | null;
    readonly deliveryId?: bigint | null;
    readonly intent?: string | null;
    readonly detail?: Record<string, unknown> | null;
  },
): Promise<bigint> {
  const [row] = await tx
    .insert(whatsappMessage)
    .values({
      direction: 'out',
      e164: input.e164,
      contactId: input.sender?.contactId ?? null,
      userId: input.sender?.userId ?? null,
      body: input.body,
      attachmentName: input.attachment?.name ?? null,
      attachmentType: input.attachment?.type ?? null,
      attachmentBytes: input.attachment?.bytes ?? null,
      inReplyTo: input.inReplyTo ?? null,
      deliveryId: input.deliveryId ?? null,
      intent: input.intent ?? null,
      detail: input.detail ?? null,
      status: 'pending',
    })
    .returning({ id: whatsappMessage.id });
  return row!.id;
}

export async function markOutbound(
  tx: Tx,
  id: bigint,
  outcome: { readonly status: 'sent' | 'failed'; readonly waMessageId?: string | null; readonly errorMessage?: string | null; readonly at?: Date },
): Promise<void> {
  await tx
    .update(whatsappMessage)
    .set({
      status: outcome.status,
      waMessageId: outcome.waMessageId ?? null,
      sentAt: outcome.status === 'sent' ? (outcome.at ?? new Date()) : null,
      errorMessage: outcome.status === 'failed' ? (outcome.errorMessage ?? 'failed') : null,
    })
    .where(eq(whatsappMessage.id, id));
}

export interface LogRow {
  readonly id: bigint;
  readonly direction: string;
  readonly e164: string;
  readonly userName: string | null;
  readonly body: string | null;
  readonly intent: string | null;
  readonly status: string;
  readonly errorMessage: string | null;
  readonly attachmentName: string | null;
  readonly createdAt: Date;
  readonly sentAt: Date | null;
  readonly redactedAt: Date | null;
}

export async function log(tx: Tx, options: { readonly limit?: number } = {}): Promise<LogRow[]> {
  return tx
    .select({
      id: whatsappMessage.id,
      direction: whatsappMessage.direction,
      e164: whatsappMessage.e164,
      userName: appUser.displayName,
      body: whatsappMessage.body,
      intent: whatsappMessage.intent,
      status: whatsappMessage.status,
      errorMessage: whatsappMessage.errorMessage,
      attachmentName: whatsappMessage.attachmentName,
      createdAt: whatsappMessage.createdAt,
      sentAt: whatsappMessage.sentAt,
      redactedAt: whatsappMessage.redactedAt,
    })
    .from(whatsappMessage)
    .leftJoin(appUser, eq(appUser.id, whatsappMessage.userId))
    .orderBy(desc(whatsappMessage.id))
    .limit(Math.max(1, Math.min(500, options.limit ?? 100)));
}

/** D-WA-8 — blanks bodies older than the retention; the rows and their outcomes stay. */
export async function redactExpired(tx: Tx, retentionDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const rows = await tx
    .update(whatsappMessage)
    .set({ body: null, redactedAt: now })
    .where(and(lt(whatsappMessage.createdAt, cutoff), sql`${whatsappMessage.redactedAt} is null`, sql`${whatsappMessage.body} is not null`))
    .returning({ id: whatsappMessage.id });
  return rows.length;
}

/** Messages sent in the last minute, for the throttle (§3). */
export async function sentInLastMinute(tx: Tx, now = new Date()): Promise<number> {
  const [row] = (
    await tx.execute(sql`select count(*)::int as n from whatsapp_message where direction = 'out' and status = 'sent' and sent_at >= ${new Date(now.getTime() - 60_000)}`)
  ).rows as { n: number }[];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// The outbound sender — the `whatsapp` notification channel (W1)
// ---------------------------------------------------------------------------

export type Transport = (to: { readonly e164: string }, message: { readonly text: string; readonly attachment?: Attachment | null }) => Promise<{ waMessageId: string | null }>;

/**
 * Registers the bridge's socket as the channel's sender. A recipient without
 * an active contact, or with notifications switched off, is suppressed — not
 * an error, nothing to retry.
 */
export function registerWhatsappSender(transport: Transport): void {
  notifications.registerSender('whatsapp', async (message, tx: Tx) => {
    const contact = await contactForUser(tx, message.recipientUserId);
    if (!contact) throw new notifications.DeliverySuppressed('no WhatsApp number on file');
    if (!contact.active) throw new notifications.DeliverySuppressed('WhatsApp contact deactivated');
    if (!contact.userActive) throw new notifications.DeliverySuppressed('user deactivated');
    if (!contact.allowNotifications) throw new notifications.DeliverySuppressed('WhatsApp notifications switched off for this contact');
    const text = `*${message.subject}*\n${message.body}`;
    const outId = await recordOutbound(tx, { e164: contact.e164, body: text, sender: contact, deliveryId: message.deliveryId, intent: 'notification', detail: { eventType: message.eventType, objectType: message.objectType, objectId: message.objectId } });
    try {
      const { waMessageId } = await transport({ e164: contact.e164 }, { text });
      await markOutbound(tx, outId, { status: 'sent', waMessageId });
    } catch (error) {
      await markOutbound(tx, outId, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// The answer (WA-2)
// ---------------------------------------------------------------------------

export interface Attachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly body: Buffer;
  readonly format: 'pdf' | 'xlsx';
}

export interface Reply {
  readonly intent: Intent;
  readonly locale: BotLocale;
  readonly text: string;
  readonly attachment: Attachment | null;
  /** What the log and the audit say about how the answer was made. */
  readonly detail: Record<string, unknown>;
  /** The export the ERP's own path would have audited, if a file was made. */
  readonly exported: { readonly object: string; readonly key: string; readonly title: string; readonly rows: number } | null;
  readonly readAs: { readonly userId: string; readonly userName: string; readonly branchCode: string; readonly at: Date };
}

export class NotAllowedToAsk extends Error {
  readonly code = 'WHATSAPP_NOT_ALLOWED';
  constructor(reason: string) {
    super(reason);
    this.name = 'NotAllowedToAsk';
  }
}

interface ReadContext {
  readonly tx: Tx;
  readonly principal: Principal;
  readonly branchCode: string;
  readonly locale: BotLocale;
  readonly settings: BotSettings;
  readonly today: string;
}

interface Drafted {
  readonly text: string;
  /** A model to attach when there are more rows than fit inline, or always. */
  readonly model?: PrintModel | null;
  readonly format?: 'pdf' | 'xlsx';
  readonly attachAlways?: boolean;
  readonly exportObject?: string;
  readonly exportKey?: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Runs `fn` as the asker, in a transaction the database holds read-only
 * (W-R1). Exported so the tests can show an INSERT from inside it is refused.
 */
export async function withReadOnlyScope<T>(scope: RequestScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await applyScope(tx, scope);
    await tx.execute(sql`set local transaction_read_only = on`);
    return fn(tx);
  });
}

/** The asker's principal, loaded under their own bootstrap scope. */
export async function principalOf(userId: string): Promise<Principal> {
  return withScope({ userId, branchCode: '', isSuperUser: false }, (tx) => loadPrincipal(tx, userId));
}

/**
 * Answers one question. Reads only; returns what to send and what to record.
 * `router` lets the bridge (or a test) supply the tier-2 agent for what the
 * patterns miss; without one, an unmatched ask gets the help text.
 */
export async function answer(input: {
  readonly userId: string;
  readonly text: string;
  readonly settings?: BotSettings;
  readonly locale?: BotLocale;
  readonly now?: Date;
  readonly router?: (text: string, locale: BotLocale) => Promise<Intent>;
}): Promise<Reply> {
  const at = input.now ?? new Date();
  const locale = input.locale ?? detectLocale(input.text);
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const principal = await principalOf(input.userId);
  if (!principal.isActive) throw new NotAllowedToAsk('user deactivated');
  if (!principal.roleCodes.includes(QUERY_ROLE)) throw new NotAllowedToAsk(`user does not hold the ${QUERY_ROLE} role`);
  const branchCode = principal.defaultBranchCode ?? '';
  if (!branchCode) throw new NotAllowedToAsk('user has no branch');

  let intent = route(input.text);
  if (intent.kind === 'none' && input.router) intent = await input.router(input.text, locale);

  const scope = scopeFor(principal, branchCode);
  const { drafted, head, userName } = await withReadOnlyScope(scope, async (tx) => {
    const ctx: ReadContext = { tx, principal, branchCode, locale, settings, today: businessToday(at) };
    const drafted = await draft(ctx, intent);
    const head = drafted.model ? await letterheadFor(tx, { locale, userId: principal.userId, branchCode, at: at.toISOString() }) : null;
    const [me] = await tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, principal.userId)).limit(1);
    return { drafted, head, userName: me?.name ?? principal.userId };
  });

  const w = words(locale);
  let attachment: Attachment | null = null;
  let exported: Reply['exported'] = null;
  let text = drafted.text;
  if (drafted.model && head) {
    const rows = rowsIn(drafted.model);
    if (rows > settings.exportRowsCap) {
      text = `${text}\n${w.tooMany(rows, settings.exportRowsCap)}`;
    } else if (drafted.attachAlways || rows > settings.inlineRows) {
      const format = drafted.format ?? 'xlsx';
      const body = format === 'pdf' ? await renderPdf(drafted.model, head as Letterhead) : await renderXlsx(drafted.model, head as Letterhead);
      const fileName = `${drafted.model.fileName.replace(/[^\w.\-؀-ۿ ]+/g, '_')}.${format}`;
      attachment = { fileName, contentType: CONTENT_TYPE[format], body, format };
      exported = { object: drafted.exportObject ?? 'whatsapp', key: drafted.exportKey ?? intent.kind, title: drafted.model.title, rows };
      text = `${text}\n${w.attached(fileName)}`;
    }
  }
  text = `${text}\n\n${footer(locale, { at, branchCode, userName })}`;

  return {
    intent,
    locale,
    text,
    attachment,
    detail: { ...(drafted.detail ?? {}), intent, rows: drafted.model ? rowsIn(drafted.model) : null, attachment: attachment ? { fileName: attachment.fileName, bytes: attachment.body.length } : null },
    exported,
    readAs: { userId: principal.userId, userName, branchCode, at },
  };
}

/** The bridge's record of an answer: the audit rows the ERP's own screens would have written. */
export async function auditAnswer(tx: Tx, reply: Reply, input: { readonly inboundId: bigint; readonly question: string }): Promise<void> {
  await audit.record(tx, {
    actorUserId: reply.readAs.userId,
    action: 'whatsapp.answered',
    objectType: 'whatsapp_message',
    objectId: input.inboundId.toString(),
    branchCode: reply.readAs.branchCode,
    outcome: 'success',
    after: { question: input.question, intent: reply.intent, locale: reply.locale, rows: reply.detail.rows ?? null, attachment: reply.detail.attachment ?? null, readAt: reply.readAs.at.toISOString() },
  });
  if (reply.exported) {
    await audit.record(tx, {
      actorUserId: reply.readAs.userId,
      action: `${reply.exported.object}.exported`,
      objectType: reply.exported.object,
      objectId: reply.exported.key,
      branchCode: reply.readAs.branchCode,
      outcome: 'success',
      after: {
        format: reply.attachment?.format ?? null,
        language: reply.locale,
        report: reply.exported.key,
        title: reply.exported.title,
        rows: reply.exported.rows,
        fileName: reply.attachment?.fileName ?? null,
        channel: 'whatsapp',
        exportedAt: reply.readAs.at.toISOString(),
      },
    });
  }
}

// --- the intents ------------------------------------------------------------

async function draft(ctx: ReadContext, intent: Intent): Promise<Drafted> {
  switch (intent.kind) {
    case 'help':
      return { text: helpText(ctx.locale) };
    case 'none':
      return { text: words(ctx.locale).unknown };
    case 'summary':
      return summary(ctx);
    case 'stock':
      return stock(ctx, intent.warehouse);
    case 'payable':
      return payableStatus(ctx, intent.no);
    case 'application':
      return applicationStatus(ctx, intent.no);
    case 'swift':
      return swift(ctx, intent.minDays);
    case 'due':
      return due(ctx);
    case 'stopped':
      return stopped(ctx, intent.needsReason);
    case 'supplier':
      return partnerBalance(ctx, 'supplier', intent.party);
    case 'customer':
      return partnerBalance(ctx, 'customer', intent.party);
  }
}

const L = (locale: BotLocale, en: string, ar: string) => (locale === 'ar' ? ar : en);

/** A business day from whatever a service returns: an ISO string, a Date, nothing. */
const day = (value: Date | string | null | undefined): string => {
  if (!value) return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

function denied(ctx: ReadContext): Drafted {
  return { text: L(ctx.locale, 'You are not allowed to see that.', 'ليس لديك صلاحية لرؤية ذلك.') };
}

function tableModel(input: {
  readonly ctx: ReadContext;
  readonly title: string;
  readonly fileName: string;
  readonly columns: PrintModel['tables'][number]['columns'];
  readonly rows: ReadonlyArray<Readonly<Record<string, string | null>>>;
  readonly filters?: PrintModel['filters'];
  readonly totals?: PrintModel['tables'][number]['totals'];
  readonly currency?: 'IQD' | 'USD';
}): PrintModel {
  const m = messagesFor(input.ctx.locale);
  return {
    kind: 'report',
    title: input.title,
    orientation: 'landscape',
    fields: [],
    filters: input.filters ?? [],
    tables: [{ columns: input.columns, rows: input.rows.map((cells) => ({ cells })), empty: m.admin('reports.no_rows'), ...(input.totals ? { totals: input.totals } : {}) }],
    summary: [],
    signatures: false,
    currency: input.currency ?? 'IQD',
    fileName: input.fileName,
    sheetName: input.title.slice(0, 31),
  };
}

async function summary(ctx: ReadContext): Promise<Drafted> {
  // The dashboard's activity band reads the audit list; the page registers
  // the lists at start-up, the bridge has to do the same.
  registerAllLists();
  const d = await dashboard.forPrincipal(ctx.tx, ctx.principal, ctx.branchCode);
  const lines: string[] = [L(ctx.locale, `Today ${ctx.today} — branch ${ctx.branchCode}`, `اليوم ${ctx.today} — الفرع ${ctx.branchCode}`)];
  if (d.waiting) {
    const dueSum = d.waiting.dueThisWeek.reduce((s, r) => s + Number(r.amountTxn), 0);
    lines.push(L(ctx.locale, `Approvals waiting: ${d.waiting.approvals.length}`, `موافقات بانتظارك: ${d.waiting.approvals.length}`));
    lines.push(L(ctx.locale, `Stops needing a reason: ${d.waiting.holdsNeedingReason.length} · stops I own: ${d.waiting.holdsIOwn.length}`, `إيقافات بلا سبب: ${d.waiting.holdsNeedingReason.length} · إيقافات أملكها: ${d.waiting.holdsIOwn.length}`));
    lines.push(L(ctx.locale, `Due this week: ${d.waiting.dueThisWeek.length} (${money(dueSum)})`, `مستحق هذا الأسبوع: ${d.waiting.dueThisWeek.length} (${money(dueSum)})`));
    lines.push(L(ctx.locale, `Unread notifications: ${d.waiting.unreadNotifications}`, `إشعارات غير مقروءة: ${d.waiting.unreadNotifications}`));
  }
  if (d.balances) {
    const total = d.balances.reduce((s, b) => s + Number(b.balanceIqd), 0);
    lines.push(L(ctx.locale, `Bank & cash: ${money(total, 'IQD')} across ${d.balances.length} accounts`, `البنك والصندوق: ${money(total, 'IQD')} في ${d.balances.length} حساب`));
  }
  if (d.receivable) lines.push(L(ctx.locale, `Receivable: ${money(d.receivable.totalIqd, 'IQD')} (overdue ${money(d.receivable.overdueIqd)})`, `الذمم المدينة: ${money(d.receivable.totalIqd, 'IQD')} (متأخر ${money(d.receivable.overdueIqd)})`));
  if (d.payable) lines.push(L(ctx.locale, `Payable: ${money(d.payable.totalIqd, 'IQD')} (overdue ${money(d.payable.overdueIqd)})`, `الذمم الدائنة: ${money(d.payable.totalIqd, 'IQD')} (متأخر ${money(d.payable.overdueIqd)})`));
  if (d.result) lines.push(L(ctx.locale, `Result ${d.result.from} → ${d.result.to}: ${money(d.result.result, 'IQD')}`, `النتيجة ${d.result.from} ← ${d.result.to}: ${money(d.result.result, 'IQD')}`));
  const swiftRows = can(ctx.principal, 'view', 'payment_application') ? await payablesSweep.swiftPendingApplications(ctx.tx, { asOf: ctx.today }) : [];
  if (can(ctx.principal, 'view', 'payment_application')) lines.push(L(ctx.locale, `SWIFT pending: ${swiftRows.length}`, `سويفت معلق: ${swiftRows.length}`));
  return { text: lines.join('\n'), detail: { bands: Object.entries(d).filter(([, v]) => v !== null).map(([k]) => k) } };
}

async function warehousesFor(ctx: ReadContext, asked: string) {
  const all = await ctx.tx.select({ code: warehouse.code, name: warehouse.name, branchCode: warehouse.branchCode }).from(warehouse).orderBy(asc(warehouse.code));
  const askedCode = asked.trim().toUpperCase();
  const byCode = all.filter((w) => w.code.toUpperCase() === askedCode);
  if (byCode.length === 1) return { all, matches: byCode };
  const key = nameKey(asked);
  const matches = key ? all.filter((w) => nameKey(w.name).includes(key) || w.code.toUpperCase().includes(askedCode)) : [];
  return { all, matches };
}

async function stock(ctx: ReadContext, asked: string): Promise<Drafted> {
  if (!can(ctx.principal, 'view', 'inventory_movement')) return denied(ctx);
  const w = words(ctx.locale);
  const { all, matches } = await warehousesFor(ctx, asked);
  const what = L(ctx.locale, 'warehouse', 'مخزن');
  if (matches.length === 0) return { text: w.noMatch(what, all.slice(0, 20).map((x) => `${x.code} · ${x.name}`)), detail: { asked } };
  if (matches.length > 1) return { text: w.choose(what, matches.map((x) => `${x.code} · ${x.name}`)), detail: { asked, candidates: matches.map((x) => x.code) } };
  const chosen = matches[0]!;
  const m = messagesFor(ctx.locale);
  const built = await reports.warehousesReport({ tx: ctx.tx, principal: ctx.principal, branchCode: ctx.branchCode, locale: ctx.locale, m }, new URLSearchParams({ warehouse: chosen.code }));
  if (!built) return { text: w.none };
  const table = built.model.tables[0]!;
  const rows = table.rows.filter((r) => r.counts !== false && (r.tone ?? 'line') === 'line');
  const head = `${L(ctx.locale, 'Stock in', 'المخزون في')} ${chosen.code} · ${chosen.name} — ${w.rows(rows.length)}`;
  const inline = rows.slice(0, ctx.settings.inlineRows).map((r) => `• ${r.cells.item_name ?? r.cells.item_code} — ${quantity(r.cells.quantity)} ${r.cells.unit ?? ''} — ${money(r.cells.total_price)} IQD`);
  const total = table.totals?.cells.total_price;
  const lines = [head, ...inline];
  if (rows.length > ctx.settings.inlineRows) lines.push(L(ctx.locale, `… and ${rows.length - ctx.settings.inlineRows} more in the attached file.`, `… و${rows.length - ctx.settings.inlineRows} أخرى في الملف المرفق.`));
  if (total) lines.push(L(ctx.locale, `Total at FIFO cost: ${money(total, 'IQD')}`, `الإجمالي بكلفة FIFO: ${money(total, 'IQD')}`));
  if (rows.length === 0) lines.push(w.none);
  return { text: lines.join('\n'), model: built.model, format: 'xlsx', exportObject: 'inventory_movement', exportKey: 'warehouses_report', detail: { warehouse: chosen.code } };
}

async function payableStatus(ctx: ReadContext, no: string): Promise<Drafted> {
  if (!can(ctx.principal, 'view', payables.PERMISSION_OBJECT)) return denied(ctx);
  let v: Awaited<ReturnType<typeof payables.view>>;
  try {
    v = await payables.view(ctx.tx, no);
  } catch {
    return { text: L(ctx.locale, `No payable ${no} that you can see.`, `لا يوجد مستحق ${no} يمكنك رؤيته.`), detail: { no } };
  }
  const p = v.payable;
  const owners = v.holds.length
    ? await ctx.tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, v.holds.map((h) => h.ownerUserId).filter((x): x is string => Boolean(x))))
    : [];
  const nameOf = (id: string | null) => owners.find((o) => o.id === id)?.name ?? '—';
  const [stage] = (
    await ctx.tx.execute(sql`select name from payable_stage where payable_type_code = ${p.payableTypeCode} and code = ${p.stageCode} limit 1`)
  ).rows as { name: string }[];
  const stageName = stage?.name ?? p.stageCode;
  const lines = [
    `*${p.payableNo}* · ${v.type.name} · ${v.supplier?.name ?? '—'}`,
    L(ctx.locale, `Amount: ${money(p.amountTxn, p.currency)} (${money(p.amountIqd, 'IQD')})`, `المبلغ: ${money(p.amountTxn, p.currency)} (${money(p.amountIqd, 'IQD')})`),
    L(ctx.locale, `Stage: ${stageName} since ${day(p.stageSince)}`, `المرحلة: ${stageName} منذ ${day(p.stageSince)}`),
    L(ctx.locale, `Due: ${p.dueDate ?? '—'} · Branch ${p.branchCode}`, `الاستحقاق: ${p.dueDate ?? '—'} · الفرع ${p.branchCode}`),
    p.onHold
      ? L(ctx.locale, `STOPPED — ${v.holds.map((h) => `${h.reasonCode} (owner ${nameOf(h.ownerUserId)}, since ${day(h.startedAt)})`).join('; ')}`, `موقوف — ${v.holds.map((h) => `${h.reasonCode} (المالك ${nameOf(h.ownerUserId)}، منذ ${day(h.startedAt)})`).join('؛ ')}`)
      : L(ctx.locale, 'Not stopped.', 'غير موقوف.'),
    L(ctx.locale, `Invoices: ${v.invoices.length} · Lines: ${v.lines.length}`, `الفواتير: ${v.invoices.length} · السطور: ${v.lines.length}`),
  ];
  if (p.cancelledAt) lines.push(L(ctx.locale, 'CANCELLED', 'ملغى'));
  if (p.closedAt) lines.push(L(ctx.locale, 'Closed.', 'مغلق.'));
  return { text: lines.join('\n'), detail: { no: p.payableNo, stage: p.stageCode, onHold: p.onHold } };
}

async function applicationStatus(ctx: ReadContext, no: string): Promise<Drafted> {
  if (!can(ctx.principal, 'view', paymentApplications.PERMISSION_OBJECT)) return denied(ctx);
  let v: Awaited<ReturnType<typeof paymentApplications.view>>;
  try {
    v = await paymentApplications.view(ctx.tx, no);
  } catch {
    return { text: L(ctx.locale, `No payment application ${no} that you can see.`, `لا يوجد طلب دفع ${no} يمكنك رؤيته.`), detail: { no } };
  }
  const a = v.application;
  const lines = [
    `*${a.applicationNo}* · ${v.payable.payableNo} · ${v.supplier?.name ?? '—'}`,
    L(ctx.locale, `Amount: ${money(a.amountTxn, a.currency)} · ${v.method.name} · ${v.account.code}`, `المبلغ: ${money(a.amountTxn, a.currency)} · ${v.method.name} · ${v.account.code}`),
    L(ctx.locale, `Status: ${a.status}${v.daysWaiting !== null ? ` — waiting ${v.daysWaiting} days` : ''}`, `الحالة: ${a.status}${v.daysWaiting !== null ? ` — بانتظار ${v.daysWaiting} يوم` : ''}`),
    L(ctx.locale, `Sent: ${day(a.sentAt)} by ${v.people.sentBy ?? '—'} · Confirmed: ${day(a.confirmedAt)}`, `أُرسل: ${day(a.sentAt)} بواسطة ${v.people.sentBy ?? '—'} · تأكد: ${day(a.confirmedAt)}`),
  ];
  if (v.documentNo) lines.push(L(ctx.locale, `Posted as ${v.documentNo}`, `مرحّل باسم ${v.documentNo}`));
  return { text: lines.join('\n'), detail: { no: a.applicationNo, status: a.status } };
}

async function swift(ctx: ReadContext, minDays: number): Promise<Drafted> {
  if (!can(ctx.principal, 'view', paymentApplications.PERMISSION_OBJECT)) return denied(ctx);
  const rows = await payablesSweep.swiftPendingApplications(ctx.tx, { minDays, asOf: ctx.today });
  const w = words(ctx.locale);
  const m = messagesFor(ctx.locale);
  const title = L(ctx.locale, `SWIFT pending${minDays > 0 ? ` more than ${minDays} days` : ''}`, `سويفت معلق${minDays > 0 ? ` أكثر من ${minDays} يوم` : ''}`);
  const lines = [`${title} — ${w.rows(rows.length)}`];
  for (const r of rows.slice(0, ctx.settings.inlineRows)) lines.push(`• ${r.applicationNo} · ${r.supplierName} · ${money(r.amountTxn, r.currency)} · ${r.days}d · ${r.accountCode}`);
  if (rows.length === 0) lines.push(w.none);
  const model = tableModel({
    ctx,
    title,
    fileName: `swift-pending-${ctx.today}`,
    columns: [
      { key: 'application', label: m.column('application_no'), kind: 'code' },
      { key: 'payable', label: m.column('payable_no'), kind: 'code' },
      { key: 'supplier', label: m.column('supplier'), kind: 'text', weight: 1.6 },
      { key: 'amount', label: m.column('amount'), kind: 'money' },
      { key: 'currency', label: m.column('currency'), kind: 'code' },
      { key: 'account', label: m.column('account'), kind: 'code' },
      { key: 'sent_on', label: m.column('sent_on'), kind: 'date' },
      { key: 'days', label: m.column('days'), kind: 'quantity' },
      { key: 'sent_by', label: m.column('sent_by'), kind: 'text' },
    ],
    rows: rows.map((r) => ({ application: r.applicationNo, payable: r.payableNo, supplier: r.supplierName, amount: r.amountTxn, currency: r.currency, account: r.accountCode, sent_on: r.sentOn, days: String(r.days), sent_by: r.sentByName })),
  });
  return { text: lines.join('\n'), model, format: 'xlsx', exportObject: paymentApplications.PERMISSION_OBJECT, exportKey: 'swift_pending', detail: { minDays, count: rows.length } };
}

async function due(ctx: ReadContext): Promise<Drafted> {
  if (!can(ctx.principal, 'view', payables.PERMISSION_OBJECT)) return denied(ctx);
  const waiting = await dashboard.waitingFor(ctx.tx, ctx.principal);
  const rows = waiting.dueThisWeek;
  const w = words(ctx.locale);
  const m = messagesFor(ctx.locale);
  const title = L(ctx.locale, 'Payables due this week', 'المستحقات هذا الأسبوع');
  const lines = [`${title} — ${w.rows(rows.length)}`];
  for (const r of rows.slice(0, ctx.settings.inlineRows)) lines.push(`• ${r.dueDate} · ${r.payableNo} · ${r.supplierName} · ${money(r.amountTxn, r.currency)}`);
  if (rows.length === 0) lines.push(w.none);
  const model = tableModel({
    ctx,
    title,
    fileName: `due-this-week-${ctx.today}`,
    columns: [
      { key: 'due_date', label: m.column('due_date'), kind: 'date' },
      { key: 'payable', label: m.column('payable_no'), kind: 'code' },
      { key: 'supplier', label: m.column('supplier'), kind: 'text', weight: 1.6 },
      { key: 'amount', label: m.column('amount'), kind: 'money' },
      { key: 'currency', label: m.column('currency'), kind: 'code' },
    ],
    rows: rows.map((r) => ({ due_date: r.dueDate, payable: r.payableNo, supplier: r.supplierName, amount: r.amountTxn, currency: r.currency })),
  });
  return { text: lines.join('\n'), model, format: 'xlsx', exportObject: payables.PERMISSION_OBJECT, exportKey: 'due_this_week', detail: { count: rows.length } };
}

async function stopped(ctx: ReadContext, needsReason: boolean): Promise<Drafted> {
  if (!can(ctx.principal, 'view', payables.PERMISSION_OBJECT)) return denied(ctx);
  const page = await payables.workbench(ctx.tx, { stopped: needsReason ? 'needs_reason' : 'yes', pageSize: 100 });
  const rows = page.rows;
  const ownerIds = rows.map((r) => r.hold?.ownerUserId ?? null).filter((x): x is string => Boolean(x));
  const owners = ownerIds.length ? await ctx.tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, ownerIds)) : [];
  const nameOf = (id: string | null) => owners.find((o) => o.id === id)?.name ?? '—';
  const w = words(ctx.locale);
  const m = messagesFor(ctx.locale);
  const title = needsReason ? L(ctx.locale, 'Stopped payables needing a reason', 'مستحقات موقوفة بلا سبب') : L(ctx.locale, 'Stopped payables', 'المستحقات الموقوفة');
  const daysOf = (startedAt: Date | string | null) => (startedAt ? daysBetween(day(startedAt), ctx.today) : 0);
  const lines = [`${title} — ${w.rows(page.total)}`];
  for (const r of rows.slice(0, ctx.settings.inlineRows)) lines.push(`• ${r.payableNo} · ${r.supplierName} · ${money(r.amountTxn, r.currency)} · ${r.hold?.reasonCode ?? '—'} · ${nameOf(r.hold?.ownerUserId ?? null)} · ${daysOf(r.hold?.startedAt ?? null)}d`);
  if (rows.length === 0) lines.push(w.none);
  const model = tableModel({
    ctx,
    title,
    fileName: `stopped-${ctx.today}`,
    columns: [
      { key: 'payable', label: m.column('payable_no'), kind: 'code' },
      { key: 'supplier', label: m.column('supplier'), kind: 'text', weight: 1.6 },
      { key: 'amount', label: m.column('amount'), kind: 'money' },
      { key: 'currency', label: m.column('currency'), kind: 'code' },
      { key: 'stage', label: m.column('stage'), kind: 'text' },
      { key: 'reason', label: m.column('reason'), kind: 'code' },
      { key: 'owner', label: m.column('owner'), kind: 'text' },
      { key: 'since', label: m.column('since'), kind: 'date' },
      { key: 'days', label: m.column('days'), kind: 'quantity' },
    ],
    rows: rows.map((r) => ({ payable: r.payableNo, supplier: r.supplierName, amount: r.amountTxn, currency: r.currency, stage: r.stageName, reason: r.hold?.reasonCode ?? null, owner: nameOf(r.hold?.ownerUserId ?? null), since: r.hold?.startedAt ? day(r.hold.startedAt) : null, days: String(daysOf(r.hold?.startedAt ?? null)) })),
  });
  return { text: lines.join('\n'), model, format: 'xlsx', exportObject: payables.PERMISSION_OBJECT, exportKey: needsReason ? 'stopped_needs_reason' : 'stopped', detail: { needsReason, count: page.total } };
}

async function partnerBalance(ctx: ReadContext, side: 'supplier' | 'customer', asked: string): Promise<Drafted> {
  if (!can(ctx.principal, 'view', 'business_partner')) return denied(ctx);
  const w = words(ctx.locale);
  const roll = await partners.listByRole(ctx.tx, side);
  const askedCode = asked.trim().toUpperCase();
  let matches = roll.filter((p) => p.code.toUpperCase() === askedCode);
  if (matches.length === 0) {
    const key = nameKey(asked);
    matches = key ? roll.filter((p) => nameKey(p.legalName).includes(key) || nameKey(p.tradeName ?? '').includes(key) || p.code.toUpperCase().includes(askedCode)) : [];
  }
  const what = side === 'supplier' ? L(ctx.locale, 'supplier', 'مورد') : L(ctx.locale, 'customer', 'زبون');
  if (matches.length === 0) return { text: w.noMatch(what, []), detail: { asked } };
  if (matches.length > 1) return { text: w.choose(what, matches.slice(0, 15).map((p) => `${p.code} · ${p.legalName}`)), detail: { asked, candidates: matches.slice(0, 15).map((p) => p.code) } };
  const chosen = matches[0]!;
  const iqd = await partnerStatement.statementFor(ctx.tx, side, chosen.code, { to: ctx.today, currency: 'IQD' });
  const usd = await partnerStatement.statementFor(ctx.tx, side, chosen.code, { to: ctx.today, currency: 'USD' });
  const lines = [
    `*${chosen.code}* · ${chosen.legalName}`,
    L(ctx.locale, `Balance IQD: ${money(iqd.closing, 'IQD')}`, `الرصيد بالدينار: ${money(iqd.closing, 'IQD')}`),
    L(ctx.locale, `Balance USD: ${money(usd.closing, 'USD')}`, `الرصيد بالدولار: ${money(usd.closing, 'USD')}`),
    L(ctx.locale, `Movements this year: ${iqd.lines.length}`, `الحركات هذه السنة: ${iqd.lines.length}`),
  ];
  const m = messagesFor(ctx.locale);
  const year = ctx.today.slice(0, 4);
  const built = await reports.partnerStatement({ tx: ctx.tx, principal: ctx.principal, branchCode: ctx.branchCode, locale: ctx.locale, m }, side, new URLSearchParams({ code: chosen.code, from: `${year}-01-01`, to: ctx.today, currency: 'IQD' }));
  return {
    text: lines.join('\n'),
    model: built?.model ?? null,
    format: 'pdf',
    attachAlways: true,
    exportObject: 'business_partner',
    exportKey: `${side}_statement`,
    detail: { party: chosen.code, closingIqd: iqd.closing, closingUsd: usd.closing },
  };
}

export { businessPartner, payableHold };
