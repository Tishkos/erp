'use server';

/**
 * Projects — REQ-PM-001 Stage PM-1. The definition, its status profile and
 * its structure; every change is a service call with an audit row behind
 * it, and the baseline moves only while the project is a draft (R2).
 */
import { flag, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import * as pb from '@/server/services/project-budget';
import * as psch from '@/server/services/project-schedule';
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

/** PM-2 D-PM-5 — the stop line raised for one element with a reason; blank restores the profile's. */
export async function raiseStopLine(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn((tx, ctx) => pb.raiseStopLine(tx, ctx, code, text(form, 'wbs_code'), text(form, 'stop_percent') || null, text(form, 'reason')), back(form, code));
}

// ---------------------------------------------------------------------------
// PM-4 — the schedule, on the WBS workspace
// ---------------------------------------------------------------------------

const wbsPage = (form: FormData) => wbs(text(form, 'project_code'));

export async function addProjectActivity(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) =>
      psch.addActivity(tx, ctx, code, {
        wbsCode: text(form, 'wbs_code'),
        code: text(form, 'code') || null,
        name: text(form, 'name'),
        kind: text(form, 'kind') || 'activity',
        milestoneUsage: text(form, 'milestone_usage') || null,
        progressPercent: text(form, 'progress_percent') || null,
        durationDays: text(form, 'duration_days') || null,
        notBefore: text(form, 'not_before') || null,
        responsibleUserId: text(form, 'responsible_user_id') || null,
      }),
    wbsPage(form),
  );
}

export async function updateProjectActivity(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) =>
      psch.updateActivity(tx, ctx, code, text(form, 'activity_code'), {
        name: text(form, 'name'),
        durationDays: text(form, 'duration_days') || null,
        notBefore: text(form, 'not_before') || null,
        responsibleUserId: text(form, 'responsible_user_id') || null,
        progressPercent: text(form, 'progress_percent') || null,
      }),
    wbsPage(form),
  );
}

export async function cancelProjectActivity(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => psch.cancelActivity(tx, ctx, text(form, 'project_code'), text(form, 'activity_code'), text(form, 'reason')), wbsPage(form));
}

export async function recordActivityActual(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      psch.recordActual(tx, ctx, text(form, 'project_code'), text(form, 'activity_code'), {
        actualStart: text(form, 'actual_start') || null,
        actualFinish: text(form, 'actual_finish') || null,
        percentComplete: text(form, 'percent_complete') || null,
      }),
    wbsPage(form),
  );
}

export async function linkActivities(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      psch.addDependency(tx, ctx, text(form, 'project_code'), {
        predecessorCode: text(form, 'predecessor_code'),
        successorCode: text(form, 'successor_code'),
        kind: text(form, 'kind') || 'FS',
        lagDays: text(form, 'lag_days') || null,
      }),
    wbsPage(form),
  );
}

export async function unlinkActivities(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => psch.removeDependency(tx, ctx, text(form, 'project_code'), text(form, 'dependency_id')), wbsPage(form));
}

export async function scheduleProject(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(async (tx, ctx) => {
    if (form.has('calendar_code')) await psch.setCalendar(tx, ctx, code, text(form, 'calendar_code') || null);
    return psch.scheduleProject(tx, ctx, code, text(form, 'reason') || null);
  }, wbsPage(form));
}
