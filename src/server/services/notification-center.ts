/**
 * The notification centre's reader — platform phase, Agent 6.
 *
 * `notifications.ts` writes and counts; this file answers the two questions a
 * person puts to a notification: *what does it say to me* and *where does it
 * lead, and may I still go there*.
 *
 * ── The target is worked out, never stored ────────────────────────────────
 * A notification names its subject (`object_type`, `object_id`) and may carry
 * a local `href` in its context. Resolution runs in the **reader's** scope
 * (their row-level security, their grants) in this order, and the first
 * resolver that knows the subject decides:
 *
 *   1. the subject's own resolver (a conversation, a period, a chart account,
 *      a numbered HR document, a fixed screen);
 *   2. the record registry the Document Center keeps (`cloud-link-targets`):
 *      the kind's permission object plus a row the reader can see, plus the
 *      attachment parent check where the owning module gave one;
 *   3. the emitter's `href`/`link`, if it is a path on this site whose screen
 *      is served and whose permission object the reader holds.
 *
 * "No longer available" is the answer for everything else — a record that
 * was removed, moved out of the reader's branch, or whose grant was taken
 * away; a screen that is not served. A refusal also hides the notification's
 * text (it may name a party or an amount the reader may no longer see), and
 * the row is drawn without a link: there is no dead link to click.
 *
 * Resolution is repeated when the link is clicked (`open`), because the list
 * may be minutes old.
 *
 * ── Audit grain ───────────────────────────────────────────────────────────
 * Reading, un-reading and opening a notification are the recipient's own
 * state and are **not** audited — a row per click would bury the trail's real
 * events and `read_at` already records the fact. The one bulk act, "mark all
 * read", writes one `notification.marked_all_read` row with the count and the
 * category; the audit of what was *raised* is the audit of the event that
 * raised it.
 */
import { sql } from 'drizzle-orm';
import { applyScope, type Tx } from '../db/client';
import {
  isLocalHref,
  kindDef,
  labelParams,
  pathOf,
  type LabelParams,
  type NotificationCategory,
} from '../domain/notification-center';
import { can, type Principal } from '../domain/permissions';
import { screenRoutes } from '../domain/screens';
import { visibleRoute } from '../delivered';
import * as audit from './audit';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as cloudTargets from './cloud-link-targets';
import * as notifications from './notifications';

const enc = encodeURIComponent;

export type UnavailableReason = 'no_target' | 'no_access' | 'not_found' | 'not_served';

export type Target =
  | { readonly status: 'ok'; readonly href: string }
  | { readonly status: 'unavailable'; readonly reason: UnavailableReason };

const ok = (href: string): Target => ({ status: 'ok', href });
const no = (reason: UnavailableReason): Target => ({ status: 'unavailable', reason });

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

type Subject = Pick<notifications.NotificationItem, 'kind' | 'objectType' | 'objectId' | 'context'>;
type Resolver = (tx: Tx, principal: Principal, subject: Subject) => Promise<Target>;

const hintOf = (subject: Subject): string | null => {
  const c = subject.context ?? {};
  for (const value of [c.href, c.link]) if (isLocalHref(value)) return value;
  return null;
};

let routeObjects: ReadonlyMap<string, string> | null = null;

/** The permission object behind a screen — its own, or its list's for a record under it. */
function objectOfRoute(path: string): string | null {
  if (routeObjects === null) {
    routeObjects = new Map([...screenRoutes()].map(([route, screen]) => [route, screen.item.object]));
  }
  const exact = routeObjects.get(path);
  if (exact) return exact;
  const parent = path.replace(/\/[^/]+$/, '');
  return parent.length > 1 ? (routeObjects.get(parent) ?? null) : null;
}

/** A path the reader may be sent to: served, and the reader holds `view` on its screen's object. */
function served(principal: Principal, href: string): Target {
  const path = pathOf(href);
  if (!visibleRoute(path)) return no('not_served');
  const object = objectOfRoute(path);
  if (object !== null && !can(principal, 'view', object)) return no('no_access');
  return ok(href);
}

/** A screen with no record behind it (the periods screen, the stock checks). */
const fixedPage =
  (href: string, object: string): Resolver =>
  async (_tx, principal) =>
    !can(principal, 'view', object) ? no('no_access') : visibleRoute(pathOf(href)) ? ok(href) : no('not_served');

async function exists(tx: Tx, query: ReturnType<typeof sql>): Promise<boolean> {
  const result = await tx.execute(query);
  return result.rows.length > 0;
}

/**
 * A document addressed by its number, found in the reader's own scope. No
 * grant is required here: an HR document is also the person's own and their
 * manager's (`app_employee_reach`), and the row policy is what says so.
 */
const numbered =
  (table: string, column: string, route: string): Resolver =>
  async (tx, principal, subject) => {
    const found = await exists(tx, sql`select 1 from ${sql.identifier(table)} where ${sql.identifier(column)} = ${subject.objectId} limit 1`);
    if (!found) return no('not_found');
    return served(principal, `${route}/${enc(subject.objectId)}`);
  };

const conversation: Resolver = async (tx, principal, subject) => {
  if (!can(principal, 'view', 'chat')) return no('no_access');
  // Membership is the database's: a conversation the reader is not in is not visible to them (C-60).
  const found = /^[0-9a-f-]{36}$/i.test(subject.objectId)
    ? await exists(tx, sql`select 1 from chat_conversation where id = ${subject.objectId}::uuid limit 1`)
    : false;
  return found ? served(principal, `/chat?c=${subject.objectId}`) : no('not_found');
};

const chartAccount: Resolver = async (tx, principal, subject) => {
  if (!can(principal, 'view', 'chart_of_account')) return no('no_access');
  const result = await tx.execute(
    /^[0-9a-f-]{36}$/i.test(subject.objectId)
      ? sql`select code from chart_of_account where id = ${subject.objectId}::uuid limit 1`
      : sql`select code from chart_of_account where code = ${subject.objectId} limit 1`,
  );
  const code = (result.rows[0] as { code: string } | undefined)?.code;
  return code ? served(principal, `/master-data/chart-of-accounts/${enc(code)}`) : no('not_found');
};

const bankAccount: Resolver = async (tx, principal, subject) => {
  if (!can(principal, 'view', 'business_partner')) return no('no_access');
  if (!/^[0-9a-f-]{36}$/i.test(subject.objectId)) return no('not_found');
  const result = await tx.execute(sql`
    select p.code from partner_bank_account b join business_partner p on p.id = b.partner_id
     where b.id = ${subject.objectId}::uuid limit 1`);
  const code = (result.rows[0] as { code: string } | undefined)?.code;
  return code ? served(principal, `/payables/suppliers/${enc(code)}?role=supplier&account=${subject.objectId}`) : no('not_found');
};

const payslip: Resolver = async (tx, principal, subject) => {
  const result = await tx.execute(sql`select run_no from payroll_line l join payroll_run r on r.id = l.run_id where l.payslip_no = ${subject.objectId} limit 1`);
  const run = (result.rows[0] as { run_no: string } | undefined)?.run_no;
  return run ? served(principal, `/hr/payroll/${enc(run)}`) : no('not_found');
};

/** Subjects with a resolver of their own, by `object_type`. */
const SPECIAL: Readonly<Record<string, Resolver>> = {
  chat_conversation: conversation,
  chart_of_account: chartAccount,
  partner_bank_account: bankAccount,
  fiscal_period: fixedPage('/finance/periods', 'fiscal_period'),
  inventory_movement: fixedPage('/inventory/checks', 'inventory_movement'),
  supplier_shipment: fixedPage('/logistics/in-transit', 'supplier_shipment'),
  leave_request: numbered('leave_request', 'request_no', '/hr/leave'),
  employee_request: numbered('employee_request', 'request_no', '/hr/requests'),
  payroll_run: numbered('payroll_run', 'run_no', '/hr/payroll'),
  payslip,
  employee: numbered('employee', 'employee_no', '/hr/employees'),
  employee_advance: numbered('employee_advance', 'advance_no', '/hr/advances'),
  employee_document: numbered('employee_document', 'document_no', '/hr/documents'),
  performance_review: numbered('performance_review', 'review_no', '/hr/performance'),
  vacancy: numbered('vacancy', 'vacancy_no', '/hr/recruitment'),
  applicant: numbered('applicant', 'applicant_no', '/hr/recruitment/applicants'),
};

/**
 * Where a notification leads for this reader, now. Never throws: a subject
 * the reader cannot open, a record that is gone and a screen that is not served
 * are all "unavailable", which the screen draws without a link.
 */
export async function resolveTarget(tx: Tx, principal: Principal, subject: Subject): Promise<Target> {
  try {
    const special = SPECIAL[subject.objectType];
    if (special) return await special(tx, principal, subject);

    if (cloudTargets.targetOf(subject.objectType)) {
      const record = await cloudTargets.openRecord(tx, principal, subject.objectType, subject.objectId);
      if (!record) return no('no_access');
      // The emitter may know a better page for this very record (a credit note is an invoice row).
      const hint = hintOf(subject);
      const href = hint && visibleRoute(pathOf(hint)) ? hint : record.href;
      return served(principal, href);
    }

    const hint = hintOf(subject);
    if (!hint) return no('no_target');
    const def = kindDef(subject.kind);
    if (def.object && !can(principal, def.verb ?? 'view', def.object)) return no('no_access');
    return served(principal, hint);
  } catch {
    return no('not_found');
  }
}

// ---------------------------------------------------------------------------
// What the bell and the screen draw
// ---------------------------------------------------------------------------

export interface FeedItem {
  readonly id: string;
  readonly kind: string;
  readonly category: NotificationCategory;
  /** The stored text; empty when the reader may no longer see what it was about. */
  readonly subject: string;
  readonly body: string;
  readonly params: LabelParams;
  /** The body is somebody's own words and is shown as written. */
  readonly userText: boolean;
  readonly createdAt: string;
  readonly read: boolean;
  readonly acted: boolean;
  /** False: "no longer available" — drawn without a link. */
  readonly openable: boolean;
  readonly reason: UnavailableReason | null;
}

export interface Feed {
  readonly unread: number;
  readonly total: number;
  readonly categories: readonly notifications.CategoryCount[];
  readonly items: readonly FeedItem[];
  readonly page: number;
  readonly pages: number;
  readonly count: number;
}

const HIDES_TEXT: ReadonlySet<UnavailableReason> = new Set(['no_access', 'not_found']);

export async function withTargets(
  tx: Tx,
  principal: Principal,
  rows: readonly notifications.NotificationItem[],
): Promise<FeedItem[]> {
  const memo = new Map<string, Target>();
  const items: FeedItem[] = [];
  for (const row of rows) {
    const key = `${row.objectType}|${row.objectId}|${row.kind}`;
    let target = memo.get(key);
    if (!target) {
      target = await resolveTarget(tx, principal, row);
      memo.set(key, target);
    }
    const reason = target.status === 'unavailable' ? target.reason : null;
    const hidden = reason !== null && HIDES_TEXT.has(reason);
    items.push({
      id: row.id,
      kind: row.kind,
      category: row.category,
      subject: hidden ? '' : row.subject,
      body: hidden ? '' : row.body,
      params: hidden ? labelParams({ objectId: '', context: null }) : labelParams(row),
      userText: !hidden && Boolean(kindDef(row.kind).userText),
      createdAt: row.createdAt.toISOString(),
      read: row.readAt !== null,
      acted: row.actedAt !== null,
      openable: target.status === 'ok',
      reason,
    });
  }
  return items;
}

export interface FeedRequest extends notifications.ListOptions {}

/** The bell's and the screen's one read: the counts, the page, and where each row leads. */
export async function feedFor(tx: Tx, ctx: ActorContext, request: FeedRequest = {}): Promise<Feed> {
  const userId = ctx.principal.userId;
  const counts = await notifications.countsFor(tx, userId);
  const page = await notifications.listFor(tx, userId, request);
  return {
    unread: counts.unread,
    total: counts.total,
    categories: counts.categories,
    items: await withTargets(tx, ctx.principal, page.rows),
    page: page.page,
    pages: page.pages,
    count: page.total,
  };
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export type OpenOutcome =
  | { readonly status: 'ok'; readonly href: string }
  | { readonly status: 'unavailable'; readonly reason: UnavailableReason }
  | { readonly status: 'missing' };

/**
 * Click: resolve again in the reader's scope and, only if they can go there,
 * mark the notification read and hand back the address. A notification that is
 * not theirs is `missing` — the same answer as one that does not exist.
 */
export async function open(tx: Tx, ctx: ActorContext, id: bigint, options: { markRead?: boolean } = {}): Promise<OpenOutcome> {
  const row = await notifications.findFor(tx, ctx.principal.userId, id);
  if (!row) return { status: 'missing' };
  const target = await resolveTarget(tx, ctx.principal, row);
  if (target.status !== 'ok') return target;
  if (options.markRead !== false) await notifications.markRead(tx, id, ctx.principal.userId);
  return target;
}

/**
 * Mark everything (or one category) read — one audit row for the act, with
 * the count, however many notifications it touched.
 */
export async function markAllReadAudited(
  tx: Tx,
  ctx: ActorContext,
  options: { readonly category?: NotificationCategory | null } = {},
): Promise<number> {
  const changed = await notifications.markAllRead(tx, ctx.principal.userId, options);
  if (changed > 0) {
    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'notification.marked_all_read',
      objectType: 'notification',
      objectId: ctx.principal.userId,
      branchCode: ctx.branchCode || null,
      after: { count: changed, category: options.category ?? 'all' },
      outcome: 'success',
      requestId: ctx.requestId ?? null,
    });
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Asking as somebody else, in this transaction
// ---------------------------------------------------------------------------

/**
 * Whether a person can open a record — asked as them (their principal, their
 * row-level scope) **inside the caller's transaction**, so a record made a
 * moment ago and not yet committed is seen. The caller's scope is put back
 * whatever happens. Used when a notification is raised for a named person
 * (`emit({ recordAccess: true })`); the same question is asked again when it
 * is shown and clicked.
 */
export async function mayOpenAs(tx: Tx, userId: string, type: string, id: string): Promise<boolean> {
  const was = (
    await tx.execute(sql`select current_setting('app.user_id', true) as u, current_setting('app.branch_code', true) as b, current_setting('app.is_super_user', true) as s`)
  ).rows[0] as { u: string | null; b: string | null; s: string | null };
  try {
    const principal = await authz.loadPrincipal(tx, userId);
    if (!principal.isActive) return false;
    await applyScope(tx, { userId, branchCode: principal.defaultBranchCode ?? '', isSuperUser: principal.isSuperUser });
    const target = await resolveTarget(tx, principal, { kind: '', objectType: type, objectId: id, context: null });
    return target.status === 'ok';
  } catch {
    return false;
  } finally {
    await applyScope(tx, { userId: was.u ?? '', branchCode: was.b ?? '', isSuperUser: was.s === 'true' });
  }
}
