/**
 * The Project System's close, settlement and labour rules — REQ-PM-001 §8,
 * §12, Stage PM-6. No database.
 *
 * Money is IQD scaled by 10⁴; hours are scaled by 10² (7.5 hours is 750).
 */
import { divideHalfUp } from './money';
import { isWorkingDay, type WorkCalendar } from './project-schedule';
import { ProjectSystemError } from './project-system';

/** D-PM-8 — a working day is eight hours. */
export const HOURS_PER_DAY = 8;

export type SettlementKind = 'asset' | 'result';

/** D-PM-7 — an investment project settles to its asset under construction; the rest to the result. */
export function settlementKindOf(projectKind: string): SettlementKind {
  return projectKind === 'investment' ? 'asset' : 'result';
}

/** The first and last day of a month given as YYYY-MM. */
export function monthBounds(month: string): { first: string; last: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ProjectSystemError('month', `'${month}' is not a month (YYYY-MM)`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  if (m < 1 || m > 12) throw new ProjectSystemError('month', `'${month}' is not a month (YYYY-MM)`);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

/** The calendar's working days in a month. */
export function workingDaysIn(month: string, calendar: WorkCalendar): number {
  const { first, last } = monthBounds(month);
  const lastDay = Number(last.slice(8, 10));
  let count = 0;
  for (let d = 1; d <= lastDay; d += 1) {
    if (isWorkingDay(`${first.slice(0, 8)}${String(d).padStart(2, '0')}`, calendar)) count += 1;
  }
  return count;
}

/**
 * D-PM-8 — the hourly rate: the base salary in force for the month ÷ the
 * calendar's working days in it ÷ 8, half up to four decimals.
 */
export function hourlyRate(baseSalaryIqd: bigint, workingDays: number): bigint {
  if (workingDays <= 0) throw new ProjectSystemError('calendar', 'the month has no working day in the calendar; no rate can be had');
  if (baseSalaryIqd < 0n) throw new ProjectSystemError('salary', 'a base salary is not below zero');
  return divideHalfUp(baseSalaryIqd, BigInt(workingDays * HOURS_PER_DAY));
}

/** Hours (×10²) at a rate (×10⁴), as money (×10⁴), half up. */
export function labourAmount(hours: bigint, rateIqd: bigint): bigint {
  return divideHalfUp(hours * rateIqd, 100n);
}

/** What stands between a project and its close, beyond Phase 11's five (§12, §13 Close). */
export const PM_CLOSE_BLOCKERS = [
  'open_activities',
  'open_billing_lines',
  'draft_certificates',
  'unposted_timesheets',
  'settlement_not_posted',
] as const;
export type PmCloseBlocker = (typeof PM_CLOSE_BLOCKERS)[number];

export interface PmCloseState {
  readonly openActivities: readonly string[];
  readonly openBillingLines: number;
  readonly draftCertificates: number;
  readonly unpostedTimesheets: number;
  readonly settlementPosted: boolean;
}

export function pmCloseFindings(state: PmCloseState): { readonly blocker: PmCloseBlocker; readonly detail: string }[] {
  const out: { blocker: PmCloseBlocker; detail: string }[] = [];
  if (state.openActivities.length > 0) out.push({ blocker: 'open_activities', detail: `open work: ${state.openActivities.join(', ')}` });
  if (state.openBillingLines > 0) out.push({ blocker: 'open_billing_lines', detail: `${state.openBillingLines} billing-plan line(s) are neither billed nor cancelled` });
  if (state.draftCertificates > 0) out.push({ blocker: 'draft_certificates', detail: `${state.draftCertificates} certificate(s) are still drafts` });
  if (state.unpostedTimesheets > 0) out.push({ blocker: 'unposted_timesheets', detail: `${state.unpostedTimesheets} timesheet line(s) are not yet posted or cancelled` });
  if (!state.settlementPosted) out.push({ blocker: 'settlement_not_posted', detail: 'the settlement is not posted' });
  return out;
}
