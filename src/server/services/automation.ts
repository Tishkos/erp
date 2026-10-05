/**
 * Automation rules — platform phase, Agent 10.
 *
 * The only writer of `automation_rule`, `automation_rule_version` and
 * `automation_setting`. A rule is built from one of the four templates
 * (`domain/automation-templates.ts`) and is BORN OFF; an administrator turns it
 * on. Saving a change writes a new version (append-only) and the rule's owner
 * becomes the person who saved it: a rule runs with its owner's permissions
 * (`services/automation-runner.ts`), so whoever puts their name on the current
 * definition answers for what it can do.
 *
 * Who may do what here is `automation` `administer` (a Super User holds every
 * verb). The rule can then do only what its owner could do by hand — setting a
 * rule up does not widen anybody's reach.
 *
 * The run log, the outbox and the kill switch's reads are here too; the runner
 * writes them.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { automationRule, automationRuleVersion, automationSetting } from '../db/schema';
import {
  AutomationError,
  PAUSE_AFTER_DEFAULT,
  evaluate,
  PAUSE_AFTER_MAX,
  REASON_MAX,
  RULE_SERIES,
  reachOf,
  validateName,
  type Action,
  type Condition,
  type Definition,
  type Reach,
} from '../domain/automation';
import { EVENTS, eventOf, type EventKey } from '../domain/automation-events';
import { buildDefinition, isTemplateCode, parseParams, type Params, type TemplateCode } from '../domain/automation-templates';
import { can, type Principal } from '../domain/permissions';
import { recordChange } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPage, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'automation';
export { AutomationError };

type RuleRow = typeof automationRule.$inferSelect;
type VersionRow = typeof automationRuleVersion.$inferSelect;

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

// ---------------------------------------------------------------------------
// Settings: the global switch and the pause threshold
// ---------------------------------------------------------------------------

export interface AutomationSettings {
  readonly enabled: boolean;
  readonly pauseAfterFailures: number;
}

export async function settings(tx: Tx): Promise<AutomationSettings> {
  const rows = await tx.select().from(automationSetting);
  const get = (key: string) => rows.find((r) => r.key === key)?.value;
  const threshold = Number(get('pause_after_failures') ?? PAUSE_AFTER_DEFAULT);
  return { enabled: (get('enabled') ?? 'on') === 'on', pauseAfterFailures: Number.isInteger(threshold) && threshold > 0 ? threshold : PAUSE_AFTER_DEFAULT };
}

/** The kill switch: with it off, nothing is recorded and no rule runs. */
export async function setSwitch(tx: Tx, ctx: ActorContext, enabled: boolean, reason: string): Promise<void> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const why = (reason ?? '').trim();
  if (why.length < 3 || why.length > REASON_MAX) throw new AutomationError('Say why automation is being switched ' + (enabled ? 'on' : 'off') + '.');
  const before = await settings(tx);
  if (before.enabled === enabled) return;
  await tx
    .update(automationSetting)
    .set({ value: enabled ? 'on' : 'off', updatedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(automationSetting.key, 'enabled'));
  await recordChange(tx, ctx, {
    action: enabled ? 'automation.switched_on' : 'automation.switched_off',
    objectType: PERMISSION_OBJECT,
    objectId: 'enabled',
    before: { enabled: before.enabled },
    after: { enabled },
    reason: why,
  });
}

export async function setPauseThreshold(tx: Tx, ctx: ActorContext, threshold: number): Promise<void> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > PAUSE_AFTER_MAX) throw new AutomationError(`A rule pauses after 1 to ${PAUSE_AFTER_MAX} failed events in a row.`);
  const before = await settings(tx);
  if (before.pauseAfterFailures === threshold) return;
  await tx
    .update(automationSetting)
    .set({ value: String(threshold), updatedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(automationSetting.key, 'pause_after_failures'));
  await recordChange(tx, ctx, {
    action: 'automation.threshold_changed',
    objectType: PERMISSION_OBJECT,
    objectId: 'pause_after_failures',
    before: { pauseAfterFailures: before.pauseAfterFailures },
    after: { pauseAfterFailures: threshold },
  });
}

// ---------------------------------------------------------------------------
// What a definition names must exist
// ---------------------------------------------------------------------------

type Rows<T> = { rows: T[] };

/** The roles, people and sections a definition names exist and are in use; says which one is not. */
export async function assertReferences(tx: Tx, definition: Definition): Promise<void> {
  const roles = new Set<string>();
  const users = new Set<string>();
  const departments = new Set<string>();
  const recipients = (list: readonly { kind: string; roleCode?: string; userId?: string }[]) => {
    for (const r of list) {
      if (r.kind === 'role' && r.roleCode) roles.add(r.roleCode);
      if (r.kind === 'user' && r.userId) users.add(r.userId);
    }
  };
  for (const action of definition.actions) {
    if (action.kind === 'create_notification' || action.kind === 'open_workflow') recipients(action.recipients);
    if (action.kind === 'create_task') {
      recipients([action.assignee]);
      departments.add(action.departmentCode);
    }
  }
  for (const code of roles) {
    const found = (await tx.execute(sql`select 1 from role where code = ${code}`)) as unknown as Rows<unknown>;
    if (found.rows.length === 0) throw new AutomationError(`There is no role "${code}".`);
  }
  for (const id of users) {
    const found = (await tx.execute(sql`select 1 from app_user where id = ${id}::uuid and is_active`)) as unknown as Rows<unknown>;
    if (found.rows.length === 0) throw new AutomationError('The person named for the task is not an active user.');
  }
  for (const code of departments) {
    const found = (await tx.execute(sql`select 1 from department where code = ${code} and active`)) as unknown as Rows<unknown>;
    if (found.rows.length === 0) throw new AutomationError(`There is no active section "${code}".`);
  }
}

function assertOwnerMayBuild(principal: Principal, eventKey: EventKey): void {
  const event = EVENTS[eventKey];
  if (!can(principal, 'view', event.object)) {
    throw new AutomationError(`You may not open ${event.object.replace(/_/g, ' ')} records, so a rule on them would act on what you cannot see.`);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface TemplateInput {
  readonly templateCode: string;
  readonly name: string;
  /** The form's own text, by parameter name. */
  readonly params: Readonly<Record<string, string | undefined>>;
}

interface Built {
  readonly template: TemplateCode;
  readonly name: string;
  readonly params: Params;
  readonly definition: Definition;
}

async function build(tx: Tx, principal: Principal, input: TemplateInput): Promise<Built> {
  if (!isTemplateCode(input.templateCode)) throw new AutomationError(`"${input.templateCode}" is not a rule template.`);
  const name = validateName(input.name);
  const params = parseParams(input.templateCode, input.params);
  const definition = buildDefinition(input.templateCode, params);
  assertOwnerMayBuild(principal, definition.eventKey);
  await assertReferences(tx, definition);
  return { template: input.templateCode, name, params, definition };
}

async function insertVersion(tx: Tx, rule: { id: string; eventKey: string; templateCode: string }, version: number, built: Built, by: string, note: string | null): Promise<void> {
  await tx.insert(automationRuleVersion).values({
    ruleId: rule.id,
    version,
    eventKey: rule.eventKey,
    name: built.name,
    templateCode: rule.templateCode,
    params: built.params as Record<string, string | number | boolean>,
    conditions: [...built.definition.conditions] as Condition[],
    actions: [...built.definition.actions] as Action[],
    changedBy: by,
    changeNote: note,
  });
}

/** A new rule, from a template: OFF, owned by the person who made it. */
export async function createFromTemplate(tx: Tx, ctx: ActorContext, input: TemplateInput): Promise<{ id: string; ruleNo: string }> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const built = await build(tx, ctx.principal, input);
  const me = ctx.principal.userId;
  const allocated = await allocateDocumentNumber(tx, RULE_SERIES, {}, me);
  const [made] = await tx
    .insert(automationRule)
    .values({
      ruleNo: allocated.documentNo,
      eventKey: built.definition.eventKey,
      templateCode: built.template,
      name: built.name,
      ownerUserId: me,
      createdBy: me,
    })
    .returning({ id: automationRule.id });
  await insertVersion(tx, { id: made!.id, eventKey: built.definition.eventKey, templateCode: built.template }, 1, built, me, null);
  await recordChange(tx, ctx, {
    action: 'automation.rule_created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    after: { name: built.name, event: built.definition.eventKey, template: built.template, params: built.params as Record<string, unknown>, enabled: false },
  });
  return { id: made!.id, ruleNo: allocated.documentNo };
}

async function loadRule(tx: Tx, ruleNo: string, options: { lock?: boolean } = {}): Promise<RuleRow> {
  const found = await tx
    .select()
    .from(automationRule)
    .where(eq(automationRule.ruleNo, ruleNo))
    .limit(1)
    .for(options.lock ? 'update' : 'share');
  const row = found[0];
  if (!row) throw new AutomationError(`There is no automation rule ${ruleNo}.`);
  return row;
}

async function currentVersion(tx: Tx, rule: RuleRow): Promise<VersionRow> {
  const [row] = await tx
    .select()
    .from(automationRuleVersion)
    .where(and(eq(automationRuleVersion.ruleId, rule.id), eq(automationRuleVersion.version, rule.currentVersion)))
    .limit(1);
  if (!row) throw new AutomationError(`${rule.ruleNo}: its current version is missing.`);
  return row;
}

/** Equal as data: PostgreSQL keeps a jsonb's keys in its own order, so the text of two equal sets can differ. */
function sameParams(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, i) => key === other[i] && a[key] === b[key]);
}

/**
 * Changes a rule: a new version, never an edit in place. The rule's owner
 * becomes the person who saved it (their permissions are what it will run with),
 * and an enabled rule goes on running — as the new owner, from the new version.
 */
export async function change(tx: Tx, ctx: ActorContext, ruleNo: string, input: Omit<TemplateInput, 'templateCode'> & { readonly note?: string | null }): Promise<{ version: number }> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const rule = await loadRule(tx, ruleNo, { lock: true });
  const built = await build(tx, ctx.principal, { ...input, templateCode: rule.templateCode });
  const before = await currentVersion(tx, rule);
  const note = (input.note ?? '').trim() || null;
  if (note !== null && note.length > REASON_MAX) throw new AutomationError(`The note is at most ${REASON_MAX} characters.`);
  const same = sameParams(before.params, built.params) && before.name === built.name;
  if (same) throw new AutomationError('Nothing was changed.');
  const version = rule.currentVersion + 1;
  await insertVersion(tx, rule, version, built, ctx.principal.userId, note);
  await tx
    .update(automationRule)
    .set({ currentVersion: version, name: built.name, ownerUserId: ctx.principal.userId })
    .where(eq(automationRule.id, rule.id));
  await recordChange(tx, ctx, {
    action: 'automation.rule_changed',
    objectType: PERMISSION_OBJECT,
    objectId: ruleNo,
    before: { version: rule.currentVersion, name: before.name, params: before.params, owner: rule.ownerUserId },
    after: { version, name: built.name, params: built.params as Record<string, unknown>, owner: ctx.principal.userId },
    reason: note,
  });
  return { version };
}

/** What the person turning a rule on would make it do: each action against their own permissions. */
export function reachFor(principal: Principal, eventKey: EventKey, actions: readonly Action[]): Reach[] {
  return actions.map((a) => reachOf(principal, eventKey, a));
}

/**
 * Turns a rule on. The person who does it becomes its owner — the rule will run
 * with their permissions — so it is refused when none of its actions is
 * something they could do by hand: it would only ever skip.
 */
export async function enable(tx: Tx, ctx: ActorContext, ruleNo: string): Promise<void> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const rule = await loadRule(tx, ruleNo, { lock: true });
  if (rule.enabled) throw new AutomationError(`${ruleNo} is already on.`);
  const version = await currentVersion(tx, rule);
  const definition: Definition = { eventKey: rule.eventKey as EventKey, conditions: version.conditions, actions: version.actions };
  assertOwnerMayBuild(ctx.principal, definition.eventKey);
  await assertReferences(tx, definition);
  const reach = reachFor(ctx.principal, definition.eventKey, definition.actions);
  if (reach.every((r) => !r.ok)) {
    throw new AutomationError(`You could not do any of this rule's actions yourself (${reach[0]?.missing.map((m) => `${m.verb} on ${m.object.replace(/_/g, ' ')}`).join(', ')} missing), and it runs with your permissions, so it would only ever skip.`);
  }
  await tx
    .update(automationRule)
    .set({ enabled: true, enabledBy: ctx.principal.userId, ownerUserId: ctx.principal.userId })
    .where(eq(automationRule.id, rule.id));
  await recordChange(tx, ctx, {
    action: 'automation.rule_enabled',
    objectType: PERMISSION_OBJECT,
    objectId: ruleNo,
    before: { enabled: false, owner: rule.ownerUserId, pausedReason: rule.pausedReason },
    after: { enabled: true, owner: ctx.principal.userId, version: rule.currentVersion },
  });
}

/** Turns a rule off, with a reason. Its history stays. */
export async function disable(tx: Tx, ctx: ActorContext, ruleNo: string, reason: string): Promise<void> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const why = (reason ?? '').trim();
  if (why.length < 3 || why.length > REASON_MAX) throw new AutomationError('Say why the rule is being switched off.');
  const rule = await loadRule(tx, ruleNo, { lock: true });
  if (!rule.enabled) throw new AutomationError(`${ruleNo} is already off.`);
  await tx.update(automationRule).set({ enabled: false }).where(eq(automationRule.id, rule.id));
  await recordChange(tx, ctx, {
    action: 'automation.rule_disabled',
    objectType: PERMISSION_OBJECT,
    objectId: ruleNo,
    before: { enabled: true },
    after: { enabled: false },
    reason: why,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const STATES = ['all', 'on', 'off', 'paused', 'failing'] as const;
export type StateFilter = (typeof STATES)[number];
export const isState = (value: string | null | undefined): value is StateFilter => (STATES as readonly string[]).includes(value ?? '');

export interface RuleListFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly state?: StateFilter | null;
  readonly eventKey?: string | null;
}

export interface RuleListRow {
  readonly id: string;
  readonly ruleNo: string;
  readonly name: string;
  readonly eventKey: EventKey;
  readonly templateCode: string;
  readonly version: number;
  readonly ownerName: string;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  readonly consecutiveFailures: number;
  readonly failedRuns: number;
  readonly doneRuns: number;
  readonly lastRunAt: string | null;
  readonly lastOutcome: string | null;
  readonly updatedAt: string;
}

export async function listRules(tx: Tx, principal: Principal, filter: RuleListFilter = {}): Promise<RegisterPage<RuleListRow>> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return { rows: [], total: 0, page: 1, pageSize: filter.pageSize ?? 50, pages: 1 };
  const state = isState(filter.state ?? null) ? filter.state! : 'all';
  const where = whereOf([
    searchOf([sql`r.rule_no`, sql`r.name`, sql`r.event_key`, sql`u.display_name`], filter.search),
    filter.eventKey && eventOf(filter.eventKey) ? sql`r.event_key = ${filter.eventKey}` : null,
    state === 'on' ? sql`r.enabled` : null,
    state === 'off' ? sql`not r.enabled and r.paused_at is null` : null,
    state === 'paused' ? sql`r.paused_at is not null` : null,
    state === 'failing' ? sql`r.consecutive_failures > 0` : null,
  ]);
  const from = sql`from automation_rule r join app_user u on u.id = r.owner_user_id ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) => {
      const result = (await tx.execute(sql`
        select r.id::text, r.rule_no as "ruleNo", r.name, r.event_key as "eventKey", r.template_code as "templateCode",
               r.current_version as "version", u.display_name as "ownerName", r.enabled, r.paused_reason as "pausedReason",
               r.consecutive_failures as "consecutiveFailures",
               (select count(*)::int from automation_run x where x.rule_id = r.id and x.outcome = 'failed') as "failedRuns",
               (select count(*)::int from automation_run x where x.rule_id = r.id and x.outcome = 'done') as "doneRuns",
               r.last_run_at as "lastRunAt", r.last_outcome as "lastOutcome", r.updated_at as "updatedAt"
          ${from}
         order by r.rule_no desc
         limit ${limit} offset ${offset}`)) as unknown as Rows<Omit<RuleListRow, 'lastRunAt' | 'updatedAt'> & { lastRunAt: Date | string | null; updatedAt: Date | string }>;
      return result.rows.map((row) => ({ ...row, lastRunAt: iso(row.lastRunAt), updatedAt: iso(row.updatedAt)! }));
    },
  });
}

export interface RuleRecord {
  readonly id: string;
  readonly ruleNo: string;
  readonly name: string;
  readonly eventKey: EventKey;
  readonly templateCode: TemplateCode;
  readonly version: number;
  readonly ownerUserId: string;
  readonly ownerName: string;
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly enabledByName: string | null;
  readonly pausedAt: string | null;
  readonly pausedReason: string | null;
  readonly consecutiveFailures: number;
  readonly lastRunAt: string | null;
  readonly lastOutcome: string | null;
  readonly createdByName: string;
  readonly createdAt: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly conditions: readonly Condition[];
  readonly actions: readonly Action[];
}

export async function byNo(tx: Tx, principal: Principal, ruleNo: string): Promise<RuleRecord | null> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return null;
  const result = (await tx.execute(sql`
    select r.id::text, r.rule_no as "ruleNo", r.name, r.event_key as "eventKey", r.template_code as "templateCode",
           r.current_version as "version", r.owner_user_id::text as "ownerUserId", o.display_name as "ownerName", r.enabled,
           r.enabled_at as "enabledAt", e.display_name as "enabledByName", r.paused_at as "pausedAt", r.paused_reason as "pausedReason",
           r.consecutive_failures as "consecutiveFailures", r.last_run_at as "lastRunAt", r.last_outcome as "lastOutcome",
           c.display_name as "createdByName", r.created_at as "createdAt",
           v.params, v.conditions, v.actions
      from automation_rule r
      join app_user o on o.id = r.owner_user_id
      join app_user c on c.id = r.created_by
      left join app_user e on e.id = r.enabled_by
      join automation_rule_version v on v.rule_id = r.id and v.version = r.current_version
     where r.rule_no = ${ruleNo}`)) as unknown as Rows<Record<string, unknown>>;
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    ruleNo: row.ruleNo as string,
    name: row.name as string,
    eventKey: row.eventKey as EventKey,
    templateCode: row.templateCode as TemplateCode,
    version: row.version as number,
    ownerUserId: row.ownerUserId as string,
    ownerName: row.ownerName as string,
    enabled: row.enabled as boolean,
    enabledAt: iso(row.enabledAt as Date | null),
    enabledByName: (row.enabledByName as string | null) ?? null,
    pausedAt: iso(row.pausedAt as Date | null),
    pausedReason: (row.pausedReason as string | null) ?? null,
    consecutiveFailures: row.consecutiveFailures as number,
    lastRunAt: iso(row.lastRunAt as Date | null),
    lastOutcome: (row.lastOutcome as string | null) ?? null,
    createdByName: row.createdByName as string,
    createdAt: iso(row.createdAt as Date)!,
    params: row.params as Record<string, string | number | boolean>,
    conditions: row.conditions as Condition[],
    actions: row.actions as Action[],
  };
}

export interface VersionLine {
  readonly version: number;
  readonly name: string;
  readonly changedByName: string;
  readonly changeNote: string | null;
  readonly createdAt: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly current: boolean;
}

export async function versionsOf(tx: Tx, principal: Principal, ruleId: string): Promise<VersionLine[]> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return [];
  const result = (await tx.execute(sql`
    select v.version, v.name, u.display_name as "changedByName", v.change_note as "changeNote", v.created_at as "createdAt", v.params,
           (v.version = r.current_version) as "current"
      from automation_rule_version v
      join automation_rule r on r.id = v.rule_id
      join app_user u on u.id = v.changed_by
     where v.rule_id = ${ruleId}::uuid
     order by v.version desc`)) as unknown as Rows<Omit<VersionLine, 'createdAt'> & { createdAt: Date | string }>;
  return result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! }));
}

export interface RunFilter extends RegisterPaging {
  readonly ruleNo?: string | null;
  readonly outcome?: string | null;
  readonly eventKey?: string | null;
  readonly search?: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly ruleNo: string;
  readonly ruleName: string;
  readonly ruleVersion: number;
  readonly eventKey: EventKey;
  readonly subjectKey: string;
  readonly reference: string;
  readonly attempt: number;
  readonly ownerName: string;
  readonly outcome: 'done' | 'skipped' | 'failed';
  readonly reason: string;
  readonly results: readonly { index: number; kind: string; status: string; detail: string; ref?: string }[];
  readonly startedAt: string;
}

export async function listRuns(tx: Tx, principal: Principal, filter: RunFilter = {}): Promise<RegisterPage<RunRow>> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return { rows: [], total: 0, page: 1, pageSize: filter.pageSize ?? 50, pages: 1 };
  const where = whereOf([
    filter.ruleNo ? sql`r.rule_no = ${filter.ruleNo}` : null,
    filter.outcome === 'done' || filter.outcome === 'skipped' || filter.outcome === 'failed' ? sql`x.outcome = ${filter.outcome}` : null,
    filter.eventKey && eventOf(filter.eventKey) ? sql`x.event_key = ${filter.eventKey}` : null,
    searchOf([sql`r.rule_no`, sql`r.name`, sql`x.subject_key`, sql`x.reason`, sql`e.payload->>'reference'`], filter.search),
  ]);
  const from = sql`from automation_run x join automation_rule r on r.id = x.rule_id join app_user u on u.id = x.owner_user_id join automation_event e on e.id = x.event_id ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) => {
      const result = (await tx.execute(sql`
        select x.id::text, r.rule_no as "ruleNo", r.name as "ruleName", x.rule_version as "ruleVersion", x.event_key as "eventKey",
               x.subject_key as "subjectKey", coalesce(e.payload->>'reference', x.subject_key) as "reference", x.attempt,
               u.display_name as "ownerName", x.outcome, x.reason, x.results, x.started_at as "startedAt"
          ${from}
         order by x.id desc
         limit ${limit} offset ${offset}`)) as unknown as Rows<Omit<RunRow, 'startedAt'> & { startedAt: Date | string }>;
      return result.rows.map((row) => ({ ...row, startedAt: iso(row.startedAt)! }));
    },
  });
}

export interface Overview {
  readonly rules: number;
  readonly on: number;
  readonly paused: number;
  readonly failing: number;
  readonly failedRunsWeek: number;
  readonly pendingEvents: number;
  readonly lastRunAt: string | null;
}

/** The figures the Control Center and the screen's header read; zeros when the viewer may not open automation. */
export async function overview(tx: Tx, principal: Principal): Promise<Overview | null> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return null;
  const result = (await tx.execute(sql`
    select (select count(*)::int from automation_rule) as rules,
           (select count(*)::int from automation_rule where enabled) as "on",
           (select count(*)::int from automation_rule where paused_at is not null) as paused,
           (select count(*)::int from automation_rule where consecutive_failures > 0) as failing,
           (select count(*)::int from automation_run where outcome = 'failed' and started_at > now() - interval '7 days') as "failedRunsWeek",
           (select count(*)::int from automation_event where status in ('pending', 'retry')) as "pendingEvents",
           (select max(finished_at) from automation_run) as "lastRunAt"`)) as unknown as Rows<Omit<Overview, 'lastRunAt'> & { lastRunAt: Date | string | null }>;
  const row = result.rows[0]!;
  return { ...row, lastRunAt: iso(row.lastRunAt) };
}

/** The sections a task made by a rule may be raised in: the ones the person may raise one in (for the template's form). */
export async function sectionChoices(tx: Tx, principal: Principal): Promise<{ code: string; name: string }[]> {
  const result = (await tx.execute(sql`
    select d.code, d.name from department d
     where d.active and (${principal.isSuperUser} or exists (select 1 from app_task_sections(${principal.userId}::uuid) s where s = d.code))
     order by d.code`)) as unknown as Rows<{ code: string; name: string }>;
  return result.rows;
}

export async function roleChoices(tx: Tx): Promise<{ code: string; name: string }[]> {
  const result = (await tx.execute(sql`select code, name from role order by code`)) as unknown as Rows<{ code: string; name: string }>;
  return result.rows;
}

export async function peopleChoices(tx: Tx): Promise<{ id: string; name: string }[]> {
  const result = (await tx.execute(sql`select id::text, display_name as name from app_user where is_active order by display_name limit 300`)) as unknown as Rows<{ id: string; name: string }>;
  return result.rows;
}


/** A name for every code and person a set of definitions names, so a rule reads as sentences. */
export interface NameBook {
  readonly roles: Readonly<Record<string, string>>;
  readonly sections: Readonly<Record<string, string>>;
  readonly users: Readonly<Record<string, string>>;
}

export async function nameBook(tx: Tx, userIds: readonly string[] = []): Promise<NameBook> {
  const roles = (await tx.execute(sql`select code, name from role`)) as unknown as Rows<{ code: string; name: string }>;
  const sections = (await tx.execute(sql`select code, name from department`)) as unknown as Rows<{ code: string; name: string }>;
  const ids = [...new Set(userIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  const users =
    ids.length === 0
      ? { rows: [] as { id: string; name: string }[] }
      : ((await tx.execute(sql`select id::text, display_name as name from app_user where id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as Rows<{ id: string; name: string }>);
  return {
    roles: Object.fromEntries(roles.rows.map((r) => [r.code, r.name])),
    sections: Object.fromEntries(sections.rows.map((r) => [r.code, r.name])),
    users: Object.fromEntries(users.rows.map((r) => [r.id, r.name])),
  };
}

/** The people a definition's actions name by id (a task's assignee, a recipient). */
export function peopleIn(actions: readonly Action[]): string[] {
  const ids: string[] = [];
  for (const action of actions) {
    if (action.kind === 'create_task') {
      if (action.assignee.kind === 'user') ids.push(action.assignee.userId);
    } else if (action.kind === 'create_notification' || action.kind === 'open_workflow') {
      for (const r of action.recipients) if (r.kind === 'user') ids.push(r.userId);
    }
  }
  return ids;
}

/** The rules a run log can be narrowed to (number and name). */
export async function ruleOptions(tx: Tx, principal: Principal): Promise<{ ruleNo: string; name: string }[]> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return [];
  const result = (await tx.execute(sql`select rule_no as "ruleNo", name from automation_rule order by rule_no desc limit 200`)) as unknown as Rows<{ ruleNo: string; name: string }>;
  return result.rows;
}

export interface ConditionCheck {
  readonly condition: Condition;
  readonly actual: string | null;
  readonly met: boolean;
}

export interface RunDetail {
  readonly id: string;
  readonly ruleNo: string;
  readonly ruleName: string;
  readonly ruleVersion: number;
  readonly eventKey: EventKey;
  readonly eventId: string;
  readonly subjectKey: string;
  readonly reference: string;
  readonly recordHref: string;
  readonly attempt: number;
  readonly ownerName: string;
  readonly outcome: 'done' | 'skipped' | 'failed';
  readonly reason: string;
  readonly startedAt: string;
  readonly branchCode: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly checks: readonly ConditionCheck[];
  readonly planned: readonly Action[];
  readonly results: readonly { index: number; kind: string; status: string; detail: string; ref?: string }[];
}

/** One run with the event it answered and the conditions as they stood: the rule's version of that day is re-read, never today's. */
export async function runById(tx: Tx, principal: Principal, id: string): Promise<RunDetail | null> {
  if (!can(principal, 'view', PERMISSION_OBJECT) || !/^\d{1,15}$/.test(id)) return null;
  const result = (await tx.execute(sql`
    select x.id::text, r.rule_no as "ruleNo", r.name as "ruleName", x.rule_version as "ruleVersion", x.event_key as "eventKey",
           x.event_id::text as "eventId", x.subject_key as "subjectKey", x.attempt, u.display_name as "ownerName", x.outcome, x.reason,
           x.planned, x.results, x.started_at as "startedAt", e.payload, e.branch_code as "branchCode", v.conditions
      from automation_run x
      join automation_rule r on r.id = x.rule_id
      join app_user u on u.id = x.owner_user_id
      join automation_event e on e.id = x.event_id
      join automation_rule_version v on v.rule_id = x.rule_id and v.version = x.rule_version
     where x.id = ${id}::bigint`)) as unknown as Rows<Record<string, unknown>>;
  const row = result.rows[0];
  if (!row) return null;
  const eventKey = row.eventKey as EventKey;
  const payload = row.payload as Record<string, unknown>;
  const conditions = row.conditions as Condition[];
  const checks = conditions.map((condition): ConditionCheck => {
    const one = evaluate({ eventKey, conditions: [condition], actions: [] }, payload);
    const actual = payload[condition.field];
    return { condition, actual: actual === undefined || actual === null ? null : String(actual), met: one.matched };
  });
  return {
    id: row.id as string,
    ruleNo: row.ruleNo as string,
    ruleName: row.ruleName as string,
    ruleVersion: row.ruleVersion as number,
    eventKey,
    eventId: row.eventId as string,
    subjectKey: row.subjectKey as string,
    reference: typeof payload.reference === 'string' ? payload.reference : (row.subjectKey as string),
    recordHref: EVENTS[eventKey].href(payload),
    attempt: row.attempt as number,
    ownerName: row.ownerName as string,
    outcome: row.outcome as RunDetail['outcome'],
    reason: row.reason as string,
    startedAt: iso(row.startedAt as Date | string)!,
    branchCode: (row.branchCode as string | null) ?? null,
    payload,
    checks,
    planned: row.planned as Action[],
    results: row.results as RunDetail['results'],
  };
}

export const fieldType = (eventKey: EventKey, field: string): string | undefined => EVENTS[eventKey].fields[field]?.type;

export interface PayloadLine {
  readonly field: string;
  readonly type: string;
  readonly value: string;
}

/** The event's payload as lines a person reads, in the event's own field order; the record's id is not one of them, and a person is their name. */
export function payloadLines(eventKey: EventKey, payload: Readonly<Record<string, unknown>>, users: Readonly<Record<string, string>>): PayloadLine[] {
  const lines: PayloadLine[] = [];
  for (const [field, def] of Object.entries(EVENTS[eventKey].fields)) {
    if (field === 'subjectId') continue;
    const raw = payload[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = def.type === 'user' ? (users[String(raw)] ?? '—') : String(raw);
    lines.push({ field, type: def.type, value });
  }
  return lines;
}
