/**
 * REQ-HR-001 Stage HR-5 — recruitment's and performance's rules, with no
 * database.
 *
 * An applicant moves forward through applied → screening → interview →
 * offer, may skip a stage, never goes back, and leaves with a note; only an
 * offer is hired, and only by the Hire action. A review's overall is the
 * weighted average of its goals' ratings — exact to two decimals, because
 * the weights are whole percentages making 100 and the ratings whole 1 to 5.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TalentError,
  assertCycleTransition,
  assertGoal,
  assertHeadcount,
  assertReviewTransition,
  assertStageMove,
  assertVacancyTransition,
  nextStages,
  overallRating,
  weightOf,
} from '@/server/domain/talent';

const ROOT = process.cwd();

describe('H9 · the pipeline', () => {
  it('moves forward, may skip a stage, never goes back', () => {
    expect(nextStages('applied')).toEqual(['screening', 'interview', 'offer', 'rejected', 'withdrawn']);
    expect(nextStages('offer')).toEqual(['rejected', 'withdrawn']);
    expect(assertStageMove('APL-1', 'applied', 'interview', null)).toBe('interview');
    expect(() => assertStageMove('APL-1', 'interview', 'screening', null)).toThrow(/moves forward, never back to screening/);
    expect(() => assertStageMove('APL-1', 'offer', 'offer', null)).toThrow(TalentError);
  });

  it('a rejection or a withdrawal carries its note; a hire is not a move; a closed application stays closed', () => {
    expect(() => assertStageMove('APL-1', 'screening', 'rejected', '  ')).toThrow(/Say why APL-1 is rejected/);
    expect(assertStageMove('APL-1', 'screening', 'withdrawn', 'Took another job')).toBe('withdrawn');
    expect(() => assertStageMove('APL-1', 'offer', 'hired', null)).toThrow(/hired by the Hire action/);
    expect(() => assertStageMove('APL-1', 'rejected', 'interview', null)).toThrow(/application is closed/);
    expect(nextStages('hired')).toEqual([]);
    expect(() => assertStageMove('APL-1', 'applied', 'promoted', null)).toThrow(/not a stage/);
  });

  it('a vacancy is drafted, opened, then filled or closed; a draft may be cancelled', () => {
    expect(() => assertVacancyTransition('VAC-1', 'draft', 'open')).not.toThrow();
    expect(() => assertVacancyTransition('VAC-1', 'draft', 'filled')).toThrow(/cannot become filled/);
    expect(() => assertVacancyTransition('VAC-1', 'open', 'cancelled')).toThrow(TalentError);
    expect(() => assertVacancyTransition('VAC-1', 'filled', 'open')).toThrow(TalentError);
    expect(assertHeadcount(3)).toBe(3);
    expect(() => assertHeadcount(0)).toThrow(/1 to 500/);
    expect(() => assertHeadcount(1.5)).toThrow(/1 to 500/);
  });
});

describe('H10 · the review', () => {
  it('rates the weighted average of the goals, exact to two decimals', () => {
    expect(
      overallRating([
        { title: 'Close the books by the 5th', weight: 40, rating: 4 },
        { title: 'Train the new clerk', weight: 30, rating: 3 },
        { title: 'Clear the old suspense items', weight: 30, rating: 5 },
      ]),
    ).toBe('4.00');
    expect(
      overallRating([
        { title: 'A', weight: 60, rating: 4 },
        { title: 'B', weight: 40, rating: 3 },
      ]),
    ).toBe('3.60');
    expect(
      overallRating([
        { title: 'A', weight: 33, rating: 5 },
        { title: 'B', weight: 33, rating: 4 },
        { title: 'C', weight: 34, rating: 4 },
      ]),
    ).toBe('4.33');
    expect(overallRating([{ title: 'Only', weight: 100, rating: 1 }])).toBe('1.00');
  });

  it('is refused until the weights make 100 and every goal is rated, saying what is missing', () => {
    expect(() => overallRating([])).toThrow(/it has none/);
    expect(() => overallRating([{ title: 'A', weight: 60, rating: 4 }])).toThrow(/weights make 60; they must make 100/);
    expect(() =>
      overallRating([
        { title: 'A', weight: 50, rating: 4 },
        { title: 'Train the clerk', weight: 50, rating: null },
      ]),
    ).toThrow(/Goal 2 \(Train the clerk\) is not rated/);
    expect(weightOf([{ weight: 25 }, { weight: 35 }])).toBe(60);
  });

  it('holds a goal to a title, a whole weight 1–100 and a rating 1–5', () => {
    expect(() => assertGoal({ title: ' ', weight: 10, rating: null }, 1)).toThrow(/no title/);
    expect(() => assertGoal({ title: 'A', weight: 0, rating: null }, 2)).toThrow(/Goal 2: the weight/);
    expect(() => assertGoal({ title: 'A', weight: 12.5, rating: null }, 1)).toThrow(/whole number/);
    expect(() => assertGoal({ title: 'A', weight: 101, rating: null }, 1)).toThrow(/1 to 100/);
    expect(() => assertGoal({ title: 'A', weight: 10, rating: 6 }, 1)).toThrow(/rating is 1 to 5/);
  });

  it('moves draft → rated → signed off, back to a draft before sign-off, cancelled before it; a cycle opens then closes', () => {
    expect(() => assertReviewTransition('REV-1', 'rated', 'draft')).not.toThrow();
    expect(() => assertReviewTransition('REV-1', 'draft', 'signed_off')).toThrow(/cannot become signed off/);
    expect(() => assertReviewTransition('REV-1', 'signed_off', 'cancelled')).toThrow(TalentError);
    expect(() => assertCycleTransition('2026-H1', 'draft', 'open')).not.toThrow();
    expect(() => assertCycleTransition('2026-H1', 'closed', 'open')).toThrow(TalentError);
  });
});

describe('H8 · recruitment and performance write their audit with every change', () => {
  for (const file of ['recruitment.ts', 'performance.ts']) {
    it(`every exported writer in ${file} records the change`, () => {
      const source = readFileSync(join(ROOT, 'src/server/services', file), 'utf8');
      const chunks = source.split(/\nexport async function /).slice(1);
      const offenders: string[] = [];
      for (const chunk of chunks) {
        const body = chunk.split(/\n(?:export |async function |function )/)[0]!;
        const writes = /\.(insert|update|delete)\((vacancy|applicant|applicantStage|reviewCycle|performanceReview|reviewGoal)\)/.test(body);
        // A writer may hand its rows to a helper that records them (insertReview, closePipeline).
        const records = /\brecordChange\(|\binsertReview\(|\bclosePipeline\(/.test(body);
        if (writes && !records) offenders.push(chunk.slice(0, chunk.indexOf('(')));
      }
      expect(offenders).toEqual([]);
      expect(chunks.length).toBeGreaterThanOrEqual(8);
    });
  }

  it('the database holds what the services promise', () => {
    const migration = readFileSync(join(ROOT, 'src/server/db/migrations/0259_hr_talent.sql'), 'utf8');
    for (const name of [
      'applicant_stage_append_only',
      'applicant_stage_closing_note',
      'applicant_hired_is_employee',
      'vacancy_headcount',
      'vacancy_filled',
      'performance_review_cycle_employee_uniq',
      'performance_review_signer_not_reviewer',
      'performance_review_guard',
      'review_goal_frozen',
    ])
      expect(migration).toContain(name);
    // An applicant is read under recruitment's own grant, not by the branch alone.
    expect(migration).toMatch(/applicant_scope[\s\S]*app_has_grant\('recruitment', 'view'\)/);
  });
});
