/**
 * The HR morning sweep — REQ-HR-001 Stage HR-2 (§3 "the sweep pattern").
 *
 * Three things become true while nobody is looking, so they are read once a
 * day and raised once each (the dedupe keys carry what makes them distinct):
 *
 *   contract expiring   a contract or daily engagement ends within the limit
 *                       → the HR managers, once per person per end date
 *   leave waiting       a request submitted longer ago than the limit and
 *                       still undecided → whoever may decide it, once
 *   leave lapsing       inside the limit before the year's end, unused days
 *                       of a type marked *warn before lapse* (annual leave)
 *                       above what carries over → the HR managers and the
 *                       person, once per person per type per year
 *   advance behind      HR-4: a paid advance or loan whose recoveries are
 *                       behind its schedule at the end of last month → the
 *                       HR managers, once per advance per month
 *   vacancy overdue     HR-5: an open vacancy past its closing day → the HR
 *                       managers, once per vacancy per closing day
 *
 * The limits are `hr_parameter` rows (R4), edited on HR Settings.
 */
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employee, leaveType } from '../db/schema';
import { HUNDRED, daysFrom, showDays, yearOf } from '../domain/hr-time';
import type { Principal } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as advances from './employee-advances';
import * as hrSettings from './hr-settings';
import * as leave from './leave';
import * as notifications from './notifications';
import * as recruitment from './recruitment';

export interface SweepRun {
  readonly asOf: string;
  readonly contractsExpiring: number;
  readonly leaveWaiting: number;
  readonly leaveLapsing: number;
  readonly advancesBehind: number;
  readonly vacanciesOverdue: number;
  readonly created: number;
}

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function run(tx: Tx, principal: Principal, asOf: string): Promise<SweepRun> {
  const limits = await hrSettings.parameters(tx);
  let created = 0;

  // 1 — contracts ending inside the warning window.
  const horizon = addDays(asOf, limits.contract_expiry_warning_days);
  const ending = await tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, branchCode: employee.branchCode, contractEndDate: employee.contractEndDate })
    .from(employee)
    .where(and(eq(employee.status, 'active'), isNotNull(employee.contractEndDate), lte(employee.contractEndDate, horizon), sql`${employee.contractEndDate} >= ${asOf}::date`));
  for (const person of ending) {
    const raised = await notifications.raise(
      tx,
      { eventType: 'hr.contract_expiring', objectType: 'employee', objectId: person.employeeNo, occurrence: person.contractEndDate },
      { employeeNo: person.employeeNo, name: person.fullNameEn, endDate: person.contractEndDate },
      { branchCode: person.branchCode, actorUserId: principal.userId },
    );
    created += raised.created;
  }

  // 2 — leave waiting longer than the reminder limit.
  const waitingSince = addDays(asOf, -limits.leave_pending_reminder_days);
  const waiting = await tx.execute(sql`
    select r.request_no as "requestNo", r.branch_code as "branchCode", r.requested_by as "requestedBy",
           r.from_date::text as "fromDate", r.to_date::text as "toDate",
           e.full_name_en as "fullNameEn", e.app_user_id as "personUserId",
           (select m.app_user_id from employee m where m.id = e.manager_employee_id) as "managerUserId"
      from leave_request r
      join employee e on e.id = r.employee_id
     where r.status = 'submitted'
       and (r.submitted_at at time zone 'Asia/Baghdad')::date <= ${waitingSince}::date`);
  const hrManagers = (await tx.execute(sql`select ur.user_id as "userId" from user_role ur join app_user u on u.id = ur.user_id where ur.role_code = 'hr_manager' and u.is_active`)).rows as {
    userId: string;
  }[];
  for (const row of waiting.rows as {
    requestNo: string;
    branchCode: string;
    requestedBy: string;
    fromDate: string;
    toDate: string;
    fullNameEn: string;
    personUserId: string | null;
    managerUserId: string | null;
  }[]) {
    const deciders = (row.managerUserId ? [row.managerUserId] : hrManagers.map((m) => m.userId)).filter((id) => id !== row.requestedBy && id !== row.personUserId);
    for (const recipientUserId of new Set(deciders)) {
      const id = await notifications.insertNotification(tx, {
        ruleCode: null,
        eventType: 'hr.leave_waiting',
        objectType: leave.PERMISSION_OBJECT,
        objectId: row.requestNo,
        recipientUserId,
        subject: `${row.requestNo} still waits for a decision`,
        body: `${row.fullNameEn}'s leave ${row.fromDate} to ${row.toDate} was sent ${limits.leave_pending_reminder_days} or more days ago and is not decided yet.`,
        context: { requestNo: row.requestNo },
        dedupeKey: `hr.leave_waiting:${row.requestNo}:${recipientUserId}`,
        branchCode: row.branchCode,
      });
      if (id !== null) created += 1;
    }
  }

  // 3 — annual leave that will not carry, inside the window before 31 December.
  let lapsing = 0;
  const year = yearOf(asOf);
  const yearEnd = `${year}-12-31`;
  if (addDays(asOf, limits.leave_lapse_warning_days) >= yearEnd) {
    const types = await tx
      .select()
      .from(leaveType)
      .where(and(eq(leaveType.active, true), eq(leaveType.warnBeforeLapse, true)));
    const limited = types.filter((t) => daysFrom(t.daysPerYear) > 0n);
    const people = await tx
      .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, branchCode: employee.branchCode, appUserId: employee.appUserId })
      .from(employee)
      .where(inArray(employee.status, ['active', 'suspended']));
    for (const person of people) {
      const balances = await leave.balances(tx, person.id, year);
      for (const type of limited) {
        const balance = balances.find((b) => b.leaveTypeCode === type.code);
        if (!balance) continue;
        const carry = daysFrom(type.carryOverDays);
        const lost = balance.available - carry;
        if (lost <= 0n || lost < HUNDRED / 2n) continue;
        lapsing += 1;
        const context = { employeeNo: person.employeeNo, name: person.fullNameEn, leaveType: type.nameEn, days: showDays(lost), year };
        const raised = await notifications.raise(tx, { eventType: 'hr.leave_lapsing', objectType: 'employee', objectId: person.employeeNo, occurrence: `${type.code}:${year}` }, context, {
          branchCode: person.branchCode,
          actorUserId: principal.userId,
        });
        created += raised.created;
        if (person.appUserId) {
          const id = await notifications.insertNotification(tx, {
            ruleCode: null,
            eventType: 'hr.leave_lapsing',
            objectType: 'employee',
            objectId: person.employeeNo,
            recipientUserId: person.appUserId,
            subject: `${showDays(lost)} days of ${type.nameEn} will not carry into ${year + 1}`,
            body: `You have ${showDays(balance.available)} days of ${type.nameEn} left in ${year}; ${showDays(carry)} carry into ${year + 1}. Ask for the rest before 31 December or it lapses.`,
            context,
            dedupeKey: `hr.leave_lapsing:${person.employeeNo}:${type.code}:${year}:self`,
            branchCode: person.branchCode,
          });
          if (id !== null) created += 1;
        }
      }
    }
  }

  // HR-4 — advances and loans behind their schedule, aged from the instalment that is missing.
  const behind = await advances.behindAsOf(tx, asOf);
  for (const advance of behind) {
    const raised = await notifications.raise(
      tx,
      { eventType: 'hr.advance_behind', objectType: 'employee_advance', objectId: advance.advanceNo, occurrence: asOf.slice(0, 7) },
      { advanceNo: advance.advanceNo, behindIqd: advance.behindIqd, since: advance.since.slice(0, 7), bucket: advance.bucket },
      { branchCode: advance.branchCode, actorUserId: principal.userId },
    );
    created += raised.created;
  }

  // HR-5 — open vacancies past their closing day: extend it, or close it with its reason.
  const overdue = await recruitment.overdueAsOf(tx, asOf);
  for (const seat of overdue) {
    const raised = await notifications.raise(
      tx,
      { eventType: 'hr.vacancy_overdue', objectType: recruitment.VACANCY_OBJECT, objectId: seat.vacancyNo, occurrence: seat.closesOn ?? asOf },
      { vacancyNo: seat.vacancyNo, position: seat.positionCode, closesOn: seat.closesOn, hired: `${seat.hired} of ${seat.headcount}` },
      { branchCode: seat.branchCode, actorUserId: principal.userId },
    );
    created += raised.created;
  }

  return { asOf, contractsExpiring: ending.length, leaveWaiting: waiting.rows.length, leaveLapsing: lapsing, advancesBehind: behind.length, vacanciesOverdue: overdue.length, created };
}

export type { ActorContext };
