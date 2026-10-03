/**
 * Recruitment and performance — REQ-HR-001 Stage HR-5: the rules, with no
 * database.
 *
 * A vacancy is a position to fill: drafted by HR, opened by the HR manager,
 * filled when as many are hired as it wanted, or closed with a reason. Its
 * applicants move forward through the pipeline — applied, screening,
 * interview, offer — a stage may be skipped but never gone back to; any
 * open stage may end in a rejection or a withdrawal, with its note; only an
 * offer becomes a hire.
 *
 * A performance review is one person's, for one cycle, by one reviewer. Its
 * goals carry weights that make 100 and a rating of 1 to 5 each; the overall
 * is the weighted average — Σ(weight × rating) ÷ 100, which is exact to two
 * decimals because the weights and ratings are whole numbers (R2: computed,
 * never typed).
 */

export const VACANCY_STATUSES = ['draft', 'open', 'filled', 'closed', 'cancelled'] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];

export const VACANCY_TRANSITIONS: Readonly<Record<VacancyStatus, readonly VacancyStatus[]>> = {
  draft: ['open', 'cancelled'],
  open: ['filled', 'closed'],
  filled: [],
  closed: [],
  cancelled: [],
};

/** The pipeline, in order; a hire comes only from an offer. */
export const PIPELINE = ['applied', 'screening', 'interview', 'offer'] as const;
export const APPLICANT_STAGES = [...PIPELINE, 'hired', 'rejected', 'withdrawn'] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];
/** Where an applicant's road ends. */
export const CLOSED_STAGES: readonly ApplicantStage[] = ['hired', 'rejected', 'withdrawn'];

export const REVIEW_STATUSES = ['draft', 'rated', 'signed_off', 'cancelled'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> = {
  draft: ['rated', 'cancelled'],
  rated: ['draft', 'signed_off', 'cancelled'],
  signed_off: [],
  cancelled: [],
};

export const CYCLE_STATUSES = ['draft', 'open', 'closed'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const CYCLE_TRANSITIONS: Readonly<Record<CycleStatus, readonly CycleStatus[]>> = {
  draft: ['open'],
  open: ['closed'],
  closed: [],
};

/** The rating scale, 1 to 5, as the screens name it. */
export const RATINGS = [1, 2, 3, 4, 5] as const;
export const MAX_GOALS = 10;

export class TalentError extends Error {
  readonly code = 'HR_TALENT';
  constructor(message: string) {
    super(message);
    this.name = 'TalentError';
  }
}

function assertMove<S extends string>(table: Readonly<Record<S, readonly S[]>>, no: string, from: string, to: S): void {
  const allowed = table[from as S] ?? [];
  if (!allowed.includes(to)) throw new TalentError(`${no} is ${from.replace('_', ' ')}; it cannot become ${to.replace('_', ' ')}.`);
}

export const assertVacancyTransition = (no: string, from: string, to: VacancyStatus) => assertMove(VACANCY_TRANSITIONS, no, from, to);
export const assertReviewTransition = (no: string, from: string, to: ReviewStatus) => assertMove(REVIEW_TRANSITIONS, no, from, to);
export const assertCycleTransition = (code: string, from: string, to: CycleStatus) => assertMove(CYCLE_TRANSITIONS, code, from, to);

export const isApplicantStage = (value: string): value is ApplicantStage => (APPLICANT_STAGES as readonly string[]).includes(value);
export const isOpenStage = (value: string) => (PIPELINE as readonly string[]).includes(value);

/**
 * Where an applicant may go from here: any later pipeline stage, or out —
 * rejected or withdrawn — with a note. A hire is `hire`, not a move.
 */
export function nextStages(from: string): ApplicantStage[] {
  const at = (PIPELINE as readonly string[]).indexOf(from);
  if (at < 0) return [];
  return [...PIPELINE.slice(at + 1), 'rejected', 'withdrawn'];
}

export function assertStageMove(applicantNo: string, from: string, to: string, note: string | null): ApplicantStage {
  if (!isApplicantStage(to)) throw new TalentError(`'${to}' is not a stage.`);
  if (to === 'hired') throw new TalentError(`${applicantNo} is hired by the Hire action, from an offer.`);
  if (!nextStages(from).includes(to)) {
    if (!isOpenStage(from)) throw new TalentError(`${applicantNo} is ${from}; their application is closed.`);
    throw new TalentError(`${applicantNo} is at ${from}; an applicant moves forward, never back to ${to}.`);
  }
  if ((to === 'rejected' || to === 'withdrawn') && !(note ?? '').trim()) throw new TalentError(`Say why ${applicantNo} is ${to}.`);
  return to;
}

/** Headcount between 1 and 500, a whole number. */
export function assertHeadcount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new TalentError('A vacancy is for 1 to 500 people.');
  return value;
}

export interface GoalLine {
  readonly title: string;
  readonly weight: number;
  readonly rating: number | null;
}

/** One goal as typed: a title, a whole-number weight 1–100, a rating 1–5 or none. */
export function assertGoal(goal: GoalLine, line: number): void {
  if (!goal.title.trim()) throw new TalentError(`Goal ${line} has no title.`);
  if (!Number.isInteger(goal.weight) || goal.weight < 1 || goal.weight > 100) throw new TalentError(`Goal ${line}: the weight is a whole number from 1 to 100.`);
  if (goal.rating !== null && !(RATINGS as readonly number[]).includes(goal.rating)) throw new TalentError(`Goal ${line}: the rating is 1 to 5.`);
}

export const weightOf = (goals: readonly Pick<GoalLine, 'weight'>[]) => goals.reduce((sum, goal) => sum + goal.weight, 0);

/**
 * The overall rating of a finished review, as text with two decimals: the
 * weights make exactly 100 and every goal is rated, else it is refused with
 * what is missing.
 */
export function overallRating(goals: readonly GoalLine[]): string {
  if (goals.length === 0) throw new TalentError('A review is rated on its goals; it has none.');
  goals.forEach((goal, i) => assertGoal(goal, i + 1));
  const total = weightOf(goals);
  if (total !== 100) throw new TalentError(`The goals' weights make ${total}; they must make 100.`);
  const unrated = goals.findIndex((goal) => goal.rating === null);
  if (unrated >= 0) throw new TalentError(`Goal ${unrated + 1} (${goals[unrated]!.title.trim()}) is not rated.`);
  const points = goals.reduce((sum, goal) => sum + goal.weight * (goal.rating as number), 0);
  return `${Math.trunc(points / 100)}.${String(points % 100).padStart(2, '0')}`;
}
