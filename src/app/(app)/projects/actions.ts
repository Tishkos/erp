'use server';

/**
 * Projects — REQ-PM-001 Stage PM-1. The definition, its status profile and
 * its structure; every change is a service call with an audit row behind
 * it, and the baseline moves only while the project is a draft (R2).
 */
import { flag, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import * as ps from '@/server/services/project-system';

const LIST = '/projects';
const record = (code: string) => `/projects/${encodeURIComponent(code)}`;
const wbs = (code: string) => `/projects/wbs?project=${encodeURIComponent(code)}`;

export async function createProject(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      ps.createDefinition(tx, ctx, {
        code: text(form, 'code') || null,
        name: text(form, 'name'),
        typeCode: text(form, 'type_code'),
        customerId: text(form, 'customer_id') || null,
        branchCode: text(form, 'branch_code') || ctx.branchCode,
        managerUserId: text(form, 'manager_user_id'),
        departmentCode: text(form, 'department_code') || null,
        costCentreCode: text(form, 'cost_centre_code') || null,
        contractValueIqd: text(form, 'contract_value_iqd') || null,
        baselineBudgetIqd: text(form, 'baseline_budget_iqd') || null,
        baselineStartsOn: text(form, 'baseline_starts_on') || null,
        baselineEndsOn: text(form, 'baseline_ends_on') || null,
        ...(text(form, 'billing_method') ? { billingMethod: text(form, 'billing_method') as 'milestone' | 'progress' | 'time_and_material' | 'lump_sum' } : {}),
        retentionPercent: text(form, 'retention_percent') || null,
        advanceRecoveryPercent: text(form, 'advance_recovery_percent') || null,
        description: text(form, 'description') || null,
        toleranceProfileCode: text(form, 'tolerance_profile_code') || null,
      }),
    (value) => (value && typeof value === 'object' && 'projectCode' in value ? record(String((value as { projectCode: string }).projectCode)) : withQuery(LIST, 'new', '1')),
  );
}

export async function updateProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      ps.updateDefinition(tx, ctx, code, {
        name: text(form, 'name'),
        managerUserId: text(form, 'manager_user_id'),
        departmentCode: text(form, 'department_code') || null,
        costCentreCode: text(form, 'cost_centre_code') || null,
        description: text(form, 'description') || null,
        toleranceProfileCode: text(form, 'tolerance_profile_code') || null,
        forecastStartsOn: text(form, 'forecast_starts_on') || null,
        forecastEndsOn: text(form, 'forecast_ends_on') || null,
        ...(form.has('baseline_starts_on')
          ? {
              baselineStartsOn: text(form, 'baseline_starts_on') || null,
              baselineEndsOn: text(form, 'baseline_ends_on') || null,
              baselineBudgetIqd: text(form, 'baseline_budget_iqd') || null,
              contractValueIqd: text(form, 'contract_value_iqd') || null,
            }
          : {}),
      }),
    record(code),
  );
}

export async function releaseProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => ps.release(tx, ctx, code), record(code));
}

export async function holdProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => ps.hold(tx, ctx, code, text(form, 'reason')), record(code));
}

export async function resumeProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => ps.resume(tx, ctx, code, text(form, 'reason')), record(code));
}

export async function technicalCompleteProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => ps.technicalComplete(tx, ctx, code, text(form, 'note') || null), record(code));
}

export async function reopenProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => ps.reopen(tx, ctx, code, text(form, 'reason')), record(code));
}

export async function closeProject(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => ps.close(tx, ctx, code, text(form, 'note')), record(code));
}

const back = (form: FormData, code: string) => (text(form, 'back') === 'wbs' ? wbs(code) : record(code));

export async function addWbsElement(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) =>
      ps.addElement(tx, ctx, code, {
        parentCode: text(form, 'parent_code') || null,
        code: text(form, 'code') || null,
        name: text(form, 'name'),
        description: text(form, 'description') || null,
        responsibleUserId: text(form, 'responsible_user_id') || null,
        plannedStartsOn: text(form, 'planned_starts_on') || null,
        plannedEndsOn: text(form, 'planned_ends_on') || null,
        isPlanning: flag(form, 'is_planning'),
        isAccountAssignment: flag(form, 'is_account_assignment'),
        isBilling: flag(form, 'is_billing'),
      }),
    back(form, code),
  );
}

export async function updateWbsElement(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) =>
      ps.updateElement(tx, ctx, code, text(form, 'wbs_code'), {
        name: text(form, 'name'),
        description: text(form, 'description') || null,
        responsibleUserId: text(form, 'responsible_user_id') || null,
        plannedStartsOn: text(form, 'planned_starts_on') || null,
        plannedEndsOn: text(form, 'planned_ends_on') || null,
        isPlanning: flag(form, 'is_planning'),
        isAccountAssignment: flag(form, 'is_account_assignment'),
        isBilling: flag(form, 'is_billing'),
      }),
    back(form, code),
  );
}

export async function setWbsElementActive(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) => ps.setElementActive(tx, ctx, code, text(form, 'wbs_code'), text(form, 'active') === '1', text(form, 'reason') || null),
    back(form, code),
  );
}
