/**
 * Payables settings — REQ-AP-001 §21.11, the Stage-1 tabs.
 *
 * Everything here is R4 in practice: types, stages, time limits, reason
 * codes, expense categories and event codes are rows, edited by an
 * accounting manager, effective immediately, audited. Nothing is deleted —
 * a row is deactivated and keeps its history; a changed time limit is a new
 * dated row and the old one closes.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  expenseCategory,
  holdReasonCode,
  payableEventCode,
  payableLane,
  payableStage,
  payableType,
  stageTimeLimit,
  sweepCheck,
} from '../db/schema';
import { PayableValidationError, STAGE_RULES } from '../domain/payables';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import { SETTINGS_OBJECT } from './payables';

async function permit(ctx: ActorContext): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', SETTINGS_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });
}

async function recordChange(
  tx: Tx,
  ctx: ActorContext,
  action: string,
  objectId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action,
    objectType: SETTINGS_OBJECT,
    objectId,
    branchCode: ctx.branchCode,
    before,
    after,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Everything the settings screen shows, one read. */
export async function overview(tx: Tx) {
  const [types, lanes, stages, limits, checks, reasons, categories, eventCodes] =
    await Promise.all([
      tx.select().from(payableType).orderBy(asc(payableType.sortOrder)),
      tx.select().from(payableLane).orderBy(asc(payableLane.sortOrder)),
      tx
        .select()
        .from(payableStage)
        .orderBy(asc(payableStage.payableTypeCode), asc(payableStage.sequence)),
      tx
        .select()
        .from(stageTimeLimit)
        .orderBy(asc(stageTimeLimit.checkCode), asc(stageTimeLimit.validFrom)),
      tx.select().from(sweepCheck).orderBy(asc(sweepCheck.code)),
      tx.select().from(holdReasonCode).orderBy(asc(holdReasonCode.code)),
      tx.select().from(expenseCategory).orderBy(asc(expenseCategory.code)),
      tx
        .select()
        .from(payableEventCode)
        .orderBy(asc(payableEventCode.laneCode), asc(payableEventCode.code)),
    ]);
  return { types, lanes, stages, limits, checks, reasons, categories, eventCodes };
}

/** Stage names and order are the manager's; what makes one true is not (§6). */
export async function updateStage(
  tx: Tx,
  ctx: ActorContext,
  input: {
    payableTypeCode: string;
    code: string;
    name?: string | undefined;
    sequence?: number | undefined;
    active?: boolean | undefined;
  },
): Promise<void> {
  await permit(ctx);

  const [existing] = await tx
    .select()
    .from(payableStage)
    .where(
      and(
        eq(payableStage.payableTypeCode, input.payableTypeCode),
        eq(payableStage.code, input.code),
      ),
    )
    .limit(1);
  if (!existing) throw new PayableValidationError('stage', `no stage '${input.code}' on that rail.`);

  await tx
    .update(payableStage)
    .set({
      name: input.name?.trim() || existing.name,
      sequence: input.sequence ?? existing.sequence,
      active: input.active ?? existing.active,
    })
    .where(
      and(
        eq(payableStage.payableTypeCode, input.payableTypeCode),
        eq(payableStage.code, input.code),
      ),
    );

  await recordChange(
    tx,
    ctx,
    'payables_settings.stage_updated',
    `${input.payableTypeCode}:${input.code}`,
    { name: existing.name, sequence: existing.sequence, active: existing.active },
    {
      name: input.name?.trim() || existing.name,
      sequence: input.sequence ?? existing.sequence,
      active: input.active ?? existing.active,
    },
  );
}

/**
 * §19.3 — a changed limit is a NEW dated row; rows already written keep
 * saying what the limit was when they were in force (A6).
 */
export async function setTimeLimit(
  tx: Tx,
  ctx: ActorContext,
  input: {
    checkCode: string;
    scope?: string;
    limitDays: number;
    escalateAfterDays?: number | null;
    escalateToRole?: string | null;
    validFrom: string;
  },
): Promise<{ id: string }> {
  await permit(ctx);

  if (!Number.isInteger(input.limitDays) || input.limitDays < 0) {
    throw new PayableValidationError('limit_days', 'a limit is a whole number of days, zero or more.');
  }

  const [check] = await tx
    .select({ code: sweepCheck.code })
    .from(sweepCheck)
    .where(eq(sweepCheck.code, input.checkCode))
    .limit(1);
  if (!check) throw new PayableValidationError('check', `'${input.checkCode}' is not a check.`);

  const scope = input.scope?.trim() || 'all';

  // Close the row this one replaces, if any — same check, same scope, active.
  const [previous] = await tx
    .select()
    .from(stageTimeLimit)
    .where(
      and(
        eq(stageTimeLimit.checkCode, input.checkCode),
        eq(stageTimeLimit.scope, scope),
        eq(stageTimeLimit.active, true),
      ),
    )
    .limit(1);
  if (previous) {
    await tx
      .update(stageTimeLimit)
      .set({ active: false })
      .where(eq(stageTimeLimit.id, previous.id));
  }

  const [created] = await tx
    .insert(stageTimeLimit)
    .values({
      checkCode: input.checkCode,
      scope,
      limitDays: input.limitDays,
      escalateAfterDays: input.escalateAfterDays ?? null,
      escalateToRole: input.escalateToRole ?? null,
      validFrom: input.validFrom,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: stageTimeLimit.id });

  await recordChange(
    tx,
    ctx,
    'payables_settings.time_limit_set',
    `${input.checkCode}:${scope}`,
    previous ? { limitDays: previous.limitDays, validFrom: previous.validFrom } : null,
    { limitDays: input.limitDays, validFrom: input.validFrom },
  );

  return { id: created!.id };
}

/** New reason codes arrive by configuration; existing ones deactivate (R4). */
export async function saveReasonCode(
  tx: Tx,
  ctx: ActorContext,
  input: {
    code: string;
    name: string;
    laneHint?: string | null;
    defaultOwnerRole?: string | null;
    requiresDetail?: boolean;
    active?: boolean;
  },
): Promise<void> {
  await permit(ctx);

  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(code)) {
    throw new PayableValidationError('code', 'a reason code is 2–20 capitals, digits or underscores.');
  }
  if (code === 'PENDING_REASON') {
    throw new PayableValidationError('code', 'PENDING_REASON belongs to the sweep and cannot be edited.');
  }

  const [existing] = await tx
    .select()
    .from(holdReasonCode)
    .where(eq(holdReasonCode.code, code))
    .limit(1);

  if (existing) {
    await tx
      .update(holdReasonCode)
      .set({
        name: input.name.trim(),
        laneHint: input.laneHint ?? existing.laneHint,
        defaultOwnerRole: input.defaultOwnerRole ?? existing.defaultOwnerRole,
        requiresDetail: input.requiresDetail ?? existing.requiresDetail,
        active: input.active ?? existing.active,
      })
      .where(eq(holdReasonCode.code, code));
  } else {
    await tx.insert(holdReasonCode).values({
      code,
      name: input.name.trim(),
      laneHint: input.laneHint ?? null,
      defaultOwnerRole: input.defaultOwnerRole ?? null,
      requiresDetail: input.requiresDetail ?? false,
      createdBy: ctx.principal.userId,
    });
  }

  await recordChange(
    tx,
    ctx,
    'payables_settings.reason_code_saved',
    code,
    existing ? { name: existing.name, active: existing.active } : null,
    { name: input.name.trim(), active: input.active ?? true },
  );
}

export async function saveExpenseCategory(
  tx: Tx,
  ctx: ActorContext,
  input: {
    code: string;
    name: string;
    defaultExpenseAccountId?: string | null;
    requiresPo?: boolean;
    requiresReceipt?: boolean;
    active?: boolean;
  },
): Promise<void> {
  await permit(ctx);

  const code = input.code.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(code)) {
    throw new PayableValidationError('code', 'a category code is 2–40 lower-case letters, digits or underscores.');
  }

  const [existing] = await tx
    .select()
    .from(expenseCategory)
    .where(eq(expenseCategory.code, code))
    .limit(1);

  if (existing) {
    await tx
      .update(expenseCategory)
      .set({
        name: input.name.trim(),
        defaultExpenseAccountId: input.defaultExpenseAccountId ?? existing.defaultExpenseAccountId,
        requiresPo: input.requiresPo ?? existing.requiresPo,
        requiresReceipt: input.requiresReceipt ?? existing.requiresReceipt,
        active: input.active ?? existing.active,
      })
      .where(eq(expenseCategory.code, code));
  } else {
    await tx.insert(expenseCategory).values({
      code,
      name: input.name.trim(),
      defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
      requiresPo: input.requiresPo ?? false,
      requiresReceipt: input.requiresReceipt ?? true,
      createdBy: ctx.principal.userId,
    });
  }

  await recordChange(
    tx,
    ctx,
    'payables_settings.expense_category_saved',
    code,
    existing ? { name: existing.name, active: existing.active } : null,
    { name: input.name.trim(), active: input.active ?? true },
  );
}

/** Event codes: name and template only — codes arrive with the services that write them (§21.11). */
export async function updateEventCode(
  tx: Tx,
  ctx: ActorContext,
  input: {
    code: string;
    name?: string | undefined;
    summaryTemplate?: string | null | undefined;
    active?: boolean | undefined;
  },
): Promise<void> {
  await permit(ctx);

  const [existing] = await tx
    .select()
    .from(payableEventCode)
    .where(eq(payableEventCode.code, input.code))
    .limit(1);
  if (!existing) {
    throw new PayableValidationError(
      'code',
      `'${input.code}' is not in the catalogue — codes are added by the build that writes them.`,
    );
  }

  await tx
    .update(payableEventCode)
    .set({
      name: input.name?.trim() || existing.name,
      summaryTemplate: input.summaryTemplate ?? existing.summaryTemplate,
      active: input.active ?? existing.active,
    })
    .where(eq(payableEventCode.code, input.code));

  await recordChange(
    tx,
    ctx,
    'payables_settings.event_code_updated',
    input.code,
    { name: existing.name },
    { name: input.name?.trim() || existing.name },
  );
}

/** Deactivating a type stops new payables of it; existing ones keep their rail. */
export async function setTypeActive(
  tx: Tx,
  ctx: ActorContext,
  input: { code: string; active: boolean },
): Promise<void> {
  await permit(ctx);

  const [existing] = await tx
    .select()
    .from(payableType)
    .where(eq(payableType.code, input.code))
    .limit(1);
  if (!existing) throw new PayableValidationError('type', `'${input.code}' is not a payable type.`);

  await tx
    .update(payableType)
    .set({ active: input.active })
    .where(eq(payableType.code, input.code));

  await recordChange(
    tx,
    ctx,
    'payables_settings.type_toggled',
    input.code,
    { active: existing.active },
    { active: input.active },
  );
}

/** The derivation rules a stage may name, read-only on the screen (§21.11). */
export function knownStageRules(): string[] {
  return Object.keys(STAGE_RULES).sort();
}
