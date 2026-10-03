'use server';

import { redirect } from 'next/navigation';
import { rowCount, runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as performance from '@/server/services/performance';

/**
 * Performance — REQ-HR-001 Stage HR-5. The service holds every rule: who
 * sets goals and who rates, the weights, the sign-off.
 */
const LIST = '/hr/performance';
const record = (reviewNo: string) => `${LIST}/${encodeURIComponent(reviewNo)}`;

export async function createReview(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    performance.create(tx, ctx, { cycleCode: text(form, 'cycle_code'), employeeId: text(form, 'employee_id'), reviewerUserId: text(form, 'reviewer_user_id') || null }),
  );
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.reviewNo)}?saved=1`);
}

/** Every person of a branch (and department) in the cycle, each with their manager as reviewer. */
export async function startReviews(form: FormData): Promise<void> {
  const cycleCode = text(form, 'start_cycle_code');
  const outcome = await runAdmin((tx, ctx) => performance.startForCycle(tx, ctx, { cycleCode, departmentCode: text(form, 'start_department_code') || null }));
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}`);
  const { made, skipped } = outcome.value!;
  const query = new URLSearchParams({
    cycle: cycleCode,
    saved: '1',
    made: String(made.length),
    skipped: skipped
      .slice(0, 30)
      .map((s) => s.employeeNo)
      .join(','),
  });
  redirect(`${LIST}?${query.toString()}`);
}

export async function saveGoals(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  const goals: performance.GoalInput[] = [];
  for (let i = 0; i < rowCount(form, 0, 20); i += 1) {
    goals.push({
      lineNo: Number(text(form, `line_no_${i}`)) || null,
      title: text(form, `title_${i}`),
      target: text(form, `target_${i}`) || null,
      weight: text(form, `weight_${i}`),
      // The rating and its comment travel only in the reviewer's form.
      ...(form.has(`rating_${i}`) ? { rating: text(form, `rating_${i}`) } : {}),
      ...(form.has(`comment_${i}`) ? { comment: text(form, `comment_${i}`) } : {}),
    });
  }
  await runAdminAndReturn((tx, ctx) => performance.saveGoals(tx, ctx, reviewNo, goals), record(reviewNo));
}

export async function completeReview(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  await runAdminAndReturn((tx, ctx) => performance.complete(tx, ctx, reviewNo, text(form, 'comment') || null), record(reviewNo));
}

export async function reopenReview(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  await runAdminAndReturn((tx, ctx) => performance.reopen(tx, ctx, reviewNo, text(form, 'reason')), record(reviewNo));
}

export async function signOffReview(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  await runAdminAndReturn((tx, ctx) => performance.signOff(tx, ctx, reviewNo, text(form, 'note') || null), record(reviewNo));
}

export async function commentOnReview(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  await runAdminAndReturn((tx, ctx) => performance.comment(tx, ctx, reviewNo, text(form, 'comment')), record(reviewNo));
}

export async function assignReviewer(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  await runAdminAndReturn((tx, ctx) => performance.assignReviewer(tx, ctx, reviewNo, text(form, 'reviewer_user_id')), record(reviewNo));
}

export async function cancelReview(form: FormData): Promise<void> {
  const reviewNo = text(form, 'review_no');
  await runAdminAndReturn((tx, ctx) => performance.cancel(tx, ctx, reviewNo, text(form, 'reason')), record(reviewNo));
}
