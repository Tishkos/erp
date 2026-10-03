/**
 * Recruitment — REQ-HR-001 Stage HR-5 (§11a "Recruitment").
 *
 *     vacancy   draft ──open──▶ open ──last hire──▶ filled
 *                 │ cancel (reason)   └──close (reason)──▶ closed
 *                 ▼
 *             cancelled
 *
 *     applicant applied ─▶ screening ─▶ interview ─▶ offer ──hire──▶ hired (an employee)
 *                 any open stage ──reject / withdraw (note)──▶ rejected / withdrawn
 *
 * A vacancy is a position to fill in a branch: HR drafts it, the HR manager
 * (`approve` on recruitment) opens it and hires. Applicants are added while it
 * is open and move forward, every move an append-only `applicant_stage` row.
 * A hire makes the employee through `employees.create` in the same
 * transaction — one record per person (R1), its first history row saying
 * which application it came from — and counts against the headcount; the
 * last hire fills the vacancy. When a vacancy stops (filled or closed) the
 * applicants still in its pipeline are told no, each by a stage row naming
 * why: an application does not stay open on a seat that is gone.
 *
 * An applicant is somebody outside the company, so they are read under
 * recruitment's own grant (the row policy asks for it), and their CV is filed
 * on their record (the attachment check in `attachments-runtime.ts`).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { applicant, applicantStage, employee, position, vacancy } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { EMPLOYMENT_KINDS, HrValidationError, assertDay, isEmploymentKind } from '../domain/hr';
import { can, type PermissionVerb } from '../domain/permissions';
import { CLOSED_STAGES, PIPELINE, TalentError, assertHeadcount, assertStageMove, assertVacancyTransition, nextStages, type ApplicantStage, type VacancyStatus } from '../domain/talent';
import { AdminNotFoundError, normaliseCode, optionalText, recordChange, requireText } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as employees from './employees';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'recruitment';
export const VACANCY_OBJECT = 'vacancy';
export const APPLICANT_OBJECT = 'applicant';
const VACANCY_SEQUENCE = 'VACANCY';
const APPLICANT_SEQUENCE = 'APPLICANT';

export { TalentError };

type VacancyRow = typeof vacancy.$inferSelect;
type ApplicantRow = typeof applicant.$inferSelect;

async function permit(ctx: ActorContext, verb: PermissionVerb, branchCode: string, objectId?: string): Promise<void> {
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode, objectId: objectId ?? null, requestId: ctx.requestId ?? null });
}

async function loadVacancy(tx: Tx, vacancyNo: string, options: { lock?: boolean } = {}): Promise<VacancyRow> {
  const query = tx.select().from(vacancy).where(eq(vacancy.vacancyNo, vacancyNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('vacancy', vacancyNo);
  return row;
}

async function loadApplicant(tx: Tx, applicantNo: string, options: { lock?: boolean } = {}): Promise<ApplicantRow> {
  const query = tx.select().from(applicant).where(eq(applicant.applicantNo, applicantNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('applicant', applicantNo);
  return row;
}

/** The HR managers of a branch — who opens, closes and hires. */
async function deciders(tx: Tx, branchCode: string): Promise<string[]> {
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
  about: { objectType: string; objectNo: string; branchCode: string },
  event: string,
  subject: string,
  body: string,
  except: readonly (string | null)[] = [],
) {
  const { objectType, objectNo, branchCode } = about;
  const skip = new Set(except.filter(Boolean));
  for (const recipientUserId of new Set([...recipients].filter((id): id is string => Boolean(id) && !skip.has(id)))) {
    await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: event,
      objectType,
      objectId: objectNo,
      recipientUserId,
      subject,
      body,
      context: { reference: objectNo },
      dedupeKey: `${event}:${objectNo}:${recipientUserId}`,
      branchCode,
    });
  }
}

// ---------------------------------------------------------------------------
// The vacancy
// ---------------------------------------------------------------------------

export interface VacancyInput {
  readonly positionCode: string;
  /** The position's own department when left out. */
  readonly departmentCode?: string | null;
  readonly headcount?: number | string | null;
  readonly employmentKind?: string | null;
  readonly opensOn?: string | null;
  readonly closesOn?: string | null;
  readonly description: string;
}

async function valuesOf(tx: Tx, input: VacancyInput) {
  const code = normaliseCode(input.positionCode ?? '', 'position');
  const [seat] = await tx.select({ code: position.code, active: position.active, departmentCode: position.departmentCode }).from(position).where(eq(position.code, code)).limit(1);
  if (!seat) throw new HrValidationError('position', `names no position '${code}'`);
  if (!seat.active) throw new HrValidationError('position', `${code} is deactivated; a vacancy is for a position in use`);
  const departmentCode = (input.departmentCode ?? '').trim() ? normaliseCode(input.departmentCode!, 'department') : seat.departmentCode;
  const kind = (input.employmentKind ?? '').trim() || 'permanent';
  if (!isEmploymentKind(kind)) throw new HrValidationError('employment_kind', `must be one of ${EMPLOYMENT_KINDS.join(', ')}`);
  const headcount = assertHeadcount(Number(input.headcount ?? 1) || 0);
  const opensOn = assertDay((input.opensOn ?? '').trim() || businessToday(), 'opens_on');
  const closesOn = (input.closesOn ?? '').trim() ? assertDay(input.closesOn!.trim(), 'closes_on') : null;
  if (closesOn && closesOn < opensOn) throw new HrValidationError('closes_on', `cannot be before the opening day ${opensOn}`);
  return { positionCode: code, departmentCode, employmentKind: kind, headcount, opensOn, closesOn, description: requireText(input.description, 'description', 2000) };
}

/** A vacancy in the drafter's branch, as a draft. */
export async function createVacancy(tx: Tx, ctx: ActorContext, input: VacancyInput): Promise<{ id: string; vacancyNo: string }> {
  await permit(ctx, 'create', ctx.branchCode);
  const values = await valuesOf(tx, input);
  const allocated = await allocateDocumentNumber(tx, VACANCY_SEQUENCE, { branchCode: ctx.branchCode, year: Number(businessToday().slice(0, 4)) }, ctx.principal.userId);
  const [made] = await tx
    .insert(vacancy)
    .values({ vacancyNo: allocated.documentNo, branchCode: ctx.branchCode, ...values, createdBy: ctx.principal.userId })
    .returning({ id: vacancy.id });
  await recordChange(tx, ctx, { action: 'vacancy.created', objectType: VACANCY_OBJECT, objectId: allocated.documentNo, branchCode: ctx.branchCode, after: { ...values } });
  return { id: made!.id, vacancyNo: allocated.documentNo };
}

export async function updateVacancy(tx: Tx, ctx: ActorContext, vacancyNo: string, input: VacancyInput): Promise<void> {
  const row = await loadVacancy(tx, vacancyNo, { lock: true });
  await permit(ctx, 'edit_draft', row.branchCode, vacancyNo);
  if (row.status !== 'draft') throw new TalentError(`${vacancyNo} is ${row.status}; only a draft is changed.`);
  const values = await valuesOf(tx, input);
  await tx
    .update(vacancy)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(vacancy.id, row.id));
  await recordChange(tx, ctx, {
    action: 'vacancy.updated',
    objectType: VACANCY_OBJECT,
    objectId: vacancyNo,
    branchCode: row.branchCode,
    before: { positionCode: row.positionCode, departmentCode: row.departmentCode, headcount: row.headcount, employmentKind: row.employmentKind, opensOn: row.opensOn, closesOn: row.closesOn },
    after: { ...values },
  });
}

/** Opened by the HR manager: applicants may now be added. */
export async function openVacancy(tx: Tx, ctx: ActorContext, vacancyNo: string): Promise<void> {
  const row = await loadVacancy(tx, vacancyNo, { lock: true });
  await permit(ctx, 'approve', row.branchCode, vacancyNo);
  assertVacancyTransition(vacancyNo, row.status, 'open');
  const now = new Date();
  await tx.update(vacancy).set({ status: 'open', openedBy: ctx.principal.userId, openedAt: now, updatedAt: now }).where(eq(vacancy.id, row.id));
  await recordChange(tx, ctx, { action: 'vacancy.opened', objectType: VACANCY_OBJECT, objectId: vacancyNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: 'open' } });
}

/**
 * An open vacancy given a later closing day or another headcount (never
 * fewer than are hired) — by the HR manager. A headcount brought down to the
 * hires already made fills it.
 */
export async function amendOpen(tx: Tx, ctx: ActorContext, vacancyNo: string, input: { closesOn?: string | null; headcount?: number | string | null }): Promise<{ filled: boolean }> {
  const row = await loadVacancy(tx, vacancyNo, { lock: true });
  await permit(ctx, 'approve', row.branchCode, vacancyNo);
  if (row.status !== 'open') throw new TalentError(`${vacancyNo} is ${row.status}; only an open vacancy is amended.`);
  const closesOn = (input.closesOn ?? '').trim() ? assertDay(input.closesOn!.trim(), 'closes_on') : null;
  if (closesOn && closesOn < row.opensOn) throw new HrValidationError('closes_on', `cannot be before the opening day ${row.opensOn}`);
  const headcount = assertHeadcount(Number(input.headcount ?? row.headcount) || 0);
  if (headcount < row.hired) throw new TalentError(`${vacancyNo} has already hired ${row.hired}; the headcount cannot be fewer.`);
  const filled = headcount === row.hired;
  const now = new Date();
  await tx
    .update(vacancy)
    .set({ closesOn, headcount, ...(filled ? { status: 'filled' as VacancyStatus, closedBy: ctx.principal.userId, closedAt: now } : {}), updatedAt: now })
    .where(eq(vacancy.id, row.id));
  await recordChange(tx, ctx, {
    action: filled ? 'vacancy.filled' : 'vacancy.amended',
    objectType: VACANCY_OBJECT,
    objectId: vacancyNo,
    branchCode: row.branchCode,
    before: { closesOn: row.closesOn, headcount: row.headcount },
    after: { closesOn, headcount, ...(filled ? { status: 'filled' } : {}) },
  });
  if (filled) await closePipeline(tx, ctx, row, `${vacancyNo} is filled`);
  return { filled };
}

/** A draft that will not be opened, with its reason. */
export async function cancelVacancy(tx: Tx, ctx: ActorContext, vacancyNo: string, reason: string): Promise<void> {
  const row = await loadVacancy(tx, vacancyNo, { lock: true });
  await permit(ctx, 'edit_draft', row.branchCode, vacancyNo);
  assertVacancyTransition(vacancyNo, row.status, 'cancelled');
  const why = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(vacancy).set({ status: 'cancelled', closedBy: ctx.principal.userId, closedAt: now, closeReason: why, updatedAt: now }).where(eq(vacancy.id, row.id));
  await recordChange(tx, ctx, {
    action: 'vacancy.cancelled',
    objectType: VACANCY_OBJECT,
    objectId: vacancyNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'cancelled' },
    reason: why,
  });
}

/** The applicants still in a pipeline, told no with the reason the vacancy stopped. */
async function closePipeline(tx: Tx, ctx: ActorContext, row: VacancyRow, note: string): Promise<number> {
  const open = await tx
    .select({ id: applicant.id, applicantNo: applicant.applicantNo, stage: applicant.stage })
    .from(applicant)
    .where(and(eq(applicant.vacancyId, row.id), inArray(applicant.stage, [...PIPELINE])))
    .for('update');
  for (const person of open) {
    await tx.update(applicant).set({ stage: 'rejected', updatedAt: new Date() }).where(eq(applicant.id, person.id));
    await tx.insert(applicantStage).values({ applicantId: person.id, fromStage: person.stage, toStage: 'rejected', note, movedBy: ctx.principal.userId });
    await recordChange(tx, ctx, {
      action: 'applicant.moved',
      objectType: APPLICANT_OBJECT,
      objectId: person.applicantNo,
      branchCode: row.branchCode,
      before: { stage: person.stage },
      after: { stage: 'rejected' },
      reason: note,
    });
  }
  return open.length;
}

/** An open vacancy stopped before it filled, with its reason; its open applications end with it. */
export async function closeVacancy(tx: Tx, ctx: ActorContext, vacancyNo: string, reason: string): Promise<{ applicantsClosed: number }> {
  const row = await loadVacancy(tx, vacancyNo, { lock: true });
  await permit(ctx, 'approve', row.branchCode, vacancyNo);
  assertVacancyTransition(vacancyNo, row.status, 'closed');
  const why = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(vacancy).set({ status: 'closed', closedBy: ctx.principal.userId, closedAt: now, closeReason: why, updatedAt: now }).where(eq(vacancy.id, row.id));
  await recordChange(tx, ctx, {
    action: 'vacancy.closed',
    objectType: VACANCY_OBJECT,
    objectId: vacancyNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'closed' },
    reason: why,
  });
  return { applicantsClosed: await closePipeline(tx, ctx, row, `${vacancyNo} was closed: ${why}`) };
}

// ---------------------------------------------------------------------------
// Applicants
// ---------------------------------------------------------------------------

export interface ApplicantInput {
  readonly fullNameEn: string;
  readonly fullNameAr?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly source?: string | null;
  readonly note?: string | null;
}

function emailOf(value: string | null | undefined): string | null {
  const text = optionalText(value, 200);
  if (text && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) throw new HrValidationError('email', `'${text}' is not an e-mail address`);
  return text;
}

/** Somebody who applied for an open vacancy: at `applied`, the first stage row written. */
export async function addApplicant(tx: Tx, ctx: ActorContext, vacancyNo: string, input: ApplicantInput): Promise<{ id: string; applicantNo: string }> {
  const row = await loadVacancy(tx, vacancyNo, { lock: true });
  await permit(ctx, 'create', row.branchCode, vacancyNo);
  if (row.status !== 'open') throw new TalentError(`${vacancyNo} is ${row.status}; applicants are added while it is open.`);
  const values = {
    fullNameEn: requireText(input.fullNameEn, 'full_name_en'),
    fullNameAr: optionalText(input.fullNameAr, 200),
    phone: optionalText(input.phone, 64),
    email: emailOf(input.email),
    source: optionalText(input.source, 200),
    note: optionalText(input.note, 2000),
  };
  const allocated = await allocateDocumentNumber(tx, APPLICANT_SEQUENCE, { branchCode: row.branchCode, year: Number(businessToday().slice(0, 4)) }, ctx.principal.userId);
  const [made] = await tx
    .insert(applicant)
    .values({ applicantNo: allocated.documentNo, vacancyId: row.id, branchCode: row.branchCode, ...values, createdBy: ctx.principal.userId })
    .returning({ id: applicant.id });
  await tx.insert(applicantStage).values({ applicantId: made!.id, fromStage: null, toStage: 'applied', note: values.note, movedBy: ctx.principal.userId });
  await recordChange(tx, ctx, {
    action: 'applicant.created',
    objectType: APPLICANT_OBJECT,
    objectId: allocated.documentNo,
    branchCode: row.branchCode,
    after: { vacancyNo, fullNameEn: values.fullNameEn, source: values.source },
  });
  return { id: made!.id, applicantNo: allocated.documentNo };
}

/** Corrects how to reach them — not a move. */
export async function updateApplicant(tx: Tx, ctx: ActorContext, applicantNo: string, input: ApplicantInput): Promise<void> {
  const row = await loadApplicant(tx, applicantNo, { lock: true });
  await permit(ctx, 'edit_draft', row.branchCode, applicantNo);
  if (CLOSED_STAGES.includes(row.stage as ApplicantStage)) throw new TalentError(`${applicantNo} is ${row.stage}; the application is closed.`);
  const values = {
    fullNameEn: requireText(input.fullNameEn, 'full_name_en'),
    fullNameAr: optionalText(input.fullNameAr, 200),
    phone: optionalText(input.phone, 64),
    email: emailOf(input.email),
    source: optionalText(input.source, 200),
  };
  await tx
    .update(applicant)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(applicant.id, row.id));
  await recordChange(tx, ctx, {
    action: 'applicant.updated',
    objectType: APPLICANT_OBJECT,
    objectId: applicantNo,
    branchCode: row.branchCode,
    before: { fullNameEn: row.fullNameEn, fullNameAr: row.fullNameAr, phone: row.phone, email: row.email, source: row.source },
    after: values,
  });
}

/** Forward through the pipeline, or out with a note. */
export async function moveApplicant(tx: Tx, ctx: ActorContext, applicantNo: string, toStage: string, note?: string | null): Promise<void> {
  const row = await loadApplicant(tx, applicantNo, { lock: true });
  await permit(ctx, 'edit_draft', row.branchCode, applicantNo);
  const said = optionalText(note, 2000);
  const to = assertStageMove(applicantNo, row.stage, toStage, said);
  await tx.update(applicant).set({ stage: to, updatedAt: new Date() }).where(eq(applicant.id, row.id));
  await tx.insert(applicantStage).values({ applicantId: row.id, fromStage: row.stage, toStage: to, note: said, movedBy: ctx.principal.userId });
  await recordChange(tx, ctx, {
    action: 'applicant.moved',
    objectType: APPLICANT_OBJECT,
    objectId: applicantNo,
    branchCode: row.branchCode,
    before: { stage: row.stage },
    after: { stage: to },
    reason: said,
  });
  if (to === 'offer') {
    const [seat] = await tx.select({ vacancyNo: vacancy.vacancyNo }).from(vacancy).where(eq(vacancy.id, row.vacancyId)).limit(1);
    await tell(
      tx,
      await deciders(tx, row.branchCode),
      { objectType: APPLICANT_OBJECT, objectNo: applicantNo, branchCode: row.branchCode },
      'hr.applicant_offer',
      `${applicantNo}: ${row.fullNameEn} has an offer — hire when accepted`,
      `${seat?.vacancyNo ?? ''}${said ? ` · ${said}` : ''}`,
      [ctx.principal.userId],
    );
  }
}

export interface HireInput {
  readonly hireDate: string;
  readonly employmentKind?: string | null;
  readonly managerEmployeeId?: string | null;
  readonly nationalId?: string | null;
  readonly dateOfBirth?: string | null;
  readonly contractEndDate?: string | null;
}

/**
 * An offer accepted: the employee is made through `employees.create` in the
 * vacancy's branch, department and position, its first history row naming
 * the application; the applicant is hired and linked; the hire counts against
 * the headcount, and the last one fills the vacancy.
 */
export async function hire(tx: Tx, ctx: ActorContext, applicantNo: string, input: HireInput): Promise<{ employeeNo: string; employeeId: string; vacancyFilled: boolean }> {
  // The vacancy is locked before its applicant, as closing a vacancy locks them.
  const [of] = await tx.select({ vacancyNo: vacancy.vacancyNo }).from(applicant).innerJoin(vacancy, eq(vacancy.id, applicant.vacancyId)).where(eq(applicant.applicantNo, applicantNo)).limit(1);
  if (!of) throw new AdminNotFoundError('applicant', applicantNo);
  const seat = await loadVacancy(tx, of.vacancyNo, { lock: true });
  const row = await loadApplicant(tx, applicantNo, { lock: true });
  await permit(ctx, 'approve', row.branchCode, applicantNo);
  if (row.stage !== 'offer') throw new TalentError(`${applicantNo} is at ${row.stage}; a hire is an offer accepted.`);
  if (seat.status !== 'open') throw new TalentError(`${seat.vacancyNo} is ${seat.status}; a hire is made against an open vacancy.`);
  if (seat.hired >= seat.headcount) throw new TalentError(`${seat.vacancyNo} has hired all ${seat.headcount} it wanted.`);
  // One record per person (R1): a national id already on file is that person.
  const nationalId = optionalText(input.nationalId, 64);
  if (nationalId) {
    const [known] = await tx.select({ employeeNo: employee.employeeNo }).from(employee).where(eq(employee.nationalId, nationalId)).limit(1);
    if (known) throw new HrValidationError('national_id', `is already ${known.employeeNo}'s — one record per person; move them instead`);
  }
  const made = await employees.create(
    tx,
    { ...ctx, branchCode: seat.branchCode },
    {
      fullNameEn: row.fullNameEn,
      fullNameAr: row.fullNameAr,
      phone: row.phone,
      nationalId,
      dateOfBirth: (input.dateOfBirth ?? '').trim() || null,
      departmentCode: seat.departmentCode,
      positionCode: seat.positionCode,
      managerEmployeeId: (input.managerEmployeeId ?? '').trim() || null,
      hireDate: input.hireDate,
      employmentKind: (input.employmentKind ?? '').trim() || seat.employmentKind,
      contractEndDate: (input.contractEndDate ?? '').trim() || null,
    },
    `Hired from ${applicantNo} (${seat.vacancyNo})`,
  );
  const now = new Date();
  await tx.update(applicant).set({ stage: 'hired', employeeId: made.id, updatedAt: now }).where(eq(applicant.id, row.id));
  await tx.insert(applicantStage).values({ applicantId: row.id, fromStage: row.stage, toStage: 'hired', note: made.employeeNo, movedBy: ctx.principal.userId });
  await recordChange(tx, ctx, {
    action: 'applicant.hired',
    objectType: APPLICANT_OBJECT,
    objectId: applicantNo,
    branchCode: row.branchCode,
    before: { stage: row.stage },
    after: { stage: 'hired', employeeNo: made.employeeNo },
  });
  const hired = seat.hired + 1;
  const filled = hired === seat.headcount;
  await tx
    .update(vacancy)
    .set({ hired, ...(filled ? { status: 'filled' as VacancyStatus, closedBy: ctx.principal.userId, closedAt: now } : {}), updatedAt: now })
    .where(eq(vacancy.id, seat.id));
  await recordChange(tx, ctx, {
    action: filled ? 'vacancy.filled' : 'vacancy.hired',
    objectType: VACANCY_OBJECT,
    objectId: seat.vacancyNo,
    branchCode: seat.branchCode,
    before: { hired: seat.hired, status: seat.status },
    after: { hired, status: filled ? 'filled' : seat.status, employeeNo: made.employeeNo },
  });
  if (filled) await closePipeline(tx, ctx, seat, `${seat.vacancyNo} is filled`);
  // The new person's manager hears who joins them, and when.
  const managerId = (input.managerEmployeeId ?? '').trim();
  if (managerId) {
    const [boss] = await tx.select({ userId: employee.appUserId }).from(employee).where(eq(employee.id, managerId)).limit(1);
    await tell(
      tx,
      [boss?.userId ?? null],
      { objectType: APPLICANT_OBJECT, objectNo: applicantNo, branchCode: seat.branchCode },
      'hr.hired',
      `${row.fullNameEn} joins you on ${input.hireDate}`,
      `${made.employeeNo} · ${seat.positionCode}`,
      [ctx.principal.userId],
    );
  }
  return { employeeNo: made.employeeNo, employeeId: made.id, vacancyFilled: filled };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Open vacancies past their closing day — the morning sweep raises each once. */
export async function overdueAsOf(tx: Tx, asOf: string) {
  return tx
    .select({ vacancyNo: vacancy.vacancyNo, branchCode: vacancy.branchCode, positionCode: vacancy.positionCode, closesOn: vacancy.closesOn, hired: vacancy.hired, headcount: vacancy.headcount })
    .from(vacancy)
    .where(and(eq(vacancy.status, 'open'), sql`${vacancy.closesOn} < ${asOf}::date`))
    .orderBy(asc(vacancy.closesOn));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface VacancyListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: VacancyListFilter) {
  const view = filter.view && ['draft', 'open', 'filled', 'closed', 'cancelled'].includes(filter.view) ? filter.view : null;
  const where = whereOf([view ? sql`v.status = ${view}` : null, searchOf([sql`v.vacancy_no`, sql`v.position_code`, sql`p.title_en`, sql`p.title_ar`, sql`v.description`], filter.search)]);
  const from = sql`from vacancy v join position p on p.code = v.position_code ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select v.id, v.vacancy_no as "vacancyNo", v.status, v.position_code as "positionCode", p.title_en as "titleEn", p.title_ar as "titleAr",
                 v.department_code as "departmentCode", v.branch_code as "branchCode", v.headcount, v.hired, v.employment_kind as "employmentKind",
                 v.opens_on::text as "opensOn", v.closes_on::text as "closesOn",
                 (select count(*)::int from applicant a where a.vacancy_id = v.id) as applicants,
                 (select count(*)::int from applicant a where a.vacancy_id = v.id and a.stage in ('applied', 'screening', 'interview', 'offer')) as "inPipeline"
            ${from}
           order by case v.status when 'open' then 0 when 'draft' then 1 else 2 end, v.opens_on desc, v.vacancy_no desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        vacancyNo: string;
        status: VacancyStatus;
        positionCode: string;
        titleEn: string;
        titleAr: string | null;
        departmentCode: string;
        branchCode: string;
        headcount: number;
        hired: number;
        employmentKind: string;
        opensOn: string;
        closesOn: string | null;
        applicants: number;
        inPipeline: number;
      }[],
  });
}

const vacancyUser = (column: string) => sql<string | null>`(select u.display_name from app_user u where u.id = ${sql.raw(`"vacancy"."${column}"`)})`;

/** The vacancy, its position, who holds that position now, and its applicants. */
export async function vacancyByNo(tx: Tx, vacancyNo: string) {
  const [found] = await tx
    .select({
      row: vacancy,
      titleEn: position.titleEn,
      titleAr: position.titleAr,
      departmentName: sql<string>`(select d.name from department d where d.code = "vacancy"."department_code")`,
      branchName: sql<string>`(select b.name from branch b where b.code = "vacancy"."branch_code")`,
      createdByName: vacancyUser('created_by'),
      openedByName: vacancyUser('opened_by'),
      closedByName: vacancyUser('closed_by'),
      // "Vacancies against vacant positions": how many hold the seat today.
      holding: sql<number>`(select count(*)::int from employee e where e.position_code = "vacancy"."position_code" and e.status = 'active')`,
    })
    .from(vacancy)
    .innerJoin(position, eq(position.code, vacancy.positionCode))
    .where(eq(vacancy.vacancyNo, vacancyNo))
    .limit(1);
  if (!found) return null;
  const applicants = await tx
    .select({
      id: applicant.id,
      applicantNo: applicant.applicantNo,
      fullNameEn: applicant.fullNameEn,
      fullNameAr: applicant.fullNameAr,
      phone: applicant.phone,
      email: applicant.email,
      source: applicant.source,
      stage: applicant.stage,
      createdAt: applicant.createdAt,
      employeeNo: sql<string | null>`(select e.employee_no from employee e where e.id = "applicant"."employee_id")`,
    })
    .from(applicant)
    .where(eq(applicant.vacancyId, found.row.id))
    .orderBy(sql`case "applicant"."stage" when 'offer' then 0 when 'interview' then 1 when 'screening' then 2 when 'applied' then 3 when 'hired' then 4 else 5 end`, asc(applicant.applicantNo));
  return { ...found, applicants };
}

/** The applicant, their vacancy and every move they made. */
export async function applicantByNo(tx: Tx, applicantNo: string) {
  const [found] = await tx
    .select({
      row: applicant,
      vacancyNo: vacancy.vacancyNo,
      vacancyStatus: vacancy.status,
      positionCode: vacancy.positionCode,
      departmentCode: vacancy.departmentCode,
      employmentKind: vacancy.employmentKind,
      titleEn: sql<string>`(select p.title_en from position p where p.code = "vacancy"."position_code")`,
      titleAr: sql<string | null>`(select p.title_ar from position p where p.code = "vacancy"."position_code")`,
      createdByName: sql<string | null>`(select u.display_name from app_user u where u.id = "applicant"."created_by")`,
      employeeNo: sql<string | null>`(select e.employee_no from employee e where e.id = "applicant"."employee_id")`,
    })
    .from(applicant)
    .innerJoin(vacancy, eq(vacancy.id, applicant.vacancyId))
    .where(eq(applicant.applicantNo, applicantNo))
    .limit(1);
  if (!found) return null;
  const stages = await tx
    .select({
      id: applicantStage.id,
      fromStage: applicantStage.fromStage,
      toStage: applicantStage.toStage,
      note: applicantStage.note,
      movedAt: applicantStage.movedAt,
      movedByName: sql<string | null>`(select u.display_name from app_user u where u.id = "applicant_stage"."moved_by")`,
    })
    .from(applicantStage)
    .where(eq(applicantStage.applicantId, found.row.id))
    .orderBy(asc(applicantStage.movedAt));
  return { ...found, stages, next: nextStages(found.row.stage) };
}

/** Positions a vacancy may be for: the active ones. */
export async function positionsOpen(tx: Tx) {
  return tx
    .select({ code: position.code, titleEn: position.titleEn, titleAr: position.titleAr, departmentCode: position.departmentCode })
    .from(position)
    .where(eq(position.active, true))
    .orderBy(asc(position.code));
}

/** The application an employee was hired from, if any — for their record. */
export async function hiredFrom(tx: Tx, employeeId: string) {
  const [row] = await tx
    .select({ applicantNo: applicant.applicantNo, vacancyNo: vacancy.vacancyNo })
    .from(applicant)
    .innerJoin(vacancy, eq(vacancy.id, applicant.vacancyId))
    .where(eq(applicant.employeeId, employeeId))
    .limit(1);
  return row ?? null;
}

export interface HireWaiting {
  readonly applicantNo: string;
  readonly fullNameEn: string;
  readonly vacancyNo: string;
}

/** Offers waiting for a hire — for whoever may hire. */
export async function waitingFor(tx: Tx, ctx: { principal: ActorContext['principal'] }): Promise<HireWaiting[]> {
  if (!can(ctx.principal, 'approve', PERMISSION_OBJECT)) return [];
  return tx
    .select({ applicantNo: applicant.applicantNo, fullNameEn: applicant.fullNameEn, vacancyNo: vacancy.vacancyNo })
    .from(applicant)
    .innerJoin(vacancy, eq(vacancy.id, applicant.vacancyId))
    .where(and(eq(applicant.stage, 'offer'), eq(vacancy.status, 'open')))
    .orderBy(desc(applicant.updatedAt))
    .limit(20);
}

export const STAGES: readonly ApplicantStage[] = [...PIPELINE, ...CLOSED_STAGES];
