'use server';

/**
 * Progress — REQ-PM-001 Stage PM-4 §10. A measurement is taken by one
 * person and approved by another; a milestone is reported reached by one
 * and approved by another (a progress milestone's approval is itself a
 * measurement).
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as projects from '@/server/services/projects';
import * as psch from '@/server/services/project-schedule';
import * as closing from '@/server/services/project-close';

const page = (form: FormData) => {
  const asOf = text(form, 'as_of');
  return `/projects/progress?project=${encodeURIComponent(text(form, 'project_code'))}${asOf ? `&as_of=${asOf}` : ''}`;
};

export async function measureProgress(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => psch.measure(tx, ctx, text(form, 'project_code'), { wbsCode: text(form, 'wbs_code'), measuredOn: text(form, 'measured_on'), percentComplete: text(form, 'percent_complete'), note: text(form, 'note') || null }),
    page(form),
  );
}

export async function approveMeasurement(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => projects.approveProgress(tx, ctx, text(form, 'progress_id')), page(form));
}

export async function reachMilestone(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => psch.reachMilestone(tx, ctx, text(form, 'project_code'), text(form, 'activity_code'), text(form, 'reached_on')), page(form));
}

export async function approveMilestone(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => psch.approveMilestone(tx, ctx, text(form, 'project_code'), text(form, 'activity_code')), page(form));
}

// REQ-PM-001 PM-6 (D-PM-8) — hours booked by one person, approved by another, posted monthly by Finance.

export async function bookHours(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      closing.bookHours(tx, ctx, text(form, 'project_code'), {
        wbsCode: text(form, 'wbs_code'),
        employeeId: text(form, 'employee_id'),
        workDate: text(form, 'work_date'),
        hours: text(form, 'hours'),
        costCode: text(form, 'cost_code') || null,
        note: text(form, 'note') || null,
      }),
    page(form),
  );
}

export async function approveHours(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => closing.approveHours(tx, ctx, text(form, 'timesheet_id')), page(form));
}

export async function cancelHours(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => closing.cancelHours(tx, ctx, text(form, 'timesheet_id'), text(form, 'reason')), page(form));
}

export async function postLabour(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => closing.postLabour(tx, ctx, text(form, 'project_code'), text(form, 'month')), page(form));
}
