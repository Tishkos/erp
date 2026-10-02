/**
 * The Project System — REQ-PM-001 Stage PM-1: the definition with its type,
 * the status profile, the WBS by mask with its operative indicators, the
 * tree with its amounts rolled up, and the configuration as master data.
 *
 * Built beside `services/projects.ts` (Phase 11), not over it: that module
 * keeps the contract, the five amounts, commitments, costs, stock, progress,
 * certificates, balances, variations and the close, and its sixty-one tests.
 * This one adds what PS has and it had not, and calls it for the rest.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  businessPartner,
  project,
  projectBudgetLine,
  projectCommitment,
  projectCost,
  projectCostCode,
  projectToleranceProfile,
  projectType,
  projectWbs,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  ProjectSystemError,
  admitsStructureChange,
  assertTransition,
  availabilityState,
  nextWbsCode,
  rollUp,
  treeOrder,
  wbsCodeLevel,
  type ProjectKind,
  type ProjectStatus,
  type WbsAmounts,
} from '../domain/project-system';
import { assertNoWbsCycle } from '../domain/projects';
import { AdminNotFoundError, normaliseCode, optionalText, permit, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';
import { allocateDocumentNumber } from './numbering';
import * as budget from './project-budget';
import * as schedule from './project-schedule';
import * as projects from './projects';

export const PERMISSION_OBJECT = projects.PERMISSION_OBJECT;
export const SETTINGS_OBJECT = 'project_setting';
export const SEQUENCE_KEY = 'PROJECT';

const MONEY = 4n;

// ---------------------------------------------------------------------------
// §4 — the definition
// ---------------------------------------------------------------------------

export interface DefinitionInput {
  /** Typed when the company already names the project (D-PM-2); allocated otherwise. */
  readonly code?: string | null;
  readonly name: string;
  readonly typeCode: string;
  readonly customerId?: string | null;
  readonly branchCode: string;
  readonly managerUserId: string;
  readonly departmentCode?: string | null;
  readonly costCentreCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly contractValueIqd?: string | null;
  readonly baselineBudgetIqd?: string | null;
  readonly baselineStartsOn?: string | null;
  readonly baselineEndsOn?: string | null;
  readonly billingMethod?: 'milestone' | 'progress' | 'time_and_material' | 'lump_sum';
  readonly retentionPercent?: string | null;
  readonly advanceRecoveryPercent?: string | null;
  readonly description?: string | null;
  readonly toleranceProfileCode?: string | null;
  readonly opportunityId?: string | null;
}

async function typeOf(tx: Tx, code: string) {
  const [row] = await tx.select().from(projectType).where(eq(projectType.code, code)).limit(1);
  if (!row) throw new ProjectSystemError('type', `names no project type '${code}'`);
  if (!row.active) throw new ProjectSystemError('type', `project type '${code}' is deactivated`);
  return row;
}

const money = (value: string | null | undefined, field: string): bigint => {
  const text = (value ?? '').trim();
  if (!text) return 0n;
  try {
    const parsed = parseDecimal(text, MONEY);
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new ProjectSystemError(field, `'${text}' is not an amount`);
  }
};

const day = (value: string | null | undefined, field: string): string | null => {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ProjectSystemError(field, `'${text}' is not a date`);
  return text;
};

/**
 * A project definition with its level-1 element. A customer project goes
 * through Phase 11's `create` (the customer, the opportunity, the contract);
 * an internal or investment project has no customer and is written here.
 */
export async function createDefinition(tx: Tx, ctx: ActorContext, input: DefinitionInput): Promise<{ projectCode: string }> {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const name = requireText(input.name, 'name');
  const type = await typeOf(tx, normaliseCode(input.typeCode, 'type'));
  const kind = type.kind as ProjectKind;
  const branchCode = requireText(input.branchCode, 'branch');
  const managerUserId = requireText(input.managerUserId, 'manager');
  const [manager] = await tx.select({ id: appUser.id, isActive: appUser.isActive }).from(appUser).where(eq(appUser.id, managerUserId)).limit(1);
  if (!manager || !manager.isActive) throw new ProjectSystemError('manager', 'names no active user');
  const toleranceProfileCode = normaliseCode(input.toleranceProfileCode?.trim() || 'STANDARD', 'tolerance_profile');
  const [profile] = await tx.select({ code: projectToleranceProfile.code }).from(projectToleranceProfile).where(eq(projectToleranceProfile.code, toleranceProfileCode)).limit(1);
  if (!profile) throw new ProjectSystemError('tolerance_profile', `names no profile '${toleranceProfileCode}'`);
  const startsOn = day(input.baselineStartsOn, 'starts_on');
  const endsOn = day(input.baselineEndsOn, 'ends_on');
  if (startsOn && endsOn && endsOn < startsOn) throw new ProjectSystemError('ends_on', 'is before the start');

  const typed = (input.code ?? '').trim();
  const projectCode = typed
    ? normaliseCode(typed, 'code')
    : (await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode, year: Number((startsOn ?? businessToday()).slice(0, 4)) }, ctx.principal.userId)).documentNo;
  const [taken] = await tx.select({ code: project.code }).from(project).where(eq(project.code, projectCode)).limit(1);
  if (taken) throw new ProjectSystemError('code', `'${projectCode}' is already a project`);

  const contractValueIqd = money(input.contractValueIqd, 'contract_value');
  const baselineBudgetIqd = money(input.baselineBudgetIqd, 'baseline_budget');

  if (kind === 'customer') {
    const customerId = (input.customerId ?? '').trim();
    if (!customerId) throw new ProjectSystemError('customer', 'a customer project names its customer');
    await projects.create(tx, ctx, {
      projectCode,
      name,
      customerId,
      branchCode,
      managerUserId,
      contractValueIqd,
      baselineBudgetIqd,
      baselineStartsOn: startsOn,
      baselineEndsOn: endsOn,
      ...(input.billingMethod ? { billingMethod: input.billingMethod } : {}),
      retentionPercent: money(input.retentionPercent, 'retention_percent'),
      advanceRecoveryPercent: money(input.advanceRecoveryPercent, 'advance_recovery_percent'),
      departmentCode: optionalText(input.departmentCode),
      businessLineCode: optionalText(input.businessLineCode),
      costCentreCode: optionalText(input.costCentreCode),
      opportunityId: optionalText(input.opportunityId),
    });
  } else {
    if ((input.customerId ?? '').trim()) throw new ProjectSystemError('customer', `an ${kind} project has no customer`);
    await tx.insert(project).values({
      code: projectCode,
      name,
      partnerId: null,
      branchCode,
      departmentCode: optionalText(input.departmentCode),
      businessLineCode: optionalText(input.businessLineCode),
      costCentreCode: optionalText(input.costCentreCode),
      managerUserId,
      contractValueIqd: '0',
      baselineBudgetIqd: toDecimalString(baselineBudgetIqd, MONEY),
      baselineStartsOn: startsOn,
      baselineEndsOn: endsOn,
      createdBy: ctx.principal.userId,
    });
    await recordChange(tx, ctx, {
      action: 'project.created',
      objectType: projects.DOCUMENT_TYPE,
      objectId: projectCode,
      branchCode,
      after: { projectCode, name, type: type.code, baselineBudgetIqd: toDecimalString(baselineBudgetIqd, MONEY) },
    });
  }

  await tx
    .update(project)
    .set({
      typeCode: type.code,
      toleranceProfileCode,
      description: optionalText(input.description),
      forecastStartsOn: startsOn,
      forecastEndsOn: endsOn,
      updatedAt: new Date(),
    })
    .where(eq(project.code, projectCode));

  // The level-1 element is the project itself, seen from the structure.
  await tx.insert(projectWbs).values({
    projectCode,
    code: `${projectCode}-1`,
    name,
    parentCode: null,
    responsibleUserId: managerUserId,
    plannedStartsOn: startsOn,
    plannedEndsOn: endsOn,
    isPlanning: true,
    isAccountAssignment: true,
    isBilling: kind === 'customer',
    createdBy: ctx.principal.userId,
  });

  return { projectCode };
}

export interface DefinitionUpdate {
  readonly name?: string;
  readonly managerUserId?: string;
  readonly departmentCode?: string | null;
  readonly costCentreCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly description?: string | null;
  readonly toleranceProfileCode?: string | null;
  readonly forecastStartsOn?: string | null;
  readonly forecastEndsOn?: string | null;
  /** Only while a draft: the baseline is written once at release (R2). */
  readonly baselineStartsOn?: string | null;
  readonly baselineEndsOn?: string | null;
  readonly baselineBudgetIqd?: string | null;
  readonly contractValueIqd?: string | null;
}

/** The fields that may still move: everything but the baseline once released. */
export async function updateDefinition(tx: Tx, ctx: ActorContext, projectCode: string, input: DefinitionUpdate): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (row.status === 'closed') throw new ProjectSystemError('status', `${projectCode} is closed`);
  const values: Partial<typeof project.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = requireText(input.name, 'name');
  if (input.managerUserId !== undefined) values.managerUserId = requireText(input.managerUserId, 'manager');
  if (input.departmentCode !== undefined) values.departmentCode = optionalText(input.departmentCode);
  if (input.costCentreCode !== undefined) values.costCentreCode = optionalText(input.costCentreCode);
  if (input.businessLineCode !== undefined) values.businessLineCode = optionalText(input.businessLineCode);
  if (input.description !== undefined) values.description = optionalText(input.description);
  if (input.toleranceProfileCode !== undefined && input.toleranceProfileCode) values.toleranceProfileCode = normaliseCode(input.toleranceProfileCode, 'tolerance_profile');
  if (input.forecastStartsOn !== undefined) values.forecastStartsOn = day(input.forecastStartsOn, 'forecast_starts_on');
  if (input.forecastEndsOn !== undefined) values.forecastEndsOn = day(input.forecastEndsOn, 'forecast_ends_on');
  const baselineAsked = [input.baselineStartsOn, input.baselineEndsOn, input.baselineBudgetIqd, input.contractValueIqd].some((v) => v !== undefined);
  if (baselineAsked) {
    if (row.status !== 'draft') throw new ProjectSystemError('baseline', `${projectCode} is released; the baseline is written once (R2) — raise a change order`);
    if (input.baselineStartsOn !== undefined) values.baselineStartsOn = day(input.baselineStartsOn, 'starts_on');
    if (input.baselineEndsOn !== undefined) values.baselineEndsOn = day(input.baselineEndsOn, 'ends_on');
    if (input.baselineBudgetIqd !== undefined) values.baselineBudgetIqd = toDecimalString(money(input.baselineBudgetIqd, 'baseline_budget'), MONEY);
    if (input.contractValueIqd !== undefined) values.contractValueIqd = toDecimalString(money(input.contractValueIqd, 'contract_value'), MONEY);
  }
  await tx.update(project).set(values).where(eq(project.code, projectCode));
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    if (key === 'updatedAt') continue;
    before[key] = row[key as keyof typeof row];
    after[key] = values[key];
  }
  await recordChange(tx, ctx, { action: 'project.updated', objectType: projects.DOCUMENT_TYPE, objectId: projectCode, branchCode: row.branchCode, before, after });
}

async function load(tx: Tx, projectCode: string) {
  const [row] = await tx.select().from(project).where(eq(project.code, projectCode)).limit(1);
  if (!row) throw new AdminNotFoundError('project', projectCode);
  return row;
}

// ---------------------------------------------------------------------------
// §6 — the status profile
// ---------------------------------------------------------------------------

/** REL — Phase 11's approval: somebody else, the baseline written once. */
export async function release(tx: Tx, ctx: ActorContext, projectCode: string): Promise<void> {
  const row = await load(tx, projectCode);
  assertTransition('release', row.status as ProjectStatus, projectCode);
  if (!row.baselineStartsOn || !row.baselineEndsOn) throw new ProjectSystemError('baseline', 'the baseline dates are typed before release');
  await projects.approve(tx, ctx, projectCode);
  await tx
    .update(project)
    .set({ forecastStartsOn: row.forecastStartsOn ?? row.baselineStartsOn, forecastEndsOn: row.forecastEndsOn ?? row.baselineEndsOn, updatedAt: new Date() })
    .where(eq(project.code, projectCode));
}

export async function hold(tx: Tx, ctx: ActorContext, projectCode: string, reason: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'submit', PERMISSION_OBJECT, projectCode);
  const to = assertTransition('hold', row.status as ProjectStatus, projectCode);
  const why = requireText(reason, 'reason');
  await tx.update(project).set({ status: to, heldAt: new Date(), heldBy: ctx.principal.userId, heldReason: why, updatedAt: new Date() }).where(eq(project.code, projectCode));
  await recordChange(tx, ctx, { action: 'project.held', objectType: projects.DOCUMENT_TYPE, objectId: projectCode, branchCode: row.branchCode, before: { status: row.status }, after: { status: to }, reason: why });
}

export async function resume(tx: Tx, ctx: ActorContext, projectCode: string, reason: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'submit', PERMISSION_OBJECT, projectCode);
  const to = assertTransition('resume', row.status as ProjectStatus, projectCode);
  const why = requireText(reason, 'reason');
  await tx.update(project).set({ status: to, heldAt: null, heldBy: null, heldReason: null, updatedAt: new Date() }).where(eq(project.code, projectCode));
  await recordChange(tx, ctx, { action: 'project.resumed', objectType: projects.DOCUMENT_TYPE, objectId: projectCode, branchCode: row.branchCode, before: { status: row.status, heldReason: row.heldReason }, after: { status: to }, reason: why });
}

/** TECO — the work is done; settlement and final billing may follow, nothing new may be committed. */
export async function technicalComplete(tx: Tx, ctx: ActorContext, projectCode: string, note?: string | null): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, projectCode);
  const to = assertTransition('technical_complete', row.status as ProjectStatus, projectCode);
  // §6 — TECO: no open activity; every milestone reached or cancelled (PM-4).
  const open = await schedule.openActivities(tx, projectCode);
  if (open.length > 0) throw new ProjectSystemError('status', `${projectCode} still has open work: ${open.join(', ')} — finish, reach or cancel it first`);
  await tx
    .update(project)
    .set({ status: to, technicallyCompleteAt: new Date(), technicallyCompleteBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(project.code, projectCode));
  await recordChange(tx, ctx, { action: 'project.technically_completed', objectType: projects.DOCUMENT_TYPE, objectId: projectCode, branchCode: row.branchCode, before: { status: row.status }, after: { status: to }, reason: optionalText(note) });
}

/** One reopen after technical completion, with its reason (§6). */
export async function reopen(tx: Tx, ctx: ActorContext, projectCode: string, reason: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, projectCode);
  const to = assertTransition('reopen', row.status as ProjectStatus, projectCode);
  if (row.reopenedAt) throw new ProjectSystemError('status', `${projectCode} was already reopened once (${row.reopenedAt.toISOString().slice(0, 10)}); a second rework is a new project`);
  const why = requireText(reason, 'reason');
  await tx
    .update(project)
    .set({ status: to, reopenedAt: new Date(), reopenedBy: ctx.principal.userId, reopenedReason: why, technicallyCompleteAt: null, technicallyCompleteBy: null, updatedAt: new Date() })
    .where(eq(project.code, projectCode));
  await recordChange(tx, ctx, { action: 'project.reopened', objectType: projects.DOCUMENT_TYPE, objectId: projectCode, branchCode: row.branchCode, before: { status: row.status }, after: { status: to }, reason: why });
}

/** CLSD — Phase 11's close, from technical completion only. */
export async function close(tx: Tx, ctx: ActorContext, projectCode: string, note: string): Promise<void> {
  const row = await load(tx, projectCode);
  assertTransition('close', row.status as ProjectStatus, projectCode);
  await projects.close(tx, ctx, projectCode, note);
}

// ---------------------------------------------------------------------------
// §5 — the WBS
// ---------------------------------------------------------------------------

export interface ElementInput {
  readonly parentCode?: string | null;
  /** Typed to follow the mask, or left blank for the next number. */
  readonly code?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly responsibleUserId?: string | null;
  readonly plannedStartsOn?: string | null;
  readonly plannedEndsOn?: string | null;
  readonly isPlanning?: boolean;
  readonly isAccountAssignment?: boolean;
  readonly isBilling?: boolean;
}

export async function addElement(tx: Tx, ctx: ActorContext, projectCode: string, input: ElementInput): Promise<{ id: string; code: string; level: number }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (!admitsStructureChange(row.status as ProjectStatus)) throw new ProjectSystemError('status', `${projectCode} is ${row.status}; the structure is fixed`);
  const name = requireText(input.name, 'name');
  const existing = await tx.select({ code: projectWbs.code, parentCode: projectWbs.parentCode, isBilling: projectWbs.isBilling }).from(projectWbs).where(eq(projectWbs.projectCode, projectCode));
  const parentCode = optionalText(input.parentCode);
  const parent = parentCode ? existing.find((e) => e.code === parentCode) : null;
  if (parentCode && !parent) throw new ProjectSystemError('parent', `names no element '${parentCode}' on ${projectCode}`);
  const typed = optionalText(input.code);
  const code = typed ?? nextWbsCode(projectCode, parentCode, existing.map((e) => e.code));
  const level = wbsCodeLevel(projectCode, parentCode, code);
  if (existing.some((e) => e.code === code)) throw new ProjectSystemError('code', `'${code}' is already an element of ${projectCode}`);
  assertNoWbsCycle(code, parentCode, new Map(existing.map((e) => [e.code, e.parentCode])));
  const type = await typeOf(tx, row.typeCode);
  if (input.isBilling && type.kind !== 'customer') throw new ProjectSystemError('is_billing', `an ${type.kind} project bills nobody`);
  const startsOn = day(input.plannedStartsOn, 'planned_starts_on');
  const endsOn = day(input.plannedEndsOn, 'planned_ends_on');
  if (startsOn && endsOn && endsOn < startsOn) throw new ProjectSystemError('planned_ends_on', 'is before the start');
  const [created] = await tx
    .insert(projectWbs)
    .values({
      projectCode,
      code,
      name,
      parentCode,
      description: optionalText(input.description),
      responsibleUserId: optionalText(input.responsibleUserId) ?? row.managerUserId,
      plannedStartsOn: startsOn,
      plannedEndsOn: endsOn,
      isPlanning: input.isPlanning ?? true,
      isAccountAssignment: input.isAccountAssignment ?? true,
      isBilling: input.isBilling ?? false,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectWbs.id, level: projectWbs.level });
  await recordChange(tx, ctx, {
    action: 'project_wbs.created',
    objectType: 'project_wbs',
    objectId: `${projectCode}:${code}`,
    branchCode: row.branchCode,
    after: { projectCode, code, name, parentCode, level: created!.level, isPlanning: input.isPlanning ?? true, isAccountAssignment: input.isAccountAssignment ?? true, isBilling: input.isBilling ?? false },
  });
  return { id: created!.id, code, level: created!.level };
}

export interface ElementUpdate {
  readonly name?: string;
  readonly description?: string | null;
  readonly responsibleUserId?: string | null;
  readonly plannedStartsOn?: string | null;
  readonly plannedEndsOn?: string | null;
  readonly isPlanning?: boolean;
  readonly isAccountAssignment?: boolean;
  readonly isBilling?: boolean;
}

export async function updateElement(tx: Tx, ctx: ActorContext, projectCode: string, code: string, input: ElementUpdate): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (!admitsStructureChange(row.status as ProjectStatus)) throw new ProjectSystemError('status', `${projectCode} is ${row.status}; the structure is fixed`);
  const [before] = await tx.select().from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, code))).limit(1);
  if (!before) throw new AdminNotFoundError('project_wbs', code);
  const values: Partial<typeof projectWbs.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = requireText(input.name, 'name');
  if (input.description !== undefined) values.description = optionalText(input.description);
  if (input.responsibleUserId !== undefined) values.responsibleUserId = optionalText(input.responsibleUserId);
  if (input.plannedStartsOn !== undefined) values.plannedStartsOn = day(input.plannedStartsOn, 'planned_starts_on');
  if (input.plannedEndsOn !== undefined) values.plannedEndsOn = day(input.plannedEndsOn, 'planned_ends_on');
  if (input.isPlanning !== undefined) values.isPlanning = input.isPlanning;
  if (input.isAccountAssignment !== undefined) {
    if (!input.isAccountAssignment && before.isAccountAssignment) {
      const [used] = (await tx.execute(sql`select count(*)::int as n from project_cost where project_code = ${projectCode} and wbs_code = ${code}`)).rows as { n: number }[];
      if ((used?.n ?? 0) > 0) throw new ProjectSystemError('is_account_assignment', `${code} already carries ${used!.n} cost row(s); it stays an account-assignment element`);
    }
    values.isAccountAssignment = input.isAccountAssignment;
  }
  if (input.isBilling !== undefined) {
    const type = await typeOf(tx, row.typeCode);
    if (input.isBilling && type.kind !== 'customer') throw new ProjectSystemError('is_billing', `an ${type.kind} project bills nobody`);
    values.isBilling = input.isBilling;
  }
  const startsOn = values.plannedStartsOn === undefined ? before.plannedStartsOn : values.plannedStartsOn;
  const endsOn = values.plannedEndsOn === undefined ? before.plannedEndsOn : values.plannedEndsOn;
  if (startsOn && endsOn && endsOn < startsOn) throw new ProjectSystemError('planned_ends_on', 'is before the start');
  await tx.update(projectWbs).set(values).where(eq(projectWbs.id, before.id));
  const changed: Record<string, unknown> = {};
  const was: Record<string, unknown> = {};
  for (const key of Object.keys(values) as (keyof typeof values)[]) {
    if (key === 'updatedAt') continue;
    was[key] = before[key as keyof typeof before];
    changed[key] = values[key];
  }
  await recordChange(tx, ctx, { action: 'project_wbs.updated', objectType: 'project_wbs', objectId: `${projectCode}:${code}`, branchCode: row.branchCode, before: was, after: changed });
}

/** An element nothing posted to may be deactivated; one with costs stays. */
export async function setElementActive(tx: Tx, ctx: ActorContext, projectCode: string, code: string, active: boolean, reason?: string | null): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const [before] = await tx.select().from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, code))).limit(1);
  if (!before) throw new AdminNotFoundError('project_wbs', code);
  if (before.level === 1) throw new ProjectSystemError('code', 'the level-1 element is the project itself');
  const why = optionalText(reason);
  if (!active && !why) throw new ProjectSystemError('reason', 'say why it is deactivated');
  if (!active) {
    const [used] = (
      await tx.execute(sql`
        select (select count(*) from project_cost where project_code = ${projectCode} and wbs_code = ${code})
             + (select count(*) from project_budget_line where project_code = ${projectCode} and wbs_code = ${code})
             + (select count(*) from project_wbs where project_code = ${projectCode} and parent_code = ${code} and active) as n`)
    ).rows as { n: string }[];
    if (Number(used?.n ?? 0) > 0) throw new ProjectSystemError('code', `${code} carries costs, budget or active children; it cannot be deactivated`);
  }
  await tx.update(projectWbs).set({ active, updatedAt: new Date() }).where(eq(projectWbs.id, before.id));
  await recordChange(tx, ctx, {
    action: active ? 'project_wbs.activated' : 'project_wbs.deactivated',
    objectType: 'project_wbs',
    objectId: `${projectCode}:${code}`,
    branchCode: row.branchCode,
    before: { active: before.active },
    after: { active },
    reason: why,
  });
}

/**
 * §5 — may costs be posted to this element? Asked by `projects.recordCost`
 * and `projects.issueToProject` whenever an element is named (PM2).
 */
export const assertAccountAssignment = projects.assertAccountAssignmentElement;

// ---------------------------------------------------------------------------
// The tree with its amounts (§5, R3)
// ---------------------------------------------------------------------------

export interface TreeRow {
  readonly id: string;
  readonly code: string;
  readonly parentCode: string | null;
  readonly level: number;
  readonly name: string;
  readonly description: string | null;
  readonly responsibleUserId: string | null;
  readonly responsibleName: string | null;
  readonly plannedStartsOn: string | null;
  readonly plannedEndsOn: string | null;
  readonly isPlanning: boolean;
  readonly isAccountAssignment: boolean;
  readonly isBilling: boolean;
  readonly isMilestone: boolean;
  readonly active: boolean;
  /** Own plus descendants. */
  readonly budgetIqd: string;
  readonly committedIqd: string;
  readonly actualIqd: string;
  readonly availableIqd: string;
  readonly availability: 'ok' | 'warn' | 'stop';
  /** PM-2 — the stop line raised for this element, if one was (D-PM-5). */
  readonly stopPercentRaised: number | null;
}

/**
 * Every element in tree order with its own amounts rolled up: budget from
 * the budget lines on it, committed from the open commitments on those
 * lines' cost codes, actual from the cost rows on it.
 */
export async function tree(tx: Tx, projectCode: string): Promise<TreeRow[]> {
  const row = await load(tx, projectCode);
  const [profile] = await tx.select().from(projectToleranceProfile).where(eq(projectToleranceProfile.code, row.toleranceProfileCode)).limit(1);
  const elements = await tx
    .select({ wbs: projectWbs, responsibleName: appUser.displayName })
    .from(projectWbs)
    .leftJoin(appUser, eq(appUser.id, projectWbs.responsibleUserId))
    .where(eq(projectWbs.projectCode, projectCode));
  const budgetLines = await tx
    .select({ wbsCode: projectBudgetLine.wbsCode, costCode: projectBudgetLine.costCode })
    .from(projectBudgetLine)
    .where(eq(projectBudgetLine.projectCode, projectCode));
  const commitments = await tx
    .select({ costCode: projectCommitment.costCode, wbsCode: projectCommitment.wbsCode, amountIqd: projectCommitment.amountIqd, consumedIqd: projectCommitment.consumedIqd, releasedOn: projectCommitment.releasedOn })
    .from(projectCommitment)
    .where(eq(projectCommitment.projectCode, projectCode));
  const costs = await tx.select({ wbsCode: projectCost.wbsCode, amountIqd: projectCost.amountIqd }).from(projectCost).where(eq(projectCost.projectCode, projectCode));

  const root = elements.find((e) => e.wbs.level === 1)?.wbs.code ?? null;
  const own = new Map<string, WbsAmounts>();
  const at = (code: string | null) => {
    const key = code ?? root ?? '';
    const current = own.get(key) ?? { budgetIqd: 0n, committedIqd: 0n, actualIqd: 0n };
    own.set(key, current);
    return current;
  };
  // PM-2 §7 — the budget by element has one source (documents, lines or the
  // definition); a commitment stands on its element, or failing that on the
  // element its cost code's line names.
  for (const [code, budgetIqd] of (await budget.ownBudgetByElement(tx, projectCode)).own) at(code).budgetIqd += budgetIqd;
  const costCodeElement = new Map<string, string | null>();
  for (const line of budgetLines) costCodeElement.set(line.costCode, line.wbsCode);
  for (const c of commitments) {
    if (c.releasedOn) continue;
    const open = parseDecimal(c.amountIqd, MONEY) - parseDecimal(c.consumedIqd, MONEY);
    if (open > 0n) at(c.wbsCode ?? costCodeElement.get(c.costCode) ?? null).committedIqd += open;
  }
  for (const k of costs) at(k.wbsCode).actualIqd += parseDecimal(k.amountIqd, MONEY);

  const nodes = elements.map((e) => ({ code: e.wbs.code, parentCode: e.wbs.parentCode, level: e.wbs.level }));
  const totals = rollUp(nodes, own);
  const warn = Number(profile?.warnPercent ?? 90);
  const stop = Number(profile?.stopPercent ?? 100);
  const rows = elements.map((e): TreeRow => {
    const sum = totals.get(e.wbs.code) ?? { budgetIqd: 0n, committedIqd: 0n, actualIqd: 0n };
    const available = sum.budgetIqd - sum.committedIqd - sum.actualIqd;
    const stopHere = e.wbs.stopPercentRaised === null ? stop : Number(e.wbs.stopPercentRaised);
    return {
      id: e.wbs.id,
      code: e.wbs.code,
      parentCode: e.wbs.parentCode,
      level: e.wbs.level,
      name: e.wbs.name,
      description: e.wbs.description,
      responsibleUserId: e.wbs.responsibleUserId,
      responsibleName: e.responsibleName,
      plannedStartsOn: e.wbs.plannedStartsOn,
      plannedEndsOn: e.wbs.plannedEndsOn,
      isPlanning: e.wbs.isPlanning,
      isAccountAssignment: e.wbs.isAccountAssignment,
      isBilling: e.wbs.isBilling,
      isMilestone: e.wbs.isMilestone === 'true',
      active: e.wbs.active,
      budgetIqd: toDecimalString(sum.budgetIqd, MONEY),
      committedIqd: toDecimalString(sum.committedIqd, MONEY),
      actualIqd: toDecimalString(sum.actualIqd, MONEY),
      availableIqd: toDecimalString(available, MONEY),
      availability: availabilityState(sum.budgetIqd, sum.committedIqd + sum.actualIqd, { warnPercent: warn, stopPercent: stopHere }),
      stopPercentRaised: e.wbs.stopPercentRaised === null ? null : Number(e.wbs.stopPercentRaised),
    };
  });
  return treeOrder(rows);
}

// ---------------------------------------------------------------------------
// The register and the record
// ---------------------------------------------------------------------------

export interface ListFilter {
  readonly status?: string | null;
  readonly typeCode?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

export async function list(tx: Tx, filter: ListFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
  const term = (filter.search ?? '').trim().toLowerCase();
  const where = and(
    filter.status ? eq(project.status, filter.status as ProjectStatus) : undefined,
    filter.typeCode ? eq(project.typeCode, filter.typeCode) : undefined,
    term ? sql`(lower(${project.code}) like ${'%' + term + '%'} or lower(${project.name}) like ${'%' + term + '%'} or lower(coalesce(${businessPartner.legalName}, '')) like ${'%' + term + '%'})` : undefined,
  );
  const rows = await tx
    .select({
      code: project.code,
      name: project.name,
      typeCode: project.typeCode,
      typeName: projectType.nameEn,
      typeNameAr: projectType.nameAr,
      kind: projectType.kind,
      status: project.status,
      customerCode: businessPartner.code,
      customerName: businessPartner.legalName,
      managerName: appUser.displayName,
      branchCode: project.branchCode,
      baselineStartsOn: project.baselineStartsOn,
      baselineEndsOn: project.baselineEndsOn,
      contractValueIqd: project.contractValueIqd,
      // PM-2 §7 — the approved budget documents once the original is approved
      // (it wrote the baseline lines); before that the lines plus the other
      // documents; before any of those the definition with its variations.
      budgetIqd: sql<string>`(case
        when exists (select 1 from project_budget_document o where o.project_code = ${project.code} and o.kind = 'original' and o.status = 'approved')
          then (select coalesce(sum(l.amount_iqd), 0) from project_budget_document_line l join project_budget_document d on d.id = l.document_id where l.project_code = ${project.code} and d.status = 'approved')
        else coalesce((select sum(b.baseline_iqd) from project_budget_line b where b.project_code = ${project.code}),
                      ${project.baselineBudgetIqd} + coalesce((select sum(v.budget_delta_iqd) from project_variation v where v.project_code = ${project.code} and v.status = 'approved'), 0))
             + (select coalesce(sum(l.amount_iqd), 0) from project_budget_document_line l join project_budget_document d on d.id = l.document_id where l.project_code = ${project.code} and d.status = 'approved')
        end)::text`,
      committedIqd: sql<string>`coalesce((select sum(c.amount_iqd - c.consumed_iqd) from project_commitment c where c.project_code = ${project.code} and c.released_on is null), 0)::text`,
      actualIqd: sql<string>`coalesce((select sum(k.amount_iqd) from project_cost k where k.project_code = ${project.code}), 0)::text`,
    })
    .from(project)
    .innerJoin(projectType, eq(projectType.code, project.typeCode))
    .leftJoin(businessPartner, eq(businessPartner.id, project.partnerId))
    .leftJoin(appUser, eq(appUser.id, project.managerUserId))
    .where(where)
    .orderBy(desc(project.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(project)
    .leftJoin(businessPartner, eq(businessPartner.id, project.partnerId))
    .where(where);
  return {
    rows: rows.map((r) => ({
      ...r,
      availableIqd: toDecimalString(parseDecimal(r.budgetIqd, MONEY) - parseDecimal(r.committedIqd, MONEY) - parseDecimal(r.actualIqd, MONEY), MONEY),
    })),
    total: count?.total ?? 0,
    page,
    pageSize,
  };
}

/** The record page: Phase 11's view with the type, the tree and the people. */
export async function record(tx: Tx, ctx: ActorContext, projectCode: string) {
  const view = await projects.projectView(tx, ctx, projectCode);
  const type = await typeOf(tx, view.project.typeCode).catch(() => null);
  const [profile] = await tx.select().from(projectToleranceProfile).where(eq(projectToleranceProfile.code, view.project.toleranceProfileCode)).limit(1);
  const [customer] = view.project.partnerId
    ? await tx.select({ code: businessPartner.code, name: businessPartner.legalName }).from(businessPartner).where(eq(businessPartner.id, view.project.partnerId)).limit(1)
    : [];
  const ids = [view.project.managerUserId, view.project.createdBy, view.project.approvedBy, view.project.heldBy, view.project.technicallyCompleteBy, view.project.reopenedBy, view.project.closedBy].filter((x): x is string => Boolean(x));
  const people = ids.length ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(sql`${appUser.id} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`) : [];
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  return {
    ...view,
    type,
    profile: profile ?? null,
    customer: customer ?? null,
    tree: await tree(tx, projectCode),
    people: {
      manager: nameOf(view.project.managerUserId),
      createdBy: nameOf(view.project.createdBy),
      releasedBy: nameOf(view.project.approvedBy),
      heldBy: nameOf(view.project.heldBy),
      technicallyCompleteBy: nameOf(view.project.technicallyCompleteBy),
      reopenedBy: nameOf(view.project.reopenedBy),
      closedBy: nameOf(view.project.closedBy),
    },
  };
}

/** The pickers the new-project dialog needs. */
export async function pickers(tx: Tx) {
  const types = await tx.select().from(projectType).where(eq(projectType.active, true)).orderBy(asc(projectType.code));
  const profiles = await tx.select().from(projectToleranceProfile).where(eq(projectToleranceProfile.active, true)).orderBy(asc(projectToleranceProfile.code));
  const customers = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(and(eq(businessPartner.isCustomer, true), eq(businessPartner.active, true)))
    .orderBy(asc(businessPartner.legalName));
  const managers = await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(eq(appUser.isActive, true)).orderBy(asc(appUser.displayName));
  return { types, profiles, customers, managers };
}

// ---------------------------------------------------------------------------
// Settings — configuration as master data (R4)
// ---------------------------------------------------------------------------

export async function types(tx: Tx) {
  return tx.select().from(projectType).orderBy(asc(projectType.code));
}

export async function saveType(tx: Tx, ctx: ActorContext, input: { code: string; nameEn: string; nameAr?: string | null; kind: string; existing: boolean }): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const nameEn = requireText(input.nameEn, 'name_en');
  if (!['customer', 'internal', 'investment'].includes(input.kind)) throw new ProjectSystemError('kind', 'is customer, internal or investment');
  const [before] = await tx.select().from(projectType).where(eq(projectType.code, code)).limit(1);
  if (input.existing) {
    if (!before) throw new AdminNotFoundError('project_type', code);
    await tx.update(projectType).set({ nameEn, nameAr: optionalText(input.nameAr), kind: input.kind, updatedAt: new Date() }).where(eq(projectType.code, code));
    await recordChange(tx, ctx, { action: 'project_type.updated', objectType: 'project_setting', objectId: code, before: { nameEn: before.nameEn, kind: before.kind }, after: { nameEn, kind: input.kind } });
    return;
  }
  if (before) throw new ProjectSystemError('code', `'${code}' is already a project type`);
  await tx.insert(projectType).values({ code, nameEn, nameAr: optionalText(input.nameAr), kind: input.kind, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'project_type.created', objectType: 'project_setting', objectId: code, after: { code, nameEn, kind: input.kind } });
}

export async function setTypeActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT, code);
  const [before] = await tx.select().from(projectType).where(eq(projectType.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('project_type', code);
  const why = optionalText(reason);
  if (!active && !why) throw new ProjectSystemError('reason', 'say why it is deactivated');
  await tx.update(projectType).set({ active, updatedAt: new Date() }).where(eq(projectType.code, code));
  await recordChange(tx, ctx, { action: active ? 'project_type.activated' : 'project_type.deactivated', objectType: 'project_setting', objectId: code, before: { active: before.active }, after: { active }, reason: why });
}

export async function toleranceProfiles(tx: Tx) {
  return tx.select().from(projectToleranceProfile).orderBy(asc(projectToleranceProfile.code));
}

export async function saveToleranceProfile(tx: Tx, ctx: ActorContext, input: { code: string; nameEn: string; nameAr?: string | null; warnPercent: string; stopPercent: string; existing: boolean }): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const nameEn = requireText(input.nameEn, 'name_en');
  const warn = Number(input.warnPercent);
  const stop = Number(input.stopPercent);
  if (!Number.isFinite(warn) || !Number.isFinite(stop) || warn <= 0 || warn > stop || stop > 200) throw new ProjectSystemError('percent', 'warn is above zero, at most the stop line, and the stop line is at most 200');
  const [before] = await tx.select().from(projectToleranceProfile).where(eq(projectToleranceProfile.code, code)).limit(1);
  const values = { nameEn, nameAr: optionalText(input.nameAr), warnPercent: warn.toFixed(4), stopPercent: stop.toFixed(4) };
  if (input.existing) {
    if (!before) throw new AdminNotFoundError('project_tolerance_profile', code);
    await tx.update(projectToleranceProfile).set({ ...values, updatedAt: new Date() }).where(eq(projectToleranceProfile.code, code));
    await recordChange(tx, ctx, { action: 'project_tolerance_profile.updated', objectType: 'project_setting', objectId: code, before: { warnPercent: before.warnPercent, stopPercent: before.stopPercent }, after: values });
    return;
  }
  if (before) throw new ProjectSystemError('code', `'${code}' is already a profile`);
  await tx.insert(projectToleranceProfile).values({ code, ...values, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'project_tolerance_profile.created', objectType: 'project_setting', objectId: code, after: { code, ...values } });
}

export async function setToleranceProfileActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT, code);
  const [before] = await tx.select().from(projectToleranceProfile).where(eq(projectToleranceProfile.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('project_tolerance_profile', code);
  const why = optionalText(reason);
  if (!active && !why) throw new ProjectSystemError('reason', 'say why it is deactivated');
  await tx.update(projectToleranceProfile).set({ active, updatedAt: new Date() }).where(eq(projectToleranceProfile.code, code));
  await recordChange(tx, ctx, { action: active ? 'project_tolerance_profile.activated' : 'project_tolerance_profile.deactivated', objectType: 'project_setting', objectId: code, before: { active: before.active }, after: { active }, reason: why });
}

export async function costCodes(tx: Tx) {
  return tx.select().from(projectCostCode).orderBy(asc(projectCostCode.code));
}

export async function saveCostCode(tx: Tx, ctx: ActorContext, input: { code: string; nameEn: string; nameAr?: string | null; accountId?: string | null; existing: boolean }): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const nameEn = requireText(input.nameEn, 'name_en');
  const [before] = await tx.select().from(projectCostCode).where(eq(projectCostCode.code, code)).limit(1);
  const values = { nameEn, nameAr: optionalText(input.nameAr), accountId: optionalText(input.accountId) };
  if (input.existing) {
    if (!before) throw new AdminNotFoundError('project_cost_code', code);
    await tx.update(projectCostCode).set({ ...values, updatedAt: new Date() }).where(eq(projectCostCode.code, code));
    await recordChange(tx, ctx, { action: 'project_cost_code.updated', objectType: 'project_setting', objectId: code, before: { nameEn: before.nameEn, accountId: before.accountId }, after: values });
    return;
  }
  if (before) throw new ProjectSystemError('code', `'${code}' is already a cost code`);
  await tx.insert(projectCostCode).values({ code, ...values, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'project_cost_code.created', objectType: 'project_setting', objectId: code, after: { code, ...values } });
}

export async function setCostCodeActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT, code);
  const [before] = await tx.select().from(projectCostCode).where(eq(projectCostCode.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('project_cost_code', code);
  const why = optionalText(reason);
  if (!active && !why) throw new ProjectSystemError('reason', 'say why it is deactivated');
  await tx.update(projectCostCode).set({ active, updatedAt: new Date() }).where(eq(projectCostCode.code, code));
  await recordChange(tx, ctx, { action: active ? 'project_cost_code.activated' : 'project_cost_code.deactivated', objectType: 'project_setting', objectId: code, before: { active: before.active }, after: { active }, reason: why });
}
