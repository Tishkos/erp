'use server';

/**
 * Payables settings — REQ-AP-001 §21.11, the Stage-1 tabs' actions.
 * Nothing deletes; a change to a time limit is a new dated row (A6).
 */
import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as settings from '@/server/services/payables-settings';

const BACK = '/administration/payables-settings';

export async function updateStage(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.updateStage(tx, ctx, {
        payableTypeCode: text(form, 'type'),
        code: text(form, 'code'),
        name: text(form, 'name') || undefined,
        sequence: text(form, 'sequence') ? Number(text(form, 'sequence')) : undefined,
        active: flag(form, 'active'),
      }),
    `${BACK}?tab=stages`,
  );
}

export async function setTimeLimit(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.setTimeLimit(tx, ctx, {
        checkCode: text(form, 'check'),
        scope: text(form, 'scope') || 'all',
        limitDays: Number(text(form, 'limit_days')),
        escalateAfterDays: text(form, 'escalate_days') ? Number(text(form, 'escalate_days')) : null,
        escalateToRole: text(form, 'escalate_role') || null,
        validFrom: text(form, 'valid_from'),
      }),
    `${BACK}?tab=limits`,
  );
}

export async function saveReasonCode(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.saveReasonCode(tx, ctx, {
        code: text(form, 'code'),
        name: text(form, 'name'),
        laneHint: text(form, 'lane_hint') || null,
        defaultOwnerRole: text(form, 'default_owner_role') || null,
        requiresDetail: flag(form, 'requires_detail'),
        active: flag(form, 'active'),
      }),
    `${BACK}?tab=reasons`,
  );
}

export async function saveExpenseCategory(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.saveExpenseCategory(tx, ctx, {
        code: text(form, 'code'),
        name: text(form, 'name'),
        requiresPo: flag(form, 'requires_po'),
        requiresReceipt: flag(form, 'requires_receipt'),
        active: flag(form, 'active'),
      }),
    `${BACK}?tab=categories`,
  );
}

export async function updateEventCode(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.updateEventCode(tx, ctx, {
        code: text(form, 'code'),
        name: text(form, 'name') || undefined,
        active: flag(form, 'active'),
      }),
    `${BACK}?tab=events`,
  );
}

export async function setTypeActive(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.setTypeActive(tx, ctx, {
        code: text(form, 'code'),
        active: flag(form, 'active'),
      }),
    `${BACK}?tab=types`,
  );
}
