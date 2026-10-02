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
