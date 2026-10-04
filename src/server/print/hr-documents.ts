/**
 * HR's records as print models (shared, 2026-10-04) — the fields each page
 * shows, its lines, its figures at the foot, so every record wears the
 * printer beside its paperclip, its notes and its clock. One model each for
 * the PDF, the workbook and the Word file, read through the readers the
 * pages read: row security decides who sees which rows (HR by its grant,
 * the person and their manager through the link), and `access.ts` decides
 * who may take which copy.
 *
 *   `employeeAdvance` — an advance or loan (REQ-HR-001 §10): the schedule
 *   month by month; what came back as a second table.
 *   `leaveRequest` — a leave request (§8): the days the span covers.
 *   `employeeDocument` — a person's paper (§13): the renewals of its type.
 *   `performanceReview` — a review (§12): its goals, weights and ratings.
 *   `vacancy` — a vacancy (§11): its pipeline.
 *   `applicant` — an application (§11): the moves it made.
 *   `employeeRequest` — a claim, a trip, a letter or another request (§14):
 *   the expenses, the claims settling the trip, or the text; an issued
 *   letter prints as the letter itself (`hr-reports.letter`).
 *
 * "Posted" for the watermark means what each record's page means by final:
 * an advance paid out or settled, a leave approved, a document valid, a
 * review signed off, a vacancy open, filled or closed, an application
 * decided.
 */
import { formatBusinessDate, formatMoney, formatTimestamp } from '@/i18n/config';
import { businessDateOf } from '../domain/business-date';
import { showDays, weekdayOf } from '../domain/hr-time';
import * as advances from '../services/employee-advances';
import * as documents from '../services/employee-documents';
import * as requests from '../services/employee-requests';
import * as leave from '../services/leave';
import * as performance from '../services/performance';
import * as recruitment from '../services/recruitment';
import type { BuildContext, Built } from './documents';
import { letter } from './hr-reports';
import type { Column, Fact, Row } from './model';

type Locale = BuildContext['locale'];

/** `name · when`, as the HR pages print who did what. */
const signed = (name: string | null, at: Date | string | null, locale: Locale) =>
  at ? `${name ?? '—'} · ${formatTimestamp(new Date(at).toISOString(), locale)}` : null;

const personName = (person: { fullNameEn: string; fullNameAr: string | null }, locale: Locale) =>
  locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn;

/** An advance or loan — REQ-HR-001 §10. */
export async function employeeAdvance(ctx: BuildContext, advanceNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await advances.byNo(tx, advanceNo);
  if (!detail) return null;
  const { row, person } = detail;
  const x = (key: string) => m.admin(`advances.${key}`);
  const money = (value: string) => formatMoney(value, 'IQD', locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const statusLabel = row.status === 'endorsed' || row.status === 'paid' ? x(`status_${row.status}`) : m.status(row.status === 'refused' ? 'rejected' : row.status);
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.advanceNo, ltr: true },
    { label: m.column('status'), value: statusLabel },
    { label: x('employee'), value: `${person.employeeNo} · ${personName(person, locale)}` },
    { label: x('kind'), value: x(`kind_${row.kind}`) },
    { label: x('amount'), value: money(row.amountIqd), ltr: true },
    { label: x('instalments'), value: String(row.instalments), ltr: true },
    { label: x('first_month'), value: row.firstRecoveryMonth.slice(0, 7), ltr: true },
    { label: x('recovered'), value: money(row.recoveredIqd), ltr: true },
    { label: x('owed'), value: money(detail.owedIqd), ltr: true },
    { label: x('requested_by'), value: signed(detail.requestedByName, row.createdAt, locale) ?? '—' },
  ];
  const endorsed = signed(detail.endorsedByName, row.endorsedAt, locale);
  const approved = signed(detail.approvedByName, row.approvedAt, locale);
  const refused = signed(detail.refusedByName, row.refusedAt, locale);
  const paid = signed(detail.paidByName, row.paidAt, locale);
  const cancelled = signed(detail.cancelledByName, row.cancelledAt, locale);
  if (endorsed) fields.push({ label: x('endorsed_by'), value: endorsed });
  if (approved) fields.push({ label: x('approved_by'), value: approved });
  if (refused) fields.push({ label: x('refused_by'), value: refused });
  if (paid) {
    fields.push({ label: x('paid_by'), value: paid });
    fields.push({ label: x('paid_on'), value: `${day(row.paidOn)} · ${detail.accountCode ?? '—'}${row.paymentReference ? ` · ${row.paymentReference}` : ''}`, ltr: true });
    fields.push({ label: x('journal'), value: detail.entryNo ?? '—', ltr: true });
  }
  if (cancelled) {
    fields.push({ label: x('cancelled_by'), value: cancelled });
    fields.push({ label: x('cancel_reason'), value: row.cancelReason ?? '—' });
  }
  if (row.decisionNote) fields.push({ label: x('decision_note'), value: row.decisionNote });
  fields.push({ label: x('reason'), value: row.reason });

  const schedule: Row[] = detail.months.map((month) => ({
    cells: { month: month.month.slice(0, 7), instalment: month.instalmentIqd, due_by: month.dueByIqd, recovered: month.recoveredIqd },
  }));
  const recoveries: Row[] = detail.recoveries.map((r) => ({
    cells: {
      month: r.month.slice(0, 7),
      source: x(`source_${r.source}`),
      reference: r.reference ?? null,
      amount: r.amountIqd,
      journal: r.entryNo ?? null,
      recorded_at: formatTimestamp(new Date(r.recordedAt).toISOString(), locale),
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.employee_advance'),
      number: row.advanceNo,
      status: statusLabel,
      posted: row.status === 'paid' || row.status === 'settled',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: x('schedule_title'),
          columns: [
            { key: 'month', label: x('month'), kind: 'code' },
            { key: 'instalment', label: x('instalment'), kind: 'money' },
            { key: 'due_by', label: x('due_by'), kind: 'money' },
            { key: 'recovered', label: x('recovered'), kind: 'money' },
          ],
          rows: schedule,
          empty: '—',
          totals: { label: x('amount'), cells: { instalment: row.amountIqd, recovered: row.recoveredIqd }, sum: ['instalment', 'recovered'] },
        },
        {
          title: x('recoveries_title'),
          columns: [
            { key: 'month', label: x('month'), kind: 'code' },
            { key: 'source', label: x('source'), kind: 'text' },
            { key: 'reference', label: x('reference'), kind: 'code' },
            { key: 'amount', label: x('amount'), kind: 'money' },
            { key: 'journal', label: x('journal'), kind: 'code' },
            { key: 'recorded_at', label: x('recorded_at'), kind: 'code', weight: 1.3 },
          ],
          rows: recoveries,
          empty: x('recoveries_none'),
        },
      ],
      summary: [
        { label: x('amount'), value: money(row.amountIqd), ltr: true },
        { label: x('recovered'), value: money(row.recoveredIqd), ltr: true },
        { label: x('owed'), value: money(detail.owedIqd), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: row.advanceNo,
      sheetName: row.advanceNo,
    },
    branchCode: row.branchCode,
    objectId: row.advanceNo,
  };
}

/** A leave request — REQ-HR-001 §8. */
export async function leaveRequest(ctx: BuildContext, requestNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await leave.byNo(tx, requestNo);
  if (!detail) return null;
  const { row, person, count, balance } = detail;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`leave.${key}`, values);
  const day = (value: string) => formatBusinessDate(value, locale);
  const typeLabel = locale === 'ar' && row.typeNameAr ? row.typeNameAr : row.typeName;
  const year = row.fromDate.slice(0, 4);
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.requestNo, ltr: true },
    { label: m.column('status'), value: x(`status_${row.status}`) },
    { label: x('employee'), value: `${person.employeeNo} · ${person.fullNameEn}` },
    { label: x('manager'), value: person.managerName ?? '—' },
    { label: x('leave_type'), value: typeLabel },
    { label: x('from_date'), value: `${day(row.fromDate)}${row.halfDayStart ? ` · ${x('half')}` : ''}`, ltr: true },
    { label: x('to_date'), value: `${day(row.toDate)}${row.halfDayEnd ? ` · ${x('half')}` : ''}`, ltr: true },
    { label: x('days'), value: showDays(count.total), ltr: true },
    {
      label: x('balance_year', { year }),
      value: balance.limited ? x('balance_value', { balance: showDays(balance.balance), pending: showDays(balance.pending) }) : x('not_limited'),
      ltr: balance.limited,
    },
    { label: x('requested_by'), value: signed(row.requestedByName, row.createdAt, locale) ?? '—' },
    { label: x('submitted_at'), value: row.submittedAt ? formatTimestamp(new Date(row.submittedAt).toISOString(), locale) : '—', ltr: true },
  ];
  const decided = signed(row.decidedByName, row.decidedAt, locale);
  const cancelled = signed(row.cancelledByName, row.cancelledAt, locale);
  if (decided) fields.push({ label: x('decided_by'), value: decided });
  if (row.decisionNote) fields.push({ label: x('decision_note'), value: row.decisionNote });
  if (cancelled) fields.push({ label: x('cancelled_by'), value: cancelled });
  if (row.cancelReason) fields.push({ label: x('cancel_reason'), value: row.cancelReason });
  fields.push({ label: x('reason'), value: row.reason ?? '—' });

  const rows: Row[] = count.days.map((entry) => ({
    cells: { day: entry.day, weekday: x(`weekday_${weekdayOf(entry.day)}`), counted_as: x(`kind_${entry.kind}`), days: showDays(entry.portion) },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.leave_request'),
      number: row.requestNo,
      status: x(`status_${row.status}`),
      posted: row.status === 'approved',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: x('days_title'),
          columns: [
            { key: 'day', label: x('day'), kind: 'date' },
            { key: 'weekday', label: x('weekday'), kind: 'text' },
            { key: 'counted_as', label: x('counted_as'), kind: 'text' },
            { key: 'days', label: x('days'), kind: 'code' },
          ],
          rows,
          empty: '—',
        },
      ],
      summary: [{ label: x('days'), value: showDays(count.total), ltr: true }],
      signatures: true,
      currency: 'IQD',
      fileName: row.requestNo,
      sheetName: row.requestNo,
    },
    branchCode: row.branchCode,
    objectId: row.requestNo,
  };
}

/** A person's paper and its renewals — REQ-HR-001 §13. */
export async function employeeDocument(ctx: BuildContext, documentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await documents.byNo(tx, documentNo);
  if (!detail) return null;
  const { row, person } = detail;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`hr_documents.${key}`, values);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const statusText = detail.expiry ? x(`expiry_${detail.expiry}`) : x(`status_${row.status}`);
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.documentNo, ltr: true },
    { label: m.column('status'), value: statusText },
    { label: x('employee'), value: `${person.employeeNo} · ${personName(person, locale)}` },
    { label: x('doc_type'), value: x(`type_${row.docType}`) },
    { label: x('doc_title'), value: row.title },
    { label: x('reference_no'), value: row.referenceNo ?? '—', ltr: true },
    { label: x('issued_on'), value: day(row.issuedOn), ltr: true },
    { label: x('expires_on'), value: day(row.expiresOn), ltr: true },
  ];
  if (row.status === 'valid' && detail.daysLeft !== null) fields.push({ label: x('days_left'), value: String(detail.daysLeft), ltr: true });
  if (detail.replacesNo) fields.push({ label: x('replaces'), value: detail.replacesNo, ltr: true });
  if (detail.replacedByNo) fields.push({ label: x('replaced_by'), value: detail.replacedByNo, ltr: true });
  fields.push({ label: x('created_by'), value: signed(detail.createdByName, row.createdAt, locale) ?? '—' });
  const withdrawn = signed(detail.withdrawnByName, row.withdrawnAt, locale);
  if (withdrawn) {
    fields.push({ label: x('withdrawn_by'), value: withdrawn });
    fields.push({ label: x('withdraw_reason'), value: row.withdrawReason ?? '—' });
  }
  if (row.note) fields.push({ label: x('note'), value: row.note });

  const rows: Row[] = detail.chain.map((c) => ({
    cells: { reference: c.documentNo, reference_no: c.referenceNo ?? null, issued_on: c.issuedOn, expires_on: c.expiresOn, status: x(`status_${c.status}`) },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.employee_document'),
      number: row.documentNo,
      status: statusText,
      posted: row.status === 'valid',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: x('chain_title', { type: x(`type_${row.docType}`) }),
          columns: [
            { key: 'reference', label: m.column('reference'), kind: 'code' },
            { key: 'reference_no', label: x('reference_no'), kind: 'code' },
            { key: 'issued_on', label: x('issued_on'), kind: 'date' },
            { key: 'expires_on', label: x('expires_on'), kind: 'date' },
            { key: 'status', label: m.column('status'), kind: 'text' },
          ],
          rows,
          empty: '—',
        },
      ],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: row.documentNo,
      sheetName: row.documentNo,
    },
    branchCode: row.branchCode,
    objectId: row.documentNo,
  };
}

/** A performance review — REQ-HR-001 §12. */
export async function performanceReview(ctx: BuildContext, reviewNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await performance.byNo(tx, reviewNo);
  if (!detail) return null;
  const { row, person, goals } = detail;
  const x = (key: string) => m.admin(`performance.${key}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const statusLabel = row.status === 'rated' || row.status === 'signed_off' ? x(`status_${row.status}`) : m.status(row.status);
  const cycleName = locale === 'ar' && detail.cycleNameAr ? detail.cycleNameAr : detail.cycleName;
  const ratingLabel = (value: number | null) => (value ? `${value} · ${x(`rating_${value}`)}` : '—');
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.reviewNo, ltr: true },
    { label: m.column('status'), value: statusLabel },
    { label: x('employee'), value: `${person.employeeNo} · ${personName(person, locale)}` },
    { label: x('cycle'), value: `${row.cycleCode} · ${cycleName}` },
    { label: x('period'), value: `${day(detail.periodFrom)} – ${day(detail.periodTo)}`, ltr: true },
    { label: x('reviewer'), value: detail.reviewerName ?? '—' },
    { label: x('overall'), value: row.overallRating ?? '—', ltr: true },
    { label: x('created_by'), value: signed(detail.createdByName, row.createdAt, locale) ?? '—' },
  ];
  const rated = signed(detail.reviewerName, row.ratedAt, locale);
  const signedOff = signed(detail.signedOffByName, row.signedOffAt, locale);
  const cancelled = signed(detail.cancelledByName, row.cancelledAt, locale);
  if (rated) fields.push({ label: x('rated_at'), value: rated });
  if (signedOff) fields.push({ label: x('signed_off_by'), value: signedOff });
  if (row.signOffNote) fields.push({ label: x('sign_off_note'), value: row.signOffNote });
  if (cancelled) {
    fields.push({ label: x('cancelled_by'), value: cancelled });
    fields.push({ label: x('cancel_reason'), value: row.cancelReason ?? '—' });
  }
  if (row.reviewerComment) fields.push({ label: x('reviewer_comment'), value: row.reviewerComment });
  if (row.employeeComment) {
    fields.push({
      label: x('employee_comment'),
      value: `${row.employeeComment}${row.employeeCommentedAt ? ` — ${formatTimestamp(new Date(row.employeeCommentedAt).toISOString(), locale)}` : ''}`,
    });
  }

  const rows: Row[] = goals.map((goal) => ({
    cells: {
      line: String(goal.lineNo),
      goal: goal.title,
      target: goal.target ?? null,
      weight: `${goal.weight}%`,
      rating: ratingLabel(goal.rating),
      comment: goal.comment ?? null,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.performance_review'),
      number: row.reviewNo,
      status: statusLabel,
      posted: row.status === 'signed_off',
      orientation: 'landscape',
      fields,
      filters: [],
      tables: [
        {
          title: x('goals_title'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.4 },
            { key: 'goal', label: x('goal'), kind: 'text', weight: 2 },
            { key: 'target', label: x('target'), kind: 'text', weight: 1.5 },
            { key: 'weight', label: x('weight'), kind: 'code', weight: 0.6 },
            { key: 'rating', label: x('rating'), kind: 'text' },
            { key: 'comment', label: x('goal_comment'), kind: 'text', weight: 1.5 },
          ],
          rows,
          empty: x('goals_none'),
        },
      ],
      summary: [
        { label: x('weight'), value: `${detail.weight}%`, ltr: true },
        { label: x('overall'), value: row.overallRating ?? '—', ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: row.reviewNo,
      sheetName: row.reviewNo,
    },
    branchCode: row.branchCode,
    objectId: row.reviewNo,
  };
}

/** A vacancy and its pipeline — REQ-HR-001 §11. */
export async function vacancy(ctx: BuildContext, vacancyNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await recruitment.vacancyByNo(tx, vacancyNo);
  if (!detail) return null;
  const { row } = detail;
  const x = (key: string) => m.admin(`recruitment.${key}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const statusLabel = row.status === 'open' || row.status === 'filled' ? x(`status_${row.status}`) : m.status(row.status);
  const title = locale === 'ar' && detail.titleAr ? detail.titleAr : detail.titleEn;
  const inPipeline = detail.applicants.filter((a) => ['applied', 'screening', 'interview', 'offer'].includes(a.stage)).length;
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.vacancyNo, ltr: true },
    { label: m.column('status'), value: statusLabel },
    { label: m.column('branch'), value: detail.branchName },
    { label: x('position'), value: `${row.positionCode} · ${title}` },
    { label: x('department'), value: `${row.departmentCode} · ${detail.departmentName}` },
    { label: x('holding'), value: String(detail.holding), ltr: true },
    { label: x('headcount'), value: String(row.headcount), ltr: true },
    { label: x('hired'), value: String(row.hired), ltr: true },
    { label: x('employment_kind'), value: x(`kind_${row.employmentKind}`) },
    { label: x('opens_on'), value: day(row.opensOn), ltr: true },
    { label: x('closes_on'), value: day(row.closesOn), ltr: true },
    { label: x('created_by'), value: signed(detail.createdByName, row.createdAt, locale) ?? '—' },
  ];
  const opened = signed(detail.openedByName, row.openedAt, locale);
  const closed = signed(detail.closedByName, row.closedAt, locale);
  if (opened) fields.push({ label: x('opened_by'), value: opened });
  if (closed) fields.push({ label: x('closed_by'), value: closed });
  if (row.closeReason) fields.push({ label: x('close_reason'), value: row.closeReason });
  fields.push({ label: x('description'), value: row.description });

  const rows: Row[] = detail.applicants.map((a) => ({
    cells: {
      reference: a.applicantNo,
      applicant: personName(a, locale),
      phone: a.phone ?? null,
      email: a.email ?? null,
      source: a.source ?? null,
      applied_at: businessDateOf(new Date(a.createdAt)),
      stage: x(`stage_${a.stage}`),
      employee: a.employeeNo ?? null,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.vacancy'),
      number: row.vacancyNo,
      status: statusLabel,
      posted: row.status !== 'draft' && row.status !== 'cancelled',
      orientation: 'landscape',
      fields,
      filters: [],
      tables: [
        {
          title: x('applicants_title'),
          columns: [
            { key: 'reference', label: m.column('reference'), kind: 'code' },
            { key: 'applicant', label: x('applicant'), kind: 'text', weight: 1.6 },
            { key: 'phone', label: x('phone'), kind: 'code' },
            { key: 'email', label: x('email'), kind: 'code', weight: 1.4 },
            { key: 'source', label: x('source'), kind: 'text' },
            { key: 'applied_at', label: x('applied_at'), kind: 'date' },
            { key: 'stage', label: x('stage'), kind: 'text' },
            { key: 'employee', label: x('employee'), kind: 'code' },
          ],
          rows,
          empty: row.status === 'open' ? x('applicants_none_open') : x('applicants_none'),
        },
      ],
      summary: [
        { label: x('headcount'), value: String(row.headcount), ltr: true },
        { label: x('hired'), value: String(row.hired), ltr: true },
        { label: x('in_pipeline'), value: String(inPipeline), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: row.vacancyNo,
      sheetName: row.vacancyNo,
    },
    branchCode: row.branchCode,
    objectId: row.vacancyNo,
  };
}

/** An application and the moves it made — REQ-HR-001 §11. */
export async function applicant(ctx: BuildContext, applicantNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await recruitment.applicantByNo(tx, applicantNo);
  if (!detail) return null;
  const { row } = detail;
  const x = (key: string) => m.admin(`recruitment.${key}`);
  const title = locale === 'ar' && detail.titleAr ? detail.titleAr : detail.titleEn;
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.applicantNo, ltr: true },
    { label: x('stage'), value: x(`stage_${row.stage}`) },
    { label: x('vacancy'), value: detail.vacancyNo, ltr: true },
    { label: x('position'), value: `${detail.positionCode} · ${title}` },
    { label: x('full_name_en'), value: row.fullNameEn },
    { label: x('full_name_ar'), value: row.fullNameAr ?? '—' },
    { label: x('phone'), value: row.phone ?? '—', ltr: true },
    { label: x('email'), value: row.email ?? '—', ltr: true },
    { label: x('source'), value: row.source ?? '—' },
    { label: x('created_by'), value: signed(detail.createdByName, row.createdAt, locale) ?? '—' },
  ];
  if (detail.employeeNo) fields.push({ label: x('employee'), value: detail.employeeNo, ltr: true });
  if (row.note) fields.push({ label: x('note'), value: row.note });

  const rows: Row[] = detail.stages.map((move) => ({
    cells: {
      moved_at: formatTimestamp(new Date(move.movedAt).toISOString(), locale),
      from_stage: move.fromStage ? x(`stage_${move.fromStage}`) : null,
      to_stage: x(`stage_${move.toStage}`),
      moved_by: move.movedByName ?? null,
      note: move.note ?? null,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.applicant'),
      number: row.applicantNo,
      status: x(`stage_${row.stage}`),
      posted: ['hired', 'rejected', 'withdrawn'].includes(row.stage),
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: x('stages_title'),
          columns: [
            { key: 'moved_at', label: x('moved_at'), kind: 'code', weight: 1.3 },
            { key: 'from_stage', label: x('from_stage'), kind: 'text' },
            { key: 'to_stage', label: x('to_stage'), kind: 'text' },
            { key: 'moved_by', label: x('moved_by'), kind: 'text' },
            { key: 'note', label: x('note'), kind: 'text', weight: 2 },
          ],
          rows,
          empty: '—',
        },
      ],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: row.applicantNo,
      sheetName: row.applicantNo,
    },
    branchCode: row.branchCode,
    objectId: row.applicantNo,
  };
}

/** A claim, a trip, a letter or another request — REQ-HR-001 §14. An issued letter is the letter. */
export async function employeeRequest(ctx: BuildContext, requestNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await requests.byNo(tx, requestNo);
  if (!detail) return null;
  const { row, person } = detail;
  if (row.kind === 'letter' && row.status === 'issued' && row.issuedText) return letter(ctx, requestNo);
  const kind = row.kind;
  const x = (key: string) => m.admin(`requests.${key}`);
  const money = (value: string | null) => (value === null ? '—' : formatMoney(value, 'IQD', locale));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const statusLabel = (value: string) => (value === 'paid' || value === 'issued' ? x(`status_${value}`) : m.status(value === 'refused' ? 'rejected' : value));
  const fields: Fact[] = [
    { label: m.column('reference'), value: row.requestNo, ltr: true },
    { label: m.column('status'), value: statusLabel(row.status) },
    { label: x('kind'), value: x(`kind_${kind}`) },
    { label: x('employee'), value: `${person.employeeNo} · ${personName(person, locale)}` },
    { label: x('subject'), value: row.subject },
  ];
  if (kind === 'expense_claim') {
    fields.push({ label: x('total'), value: money(row.amountIqd), ltr: true });
    fields.push({ label: x('trip'), value: detail.tripNo ?? '—', ltr: true });
  }
  if (kind === 'travel') {
    fields.push({ label: x('destination'), value: row.destination ?? '—' });
    fields.push({ label: x('travel_dates'), value: `${day(row.travelFrom)} – ${day(row.travelTo)}`, ltr: true });
    fields.push({ label: x('estimated'), value: money(row.estimatedIqd), ltr: true });
    fields.push({ label: x('advance'), value: detail.advanceNo ?? '—', ltr: true });
  }
  if (kind === 'letter') {
    fields.push({ label: x('letter_type'), value: row.letterType ? x(`letter_type_${row.letterType}`) : '—' });
    fields.push({ label: x('addressed_to'), value: row.addressedTo ?? '—' });
  }
  fields.push({ label: x('requested_by'), value: signed(detail.requestedByName, row.createdAt, locale) ?? '—' });
  const decided = signed(detail.decidedByName, row.decidedAt, locale);
  const paid = signed(detail.paidByName, row.paidAt, locale);
  const issued = signed(detail.issuedByName, row.issuedAt, locale);
  const cancelled = signed(detail.cancelledByName, row.cancelledAt, locale);
  if (decided) fields.push({ label: row.status === 'refused' ? x('refused_by') : x('approved_by'), value: decided });
  if (paid) {
    fields.push({ label: x('paid_by'), value: paid });
    fields.push({ label: x('paid_on'), value: `${day(row.paidOn)} · ${detail.accountCode ?? '—'}${row.paymentReference ? ` · ${row.paymentReference}` : ''}`, ltr: true });
    fields.push({ label: x('advance_offset'), value: money(row.advanceOffsetIqd), ltr: true });
    fields.push({ label: x('journal'), value: detail.entryNo ?? '—', ltr: true });
  }
  if (issued) fields.push({ label: x('issued_by'), value: issued });
  if (cancelled) {
    fields.push({ label: x('cancelled_by'), value: cancelled });
    fields.push({ label: x('cancel_reason'), value: row.cancelReason ?? '—' });
  }
  if (row.decisionNote) fields.push({ label: x('decision_note'), value: row.decisionNote });
  if (row.details) fields.push({ label: x('details'), value: row.details });

  let columns: Column[];
  let rows: Row[];
  let title: string;
  let empty: string;
  if (kind === 'expense_claim') {
    title = x('lines_title');
    empty = x('lines_none');
    columns = [
      { key: 'line', label: '#', kind: 'code', weight: 0.4 },
      { key: 'spent_on', label: x('spent_on'), kind: 'date' },
      { key: 'category', label: x('category'), kind: 'text' },
      { key: 'description', label: x('line_description'), kind: 'text', weight: 2 },
      { key: 'amount', label: m.column('amount'), kind: 'money' },
    ];
    rows = detail.lines.map((l) => ({ cells: { line: String(l.lineNo), spent_on: l.spentOn, category: l.categoryName, description: l.description, amount: l.amountIqd } }));
  } else if (kind === 'travel') {
    title = x('claims_title');
    empty = x('claims_none');
    columns = [
      { key: 'reference', label: m.column('reference'), kind: 'code' },
      { key: 'amount', label: m.column('amount'), kind: 'money' },
      { key: 'status', label: m.column('status'), kind: 'text' },
    ];
    rows = detail.claims.map((c) => ({ cells: { reference: c.requestNo, amount: c.amountIqd, status: statusLabel(c.status) } }));
  } else {
    title = kind === 'letter' ? x('letter_title') : x('details');
    empty = '—';
    columns = [{ key: 'text', label: title, kind: 'text' }];
    const text = kind === 'letter' ? (row.issuedText ?? x('letter_not_issued')) : (row.details ?? '—');
    rows = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ cells: { text: p } }));
  }
  const total = kind === 'expense_claim' && row.amountIqd ? { label: x('total'), cells: { amount: row.amountIqd }, sum: ['amount'] } : undefined;
  return {
    model: {
      kind: 'document',
      title: m.print('titles.employee_request'),
      number: row.requestNo,
      status: statusLabel(row.status),
      posted: row.status === 'approved' || row.status === 'paid' || row.status === 'issued',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [total ? { title, columns, rows, empty, totals: total } : { title, columns, rows, empty }],
      summary: kind === 'expense_claim' ? [{ label: x('total'), value: money(row.amountIqd), ltr: true }] : [],
      signatures: true,
      currency: 'IQD',
      fileName: row.requestNo,
      sheetName: row.requestNo,
    },
    branchCode: row.branchCode,
    objectId: row.requestNo,
  };
}
