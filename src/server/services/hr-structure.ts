/**
 * HR structure — the Departments and Positions screens (REQ-FIX-001 FIX-5).
 *
 * Reading only. A department is the company's one `department` row — the
 * same the ledger's department dimension names — seen from HR: its seats,
 * who holds them, how many people work in it. A position is HR-1's seat
 * (`position`), written by `hr-settings.ts`. People are `employee` rows,
 * written by `employees.ts` alone; the counts here pass through the same
 * row security, so a branch-scoped HR officer counts the people they may see.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { department, employee, position } from '../db/schema';
import { organisation, type OrganisationRow } from './employees';

const LIVE = sql`e.status <> 'ended'`;

export type DepartmentRow = {
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly isFinance: boolean;
  readonly parentCode: string | null;
  readonly parentName: string | null;
  readonly managerName: string | null;
  readonly headcount: number;
  readonly seats: number;
  readonly vacant: number;
};

const departmentColumns = sql`
  d.code, d.name, d.active, d.is_finance as "isFinance", d.parent_code as "parentCode", p.name as "parentName",
  u.display_name as "managerName",
  (select count(*) from employee e where e.department_code = d.code and ${LIVE})::int as headcount,
  (select count(*) from position s where s.department_code = d.code and s.active)::int as seats,
  (select count(*) from position s where s.department_code = d.code and s.active
      and not exists (select 1 from employee e where e.position_code = s.code and ${LIVE}))::int as vacant`;

export async function departments(tx: Tx): Promise<readonly DepartmentRow[]> {
  const { rows } = await tx.execute(sql`
    select ${departmentColumns}
      from department d
      left join department p on p.code = d.parent_code
      left join app_user u on u.id = d.manager_user_id
     order by d.code`);
  return rows as unknown as DepartmentRow[];
}

export interface DepartmentDetail {
  readonly row: DepartmentRow;
  readonly seats: OrganisationRow['positions'];
  readonly unseated: OrganisationRow['unseated'];
  readonly people: readonly {
    readonly employeeNo: string;
    readonly fullNameEn: string;
    readonly fullNameAr: string | null;
    readonly positionTitle: string | null;
    readonly branchCode: string;
    readonly hireDate: string;
    readonly status: string;
  }[];
  readonly children: readonly { readonly code: string; readonly name: string }[];
}

export async function departmentByCode(tx: Tx, code: string): Promise<DepartmentDetail | null> {
  const { rows } = await tx.execute(sql`
    select ${departmentColumns}
      from department d
      left join department p on p.code = d.parent_code
      left join app_user u on u.id = d.manager_user_id
     where d.code = ${code}`);
  const row = rows[0] as unknown as DepartmentRow | undefined;
  if (!row) return null;
  const tree = (await organisation(tx)).find((entry) => entry.departmentCode === code);
  const people = await tx
    .select({
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      positionTitle: position.titleEn,
      branchCode: employee.branchCode,
      hireDate: employee.hireDate,
      status: employee.status,
    })
    .from(employee)
    .leftJoin(position, eq(position.code, employee.positionCode))
    .where(eq(employee.departmentCode, code))
    .orderBy(asc(employee.employeeNo));
  const children = await tx.select({ code: department.code, name: department.name }).from(department).where(eq(department.parentCode, code)).orderBy(asc(department.code));
  return { row, seats: tree?.positions ?? [], unseated: tree?.unseated ?? [], people, children };
}

export type PositionRow = {
  readonly code: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly reportsToCode: string | null;
  readonly reportsToTitle: string | null;
  readonly active: boolean;
  readonly holders: number;
};

const positionColumns = sql`
  s.code, s.title_en as "titleEn", s.title_ar as "titleAr", s.department_code as "departmentCode", d.name as "departmentName",
  s.reports_to_code as "reportsToCode", r.title_en as "reportsToTitle", s.active,
  (select count(*) from employee e where e.position_code = s.code and ${LIVE})::int as holders`;

export async function positions(tx: Tx): Promise<readonly PositionRow[]> {
  const { rows } = await tx.execute(sql`
    select ${positionColumns}
      from position s
      join department d on d.code = s.department_code
      left join position r on r.code = s.reports_to_code
     order by s.department_code, s.code`);
  return rows as unknown as PositionRow[];
}

export interface PositionDetail {
  readonly row: PositionRow;
  readonly holders: readonly {
    readonly employeeNo: string;
    readonly fullNameEn: string;
    readonly fullNameAr: string | null;
    readonly branchCode: string;
    readonly hireDate: string;
    readonly status: string;
  }[];
  readonly reports: readonly { readonly code: string; readonly titleEn: string; readonly titleAr: string | null; readonly active: boolean }[];
}

export async function positionByCode(tx: Tx, code: string): Promise<PositionDetail | null> {
  const { rows } = await tx.execute(sql`
    select ${positionColumns}
      from position s
      join department d on d.code = s.department_code
      left join position r on r.code = s.reports_to_code
     where s.code = ${code}`);
  const row = rows[0] as unknown as PositionRow | undefined;
  if (!row) return null;
  const holders = await tx
    .select({
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      branchCode: employee.branchCode,
      hireDate: employee.hireDate,
      status: employee.status,
    })
    .from(employee)
    .where(eq(employee.positionCode, code))
    .orderBy(asc(employee.employeeNo));
  const reports = await tx
    .select({ code: position.code, titleEn: position.titleEn, titleAr: position.titleAr, active: position.active })
    .from(position)
    .where(eq(position.reportsToCode, code))
    .orderBy(asc(position.code));
  return { row, holders, reports };
}
