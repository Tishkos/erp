/**
 * Performance — REQ-HR-001 Stage HR-5 (§11a "Performance").
 *
 *     cycle    draft ──open──▶ open ──close (every review signed off or cancelled)──▶ closed
 *
 *     review   draft ──rate──▶ rated ──sign off──▶ signed_off
 *                ▲               │ reopen (reason)
 *                └───────────────┘
 *              draft / rated ──cancel (reason)──▶ cancelled
 *
 * A cycle is a period people are reviewed for, kept on HR Settings. HR
 * starts its reviews — one per person per cycle (a unique index), the
 * reviewer the person's manager through the employee record's link, or
 * somebody HR names. The goals are set by HR or the reviewer; only the
 * reviewer rates them and finishes the review, and only when the weights make
 * 100 and every goal is rated: the overall is the weighted average, computed
 * (R2). An HR manager signs it off — never its reviewer, never the person
 * (a check and a trigger) — and the person reads it and may add their word,
 * once. Signed off or cancelled, it is the record (the trigger keeps it).
 *
 * Who reads a review: HR by its grant and branch, the person, the reviewer
 * (`app_review_reach` in the row policy).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, employee, performanceReview, reviewCycle, reviewGoal } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { HrValidationError, assertDay } from '../domain/hr';
import { can, type PermissionVerb } from '../domain/permissions';
import { MAX_GOALS, TalentError, assertCycleTransition, assertGoal, assertReviewTransition, overallRating, weightOf, type ReviewStatus } from '../domain/talent';
import { AdminNotFoundError, normaliseCode, optionalText, recordChange, requireText } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as hrSettings from './hr-settings';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'performance_review';
export const CYCLE_OBJECT = 'review_cycle';
const SEQUENCE_KEY = 'PERFORMANCE_REVIEW';

export { TalentError };

type ReviewRow = typeof performanceReview.$inferSelect;
type Reader = { principal: ActorContext['principal'] };

async function permit(ctx: ActorContext, verb: PermissionVerb, branchCode: string, objectId?: string): Promise<void> {
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode, objectId: objectId ?? null, requestId: ctx.requestId ?? null });
}

async function load(tx: Tx, reviewNo: string, options: { lock?: boolean } = {}): Promise<ReviewRow> {
  const query = tx.select().from(performanceReview).where(eq(performanceReview.reviewNo, reviewNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('review', reviewNo);
  return row;
}

interface Person {
  readonly id: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly fullNameAr: string | null;
  readonly branchCode: string;
  readonly departmentCode: string;
  readonly positionCode: string | null;
  readonly status: string;
  readonly hireDate: string;
  readonly appUserId: string | null;
  readonly managerUserId: string | null;
}

async function personOf(tx: Tx, employeeId: string): Promise<Person> {
  const [row] = await tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      branchCode: employee.branchCode,
      departmentCode: employee.departmentCode,
      positionCode: employee.positionCode,
      status: employee.status,
      hireDate: employee.hireDate,
      appUserId: employee.appUserId,
      managerUserId: sql<string | null>`(select m.app_user_id from employee m join app_user u on u.id = m.app_user_id where m.id = "employee"."manager_employee_id" and u.is_active)`,
    })
    .from(employee)
    .where(eq(employee.id, employeeId))
    .limit(1);
  if (!row) throw new HrValidationError('employee', 'names nobody you may see');
  return row;
}

async function cycleOf(tx: Tx, code: string, options: { lock?: boolean } = {}) {
  const query = tx.select().from(reviewCycle).where(eq(reviewCycle.code, code)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('review cycle', code);
  return row;
}

/** The HR managers of a branch — who sign off. */
async function signers(tx: Tx, branchCode: string): Promise<string[]> {
  const rows = (
    await tx.execute(sql`
      select distinct u.id
        from app_user u
        join user_role ur on ur.user_id = u.id
        join role_grant g on g.role_code = ur.role_code
       where u.is_active and g.object = ${PERMISSION_OBJECT} and g.verb = 'approve'::permission_verb
         and exists (select 1 from user_branch_scope s where s.user_id = u.id and s.branch_code = ${branchCode})`)
  ).rows as { id: string }[];
  return rows.map((r) => r.id);
}

async function tell(
  tx: Tx,
  recipients: Iterable<string | null>,
  row: { reviewNo: string; branchCode: string },
  event: string,
  occurrence: string,
  subject: string,
  body: string,
  except: readonly (string | null)[] = [],
) {
  const skip = new Set(except.filter(Boolean));
  for (const recipientUserId of new Set([...recipients].filter((id): id is string => Boolean(id) && !skip.has(id)))) {
    await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: event,
      objectType: PERMISSION_OBJECT,
      objectId: row.reviewNo,
      recipientUserId,
      subject,
      body,
      context: { reviewNo: row.reviewNo },
      dedupeKey: `${event}:${row.reviewNo}:${occurrence}:${recipientUserId}`,
      branchCode: row.branchCode,
    });
  }
}

// ---------------------------------------------------------------------------
// Cycles — master data on HR Settings
// ---------------------------------------------------------------------------

export interface CycleInput {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr?: string | null;
  readonly periodFrom: string;
  readonly periodTo: string;
}

export async function createCycle(tx: Tx, ctx: ActorContext, input: CycleInput): Promise<{ code: string }> {
  await authz.authorize(ctx.principal, 'configure', hrSettings.PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const code = normaliseCode(input.code);
  const periodFrom = assertDay(input.periodFrom, 'period_from');
  const periodTo = assertDay(input.periodTo, 'period_to');
  if (periodTo < periodFrom) throw new HrValidationError('period_to', `cannot be before ${periodFrom}`);
  const [taken] = await tx.select({ code: reviewCycle.code }).from(reviewCycle).where(eq(reviewCycle.code, code)).limit(1);
  if (taken) throw new HrValidationError('code', `${code} is already a review cycle`);
  const values = { code, nameEn: requireText(input.nameEn, 'name_en'), nameAr: optionalText(input.nameAr, 200), periodFrom, periodTo };
  await tx.insert(reviewCycle).values({ ...values, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'review_cycle.created', objectType: CYCLE_OBJECT, objectId: code, after: values });
  return { code };
}

async function moveCycle(tx: Tx, ctx: ActorContext, code: string, to: 'open' | 'closed'): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', hrSettings.PERMISSION_OBJECT, { branchCode: ctx.branchCode, objectId: code, requestId: ctx.requestId ?? null });
  const row = await cycleOf(tx, normaliseCode(code), { lock: true });
  assertCycleTransition(row.code, row.status, to);
  if (to === 'closed') {
    // Counted past row security: a cycle is company-wide, and so is what is left in it.
    const open = (await tx.execute(sql`select app_cycle_open_reviews(${row.code}) as n`)).rows[0] as { n: number };
    if (open.n > 0) throw new TalentError(`${row.code} has ${open.n} review(s) not yet signed off or cancelled; a cycle closes when every review is done.`);
  }
  await tx.update(reviewCycle).set({ status: to, updatedAt: new Date() }).where(eq(reviewCycle.code, row.code));
  await recordChange(tx, ctx, { action: `review_cycle.${to === 'open' ? 'opened' : 'closed'}`, objectType: CYCLE_OBJECT, objectId: row.code, before: { status: row.status }, after: { status: to } });
}

export const openCycle = (tx: Tx, ctx: ActorContext, code: string) => moveCycle(tx, ctx, code, 'open');
export const closeCycle = (tx: Tx, ctx: ActorContext, code: string) => moveCycle(tx, ctx, code, 'closed');

/** Every cycle, newest first, with what its reviews have come to (as the reader sees them). */
export async function cycles(tx: Tx) {
  return tx
    .select({
      code: reviewCycle.code,
      nameEn: reviewCycle.nameEn,
      nameAr: reviewCycle.nameAr,
      periodFrom: reviewCycle.periodFrom,
      periodTo: reviewCycle.periodTo,
      status: reviewCycle.status,
      reviews: sql<number>`(select count(*)::int from performance_review r where r.cycle_code = "review_cycle"."code" and r.status <> 'cancelled')`,
      signedOff: sql<number>`(select count(*)::int from performance_review r where r.cycle_code = "review_cycle"."code" and r.status = 'signed_off')`,
    })
    .from(reviewCycle)
    .orderBy(desc(reviewCycle.periodFrom), asc(reviewCycle.code));
}

// ---------------------------------------------------------------------------
// Starting reviews
// ---------------------------------------------------------------------------

async function assertOpenCycle(tx: Tx, code: string) {
  const cycle = await cycleOf(tx, normaliseCode(code));
  if (cycle.status !== 'open') throw new TalentError(`${cycle.code} is ${cycle.status}; reviews are written while their cycle is open.`);
  return cycle;
}

async function insertReview(tx: Tx, ctx: ActorContext, cycleCode: string, person: Person, reviewerUserId: string): Promise<{ id: string; reviewNo: string }> {
  const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode: person.branchCode, year: Number(businessToday().slice(0, 4)) }, ctx.principal.userId);
  const [made] = await tx
    .insert(performanceReview)
    .values({ reviewNo: allocated.documentNo, cycleCode, employeeId: person.id, branchCode: person.branchCode, reviewerUserId, createdBy: ctx.principal.userId })
    .returning({ id: performanceReview.id });
  await recordChange(tx, ctx, {
    action: 'performance_review.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode: person.branchCode,
    after: { cycleCode, employeeNo: person.employeeNo, reviewerUserId },
  });
  await tell(
    tx,
    [reviewerUserId],
    { reviewNo: allocated.documentNo, branchCode: person.branchCode },
    'hr.review_assigned',
    'assigned',
    `${allocated.documentNo}: review ${person.fullNameEn} for ${cycleCode}`,
    'Set the goals with HR, rate each one, and finish the review.',
    [ctx.principal.userId],
  );
  return { id: made!.id, reviewNo: allocated.documentNo };
}

async function assertReviewer(tx: Tx, person: Person, reviewerUserId: string | null | undefined): Promise<string> {
  const chosen = (reviewerUserId ?? '').trim() || person.managerUserId;
  if (!chosen) throw new HrValidationError('reviewer', `${person.employeeNo} has no manager with a sign-in; name the reviewer`);
  if (chosen === person.appUserId) throw new TalentError('A person does not review themself.');
  const [user] = await tx.select({ id: appUser.id, isActive: appUser.isActive }).from(appUser).where(eq(appUser.id, chosen)).limit(1);
  if (!user?.isActive) throw new HrValidationError('reviewer', 'names nobody who signs in');
  return chosen;
}

export interface ReviewInput {
  readonly cycleCode: string;
  readonly employeeId: string;
  /** The person's manager (by the link) when left out. */
  readonly reviewerUserId?: string | null;
}

/** One person's review in an open cycle — by HR. */
export async function create(tx: Tx, ctx: ActorContext, input: ReviewInput): Promise<{ id: string; reviewNo: string }> {
  const person = await personOf(tx, input.employeeId);
  await permit(ctx, 'create', person.branchCode, person.employeeNo);
  const cycle = await assertOpenCycle(tx, input.cycleCode);
  if (person.status === 'ended') throw new TalentError(`${person.employeeNo} has left; a review is for somebody still working.`);
  const [existing] = await tx
    .select({ reviewNo: performanceReview.reviewNo })
    .from(performanceReview)
    .where(and(eq(performanceReview.cycleCode, cycle.code), eq(performanceReview.employeeId, person.id)))
    .limit(1);
  if (existing) throw new TalentError(`${person.employeeNo} already has ${existing.reviewNo} in ${cycle.code}.`);
  return insertReview(tx, ctx, cycle.code, person, await assertReviewer(tx, person, input.reviewerUserId));
}

export interface StartOutcome {
  readonly made: readonly { readonly reviewNo: string; readonly employeeNo: string }[];
  readonly skipped: readonly { readonly employeeNo: string; readonly why: string }[];
}

/**
 * A review for everybody in a branch (and a department, if named) working in
 * the cycle's period who has none in it yet, each reviewed by their manager.
 * Somebody with no manager who signs in is passed over and named: HR adds
 * theirs with a reviewer.
 */
export async function startForCycle(tx: Tx, ctx: ActorContext, input: { cycleCode: string; branchCode?: string | null; departmentCode?: string | null }): Promise<StartOutcome> {
  const branchCode = (input.branchCode ?? '').trim() || ctx.branchCode;
  await permit(ctx, 'create', branchCode);
  const cycle = await assertOpenCycle(tx, input.cycleCode);
  const departmentCode = (input.departmentCode ?? '').trim() ? normaliseCode(input.departmentCode!, 'department') : null;
  const people = await tx
    .select({ id: employee.id })
    .from(employee)
    .where(
      and(
        eq(employee.branchCode, branchCode),
        inArray(employee.status, ['active', 'suspended']),
        sql`${employee.hireDate} <= ${cycle.periodTo}::date`,
        departmentCode ? eq(employee.departmentCode, departmentCode) : undefined,
        sql`not exists (select 1 from performance_review r where r.cycle_code = ${cycle.code} and r.employee_id = "employee"."id")`,
      ),
    )
    .orderBy(asc(employee.employeeNo));
  const made: { reviewNo: string; employeeNo: string }[] = [];
  const skipped: { employeeNo: string; why: string }[] = [];
  for (const { id } of people) {
    const person = await personOf(tx, id);
    if (!person.managerUserId || person.managerUserId === person.appUserId) {
      skipped.push({ employeeNo: person.employeeNo, why: 'no manager who signs in' });
      continue;
    }
    const review = await insertReview(tx, ctx, cycle.code, person, person.managerUserId);
    made.push({ reviewNo: review.reviewNo, employeeNo: person.employeeNo });
  }
  return { made, skipped };
}

/** Another reviewer for a draft — when the manager has changed or left. */
export async function assignReviewer(tx: Tx, ctx: ActorContext, reviewNo: string, reviewerUserId: string): Promise<void> {
  const row = await load(tx, reviewNo, { lock: true });
  await permit(ctx, 'edit_draft', row.branchCode, reviewNo);
  if (row.status !== 'draft') throw new TalentError(`${reviewNo} is ${row.status}; its reviewer changes while it is a draft.`);
  const person = await personOf(tx, row.employeeId);
  const chosen = await assertReviewer(tx, person, reviewerUserId);
  await tx.update(performanceReview).set({ reviewerUserId: chosen, updatedAt: new Date() }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, {
    action: 'performance_review.reviewer_changed',
    objectType: PERMISSION_OBJECT,
    objectId: reviewNo,
    branchCode: row.branchCode,
    before: { reviewerUserId: row.reviewerUserId },
    after: { reviewerUserId: chosen },
  });
  await tell(
    tx,
    [chosen],
    row,
    'hr.review_assigned',
    `reassigned:${chosen}`,
    `${reviewNo}: review ${person.fullNameEn} for ${row.cycleCode}`,
    'Set the goals with HR, rate each one, and finish the review.',
    [ctx.principal.userId],
  );
}

// ---------------------------------------------------------------------------
// Goals and rating
// ---------------------------------------------------------------------------

export interface GoalInput {
  /** The goal's line, to change it; none for a new goal. */
  readonly lineNo?: number | null;
  /** Empty removes the goal (a draft's line). */
  readonly title: string;
  readonly target?: string | null;
  readonly weight: number | string;
  /** Left out keeps the rating as it is; only the reviewer rates. */
  readonly rating?: number | string | null;
  readonly comment?: string | null;
}

/** Whether the reader is the review's reviewer. */
const isReviewer = (ctx: Reader, row: Pick<ReviewRow, 'reviewerUserId'>) => ctx.principal.userId === row.reviewerUserId;

/**
 * The goals of a draft as the form sends them: changed, added, or removed
 * (an empty title). HR and the reviewer set titles, targets and weights;
 * only the reviewer rates.
 */
export async function saveGoals(tx: Tx, ctx: ActorContext, reviewNo: string, goals: readonly GoalInput[]): Promise<{ weight: number }> {
  const row = await load(tx, reviewNo, { lock: true });
  const reviewer = isReviewer(ctx, row);
  if (!reviewer) await permit(ctx, 'edit_draft', row.branchCode, reviewNo);
  if (row.status !== 'draft') throw new TalentError(`${reviewNo} is ${row.status}; its goals change while it is a draft.`);
  const existing = await tx.select().from(reviewGoal).where(eq(reviewGoal.reviewId, row.id)).orderBy(asc(reviewGoal.lineNo));
  const byLine = new Map(existing.map((g) => [g.lineNo, g]));
  let nextLine = existing.reduce((max, g) => Math.max(max, g.lineNo), 0) + 1;
  const kept: { title: string; weight: number; rating: number | null }[] = [];
  const changes: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const [index, input] of goals.entries()) {
    const title = (input.title ?? '').trim();
    const lineNo = input.lineNo ? Number(input.lineNo) : null;
    const before = lineNo ? byLine.get(lineNo) : undefined;
    if (lineNo && !before) throw new TalentError(`${reviewNo} has no goal ${lineNo}.`);
    if (lineNo) seen.add(lineNo);
    if (!title) {
      if (before) {
        await tx.delete(reviewGoal).where(eq(reviewGoal.id, before.id));
        changes.push({ removed: before.lineNo, title: before.title });
      }
      continue;
    }
    const sent = input.rating === undefined ? undefined : String(input.rating ?? '').trim();
    if (sent && !reviewer) throw new TalentError(`Only the reviewer rates ${reviewNo}.`);
    const ratingText = reviewer ? sent : undefined;
    if (input.comment !== undefined && optionalText(input.comment, 1000) !== (before?.comment ?? null) && !reviewer) throw new TalentError(`Only the reviewer comments on a goal of ${reviewNo}.`);
    const goal = {
      title: requireText(title, 'title', 300),
      target: optionalText(input.target, 1000),
      weight: Number(String(input.weight ?? '').trim()),
      rating: ratingText === undefined ? (before?.rating ?? null) : ratingText === '' ? null : Number(ratingText),
      comment: input.comment === undefined ? (before?.comment ?? null) : optionalText(input.comment, 1000),
    };
    assertGoal(goal, index + 1);
    kept.push(goal);
    if (before) {
      await tx.update(reviewGoal).set(goal).where(eq(reviewGoal.id, before.id));
      changes.push({ line: before.lineNo, ...goal });
    } else {
      await tx.insert(reviewGoal).values({ reviewId: row.id, lineNo: nextLine, ...goal });
      changes.push({ added: nextLine, ...goal });
      nextLine += 1;
    }
  }
  // Lines the form did not send are kept as they are.
  for (const g of existing) if (!seen.has(g.lineNo)) kept.push({ title: g.title, weight: g.weight, rating: g.rating });
  if (kept.length > MAX_GOALS) throw new TalentError(`A review has at most ${MAX_GOALS} goals.`);
  const weight = weightOf(kept);
  if (weight > 100) throw new TalentError(`The goals' weights make ${weight}; they may not make more than 100.`);
  await tx.update(performanceReview).set({ updatedAt: new Date() }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, { action: 'performance_review.goals_saved', objectType: PERMISSION_OBJECT, objectId: reviewNo, branchCode: row.branchCode, after: { goals: changes, weight } });
  return { weight };
}

/** The reviewer finishes it: the weights make 100, every goal rated; the overall is computed. */
export async function complete(tx: Tx, ctx: ActorContext, reviewNo: string, comment?: string | null): Promise<{ overall: string }> {
  const row = await load(tx, reviewNo, { lock: true });
  if (!isReviewer(ctx, row)) throw new TalentError(`${reviewNo} is rated by its reviewer.`);
  assertReviewTransition(reviewNo, row.status, 'rated');
  await assertOpenCycle(tx, row.cycleCode);
  const goals = await tx.select().from(reviewGoal).where(eq(reviewGoal.reviewId, row.id)).orderBy(asc(reviewGoal.lineNo));
  const overall = overallRating(goals.map((g) => ({ title: g.title, weight: g.weight, rating: g.rating })));
  const said = optionalText(comment, 2000);
  const now = new Date();
  await tx.update(performanceReview).set({ status: 'rated', overallRating: overall, reviewerComment: said, ratedAt: now, updatedAt: now }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, {
    action: 'performance_review.rated',
    objectType: PERMISSION_OBJECT,
    objectId: reviewNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'rated', overall },
  });
  const person = await personOf(tx, row.employeeId);
  await tell(tx, [person.appUserId], row, 'hr.review_rated', now.toISOString(), `${reviewNo}: your review for ${row.cycleCode} is written`, 'Read it, and add your word if you wish.', [
    ctx.principal.userId,
  ]);
  await tell(
    tx,
    await signers(tx, row.branchCode),
    row,
    'hr.review_to_sign_off',
    now.toISOString(),
    `${reviewNo}: ${person.fullNameEn}'s review is rated ${overall} — sign it off`,
    `${row.cycleCode}`,
    [ctx.principal.userId, person.appUserId],
  );
  return { overall };
}

/** Back to a draft before sign-off — by the reviewer or an HR manager, with the reason. */
export async function reopen(tx: Tx, ctx: ActorContext, reviewNo: string, reason: string): Promise<void> {
  const row = await load(tx, reviewNo, { lock: true });
  if (!isReviewer(ctx, row)) await permit(ctx, 'approve', row.branchCode, reviewNo);
  assertReviewTransition(reviewNo, row.status, 'draft');
  const why = requireText(reason, 'reason', 500);
  await tx.update(performanceReview).set({ status: 'draft', overallRating: null, ratedAt: null, updatedAt: new Date() }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, {
    action: 'performance_review.reopened',
    objectType: PERMISSION_OBJECT,
    objectId: reviewNo,
    branchCode: row.branchCode,
    before: { status: row.status, overall: row.overallRating },
    after: { status: 'draft' },
    reason: why,
  });
  await tell(tx, [row.reviewerUserId], row, 'hr.review_reopened', new Date().toISOString(), `${reviewNo} is back with you: ${why}`, row.cycleCode, [ctx.principal.userId]);
}

/** Whether this reader may sign the review off, and if not, why — for the screen. */
export function signOffRefusal(ctx: Reader, person: { appUserId: string | null }, row: Pick<ReviewRow, 'status' | 'reviewerUserId'>): 'status' | 'maker' | 'grant' | null {
  if (row.status !== 'rated') return 'status';
  if (ctx.principal.userId === row.reviewerUserId || ctx.principal.userId === person.appUserId) return 'maker';
  return can(ctx.principal, 'approve', PERMISSION_OBJECT) ? null : 'grant';
}

/** Signed off by an HR manager — never its reviewer, never the person. */
export async function signOff(tx: Tx, ctx: ActorContext, reviewNo: string, note?: string | null): Promise<void> {
  const row = await load(tx, reviewNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  assertReviewTransition(reviewNo, row.status, 'signed_off');
  await permit(ctx, 'approve', row.branchCode, reviewNo);
  if (signOffRefusal(ctx, person, row) === 'maker') throw new TalentError(`You wrote or are the person on ${reviewNo}; somebody else signs it off.`);
  await assertOpenCycle(tx, row.cycleCode);
  const said = optionalText(note, 1000);
  const now = new Date();
  await tx.update(performanceReview).set({ status: 'signed_off', signedOffBy: ctx.principal.userId, signedOffAt: now, signOffNote: said, updatedAt: now }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, {
    action: 'performance_review.signed_off',
    objectType: PERMISSION_OBJECT,
    objectId: reviewNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'signed_off' },
    reason: said,
  });
  await tell(tx, [person.appUserId, row.reviewerUserId], row, 'hr.review_signed_off', 'signed_off', `${reviewNo} is signed off (${row.overallRating})`, row.cycleCode, [ctx.principal.userId]);
}

/** The person's own word on their review, once it is written — once. */
export async function comment(tx: Tx, ctx: ActorContext, reviewNo: string, text: string): Promise<void> {
  const row = await load(tx, reviewNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  if (!person.appUserId || person.appUserId !== ctx.principal.userId) throw new TalentError(`Only ${person.fullNameEn} adds their word to ${reviewNo}.`);
  if (row.status !== 'rated' && row.status !== 'signed_off') throw new TalentError(`${reviewNo} is ${row.status}; the person adds their word once it is written.`);
  if (row.employeeComment !== null) throw new TalentError(`Your word on ${reviewNo} is already given.`);
  const said = requireText(text, 'comment', 2000);
  const now = new Date();
  await tx.update(performanceReview).set({ employeeComment: said, employeeCommentedAt: now, updatedAt: now }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, { action: 'performance_review.commented', objectType: PERMISSION_OBJECT, objectId: reviewNo, branchCode: row.branchCode, after: { employeeComment: said } });
  await tell(tx, [row.reviewerUserId], row, 'hr.review_commented', 'commented', `${person.fullNameEn} added their word to ${reviewNo}`, said.slice(0, 200), [ctx.principal.userId]);
}

/** Not to be finished — the person left, the cycle was wrong — with the reason. */
export async function cancel(tx: Tx, ctx: ActorContext, reviewNo: string, reason: string): Promise<void> {
  const row = await load(tx, reviewNo, { lock: true });
  await permit(ctx, 'approve', row.branchCode, reviewNo);
  assertReviewTransition(reviewNo, row.status, 'cancelled');
  const why = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(performanceReview).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: now, cancelReason: why, updatedAt: now }).where(eq(performanceReview.id, row.id));
  await recordChange(tx, ctx, {
    action: 'performance_review.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: reviewNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'cancelled' },
    reason: why,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReviewListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly cycle?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: ReviewListFilter) {
  const view = filter.view && ['draft', 'rated', 'signed_off', 'cancelled'].includes(filter.view) ? filter.view : null;
  const cycle = (filter.cycle ?? '').trim() || null;
  const where = whereOf([
    view ? sql`r.status = ${view}` : null,
    cycle ? sql`r.cycle_code = ${cycle}` : null,
    searchOf([sql`r.review_no`, sql`e.employee_no`, sql`e.full_name_en`, sql`e.full_name_ar`], filter.search),
  ]);
  const from = sql`from performance_review r join employee e on e.id = r.employee_id ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select r.id, r.review_no as "reviewNo", r.cycle_code as "cycleCode", r.status, r.overall_rating::text as "overall",
                 e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", e.full_name_ar as "fullNameAr",
                 (select u.display_name from app_user u where u.id = r.reviewer_user_id) as "reviewerName",
                 (select coalesce(sum(g.weight), 0)::int from review_goal g where g.review_id = r.id) as weight,
                 (select count(*)::int from review_goal g where g.review_id = r.id) as goals
            ${from}
           order by case r.status when 'rated' then 0 when 'draft' then 1 else 2 end, r.cycle_code desc, e.employee_no
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        reviewNo: string;
        cycleCode: string;
        status: ReviewStatus;
        overall: string | null;
        employeeNo: string;
        fullNameEn: string;
        fullNameAr: string | null;
        reviewerName: string | null;
        weight: number;
        goals: number;
      }[],
  });
}

const userName = (column: string) => sql<string | null>`(select u.display_name from app_user u where u.id = ${sql.raw(`"performance_review"."${column}"`)})`;

/** The review, its person, its cycle and goals, and who did what. */
export async function byNo(tx: Tx, reviewNo: string) {
  const [found] = await tx
    .select({
      row: performanceReview,
      reviewerName: userName('reviewer_user_id'),
      createdByName: userName('created_by'),
      signedOffByName: userName('signed_off_by'),
      cancelledByName: userName('cancelled_by'),
      cycleName: reviewCycle.nameEn,
      cycleNameAr: reviewCycle.nameAr,
      periodFrom: reviewCycle.periodFrom,
      periodTo: reviewCycle.periodTo,
      cycleStatus: reviewCycle.status,
    })
    .from(performanceReview)
    .innerJoin(reviewCycle, eq(reviewCycle.code, performanceReview.cycleCode))
    .where(eq(performanceReview.reviewNo, reviewNo))
    .limit(1);
  if (!found) return null;
  const person = await personOf(tx, found.row.employeeId);
  const goals = await tx.select().from(reviewGoal).where(eq(reviewGoal.reviewId, found.row.id)).orderBy(asc(reviewGoal.lineNo));
  return { ...found, person, goals, weight: weightOf(goals) };
}

/** A person's reviews, newest cycle first — for their record. */
export async function ofEmployee(tx: Tx, employeeId: string) {
  return tx
    .select({
      reviewNo: performanceReview.reviewNo,
      cycleCode: performanceReview.cycleCode,
      status: performanceReview.status,
      overallRating: performanceReview.overallRating,
      reviewerName: userName('reviewer_user_id'),
      periodTo: reviewCycle.periodTo,
    })
    .from(performanceReview)
    .innerJoin(reviewCycle, eq(reviewCycle.code, performanceReview.cycleCode))
    .where(eq(performanceReview.employeeId, employeeId))
    .orderBy(desc(reviewCycle.periodTo));
}

/** People a review may be written for: those still working the reader can see. */
export async function reviewable(tx: Tx) {
  return tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn })
    .from(employee)
    .where(inArray(employee.status, ['active', 'suspended']))
    .orderBy(asc(employee.employeeNo));
}

/** Who may review: anybody who signs in. */
export async function reviewers(tx: Tx) {
  return tx.select({ id: appUser.id, displayName: appUser.displayName, email: appUser.email }).from(appUser).where(eq(appUser.isActive, true)).orderBy(asc(appUser.displayName));
}

export interface ReviewWaiting {
  readonly reviewNo: string;
  readonly fullNameEn: string;
  readonly cycleCode: string;
  readonly action: 'rate' | 'sign_off' | 'comment';
}

/** The reviews waiting on this reader: to rate (theirs to write), to sign off (HR), to read (their own). */
export async function waitingFor(tx: Tx, ctx: Reader): Promise<ReviewWaiting[]> {
  const rows = (
    await tx.execute(sql`
      select r.review_no as "reviewNo", r.cycle_code as "cycleCode", r.status, r.reviewer_user_id as "reviewerUserId", r.employee_comment as "employeeComment",
             e.full_name_en as "fullNameEn", e.app_user_id as "appUserId"
        from performance_review r
        join employee e on e.id = r.employee_id
        join review_cycle c on c.code = r.cycle_code
       where c.status = 'open' and r.status in ('draft', 'rated')
       order by r.review_no`)
  ).rows as { reviewNo: string; cycleCode: string; status: string; reviewerUserId: string; employeeComment: string | null; fullNameEn: string; appUserId: string | null }[];
  const out: ReviewWaiting[] = [];
  for (const r of rows) {
    const base = { reviewNo: r.reviewNo, fullNameEn: r.fullNameEn, cycleCode: r.cycleCode };
    if (r.status === 'draft' && r.reviewerUserId === ctx.principal.userId) out.push({ ...base, action: 'rate' });
    else if (r.status === 'rated' && r.appUserId === ctx.principal.userId && r.employeeComment === null) out.push({ ...base, action: 'comment' });
    else if (r.status === 'rated' && signOffRefusal(ctx, { appUserId: r.appUserId }, { status: 'rated', reviewerUserId: r.reviewerUserId }) === null) out.push({ ...base, action: 'sign_off' });
  }
  return out;
}
