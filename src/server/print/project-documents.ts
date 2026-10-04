/**
 * The Project System's documents as print models (2026-10-04) — the fields
 * each page shows, its lines, its figures at the foot. One model each for
 * the PDF, the workbook and the Word file, read through the reader's row
 * security and the project's own `view` grant. A draft carries the DRAFT
 * watermark.
 *
 *   `projectCertificate` — the progress certificate, the client's invoice for
 *   work done (REQ-PM-001 §11, D-PM-11): the retention and advance movements
 *   it made as its lines; gross, retention, advance recovered and net.
 *   `projectBudget` — a budget document (§7): its lines by element and cost
 *   code; posted when approved.
 *   `changeOrder` — a change order (§7, R2): the budget it moves as its
 *   lines; the two approvals; posted when approved.
 *   `materialIssue` — a material issue or return (§9): its items, quantities
 *   and the cost each line became; posted when posted.
 */
import { formatBusinessDate, formatMoney } from '@/i18n/config';
import { businessDateOf } from '../domain/business-date';
import * as billing from '../services/project-billing';
import * as budget from '../services/project-budget';
import * as execution from '../services/project-execution';
import type { BuildContext, Built } from './documents';
import type { Fact, Row } from './model';

export async function projectCertificate(ctx: BuildContext, certificateNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let view: Awaited<ReturnType<typeof billing.certificate>>;
  try {
    view = await billing.certificate(tx, certificateNo);
  } catch {
    return null;
  }
  const cert = view.certificate;
  const x = (key: string) => m.admin(`projects.${key}`);
  const money = (value: string) => formatMoney(value, 'IQD', locale);
  const rows: Row[] = view.movements.map((movement) => ({
    cells: {
      kind: x(`balance_${movement.kind}`),
      date: movement.movedOn,
      description: movement.description,
      amount: movement.amountIqd,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_certificate'),
      number: cert.certificateNo,
      status: m.status(cert.status),
      posted: cert.status === 'posted',
      orientation: 'portrait',
      fields: [
        { label: x('certificate'), value: cert.certificateNo, ltr: true },
        { label: m.column('status'), value: m.status(cert.status) },
        { label: x('certificate_basis'), value: x(`basis_${cert.basis}`) },
        { label: x('project'), value: `${view.project.code} · ${view.project.name}` },
        {
          label: x('customer'),
          value: view.project.customerCode ? `${view.project.customerCode} · ${view.project.customerName ?? ''}` : '—',
        },
        { label: x('certified_on'), value: formatBusinessDate(cert.certifiedOn, locale), ltr: true },
        { label: x('percent_complete'), value: `${Number(cert.percentComplete)} %`, ltr: true },
        ...(view.planLine ? [{ label: x('billing_line'), value: `${view.planLine.lineNo} · ${view.planLine.description}` }] : []),
        { label: x('journal'), value: view.entryNo ?? '—', ltr: true },
        { label: x('raised_by'), value: view.people.createdBy ?? '—' },
        ...(cert.approvedAt ? [{ label: x('approved_by'), value: view.people.approvedBy ?? '—' }] : []),
      ],
      filters: [],
      tables: [
        {
          title: x('balance_movements'),
          columns: [
            { key: 'kind', label: x('balance_kind'), kind: 'text' },
            { key: 'date', label: m.column('date'), kind: 'date' },
            { key: 'description', label: m.column('description'), kind: 'text', weight: 2 },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
          ],
          rows,
          empty: x('no_balance_movements'),
        },
      ],
      summary: [
        { label: x('gross'), value: money(cert.grossIqd), ltr: true },
        { label: x('retention'), value: money(cert.retentionIqd), ltr: true },
        { label: x('advance_recovered'), value: money(cert.advanceRecoveredIqd), ltr: true },
        { label: x('net'), value: money(cert.netIqd), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: cert.certificateNo,
      sheetName: cert.certificateNo,
    },
    branchCode: cert.branchCode,
    objectId: cert.certificateNo,
  };
}

/** The reader as the project services take them: the export's principal in the export's branch. */
const actorOf = (ctx: BuildContext) => ({ principal: ctx.principal, branchCode: ctx.branchCode });

/** A person and when, as the pages print "Approved by": `name · YYYY-MM-DD`. */
const signed = (name: string | null, at: Date | null, locale: BuildContext['locale']) =>
  at ? `${name ?? '—'} · ${formatBusinessDate(businessDateOf(at), locale)}` : null;

/** A budget document — REQ-PM-001 §7: its lines by element and cost code. */
export async function projectBudget(ctx: BuildContext, documentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let view: Awaited<ReturnType<typeof budget.budgetDocument>>;
  try {
    view = await budget.budgetDocument(tx, actorOf(ctx), documentNo);
  } catch {
    return null;
  }
  const doc = view.document;
  const x = (key: string) => m.admin(`projects.${key}`);
  const money = (value: string) => formatMoney(value, 'IQD', locale);
  const costName = (en: string | null, ar: string | null) => (locale === 'ar' && ar ? ar : (en ?? ''));
  const fields: Fact[] = [
    { label: m.column('document_no'), value: doc.documentNo, ltr: true },
    { label: m.column('status'), value: m.status(doc.status) },
    { label: x('kind'), value: x(`kind_${doc.kind}`) },
    { label: x('project'), value: `${view.project.code} · ${view.project.name}` },
    { label: m.column('date'), value: formatBusinessDate(doc.raisedOn, locale), ltr: true },
    { label: x('raised_by'), value: view.people.createdBy ?? '—' },
  ];
  const submitted = signed(view.people.submittedBy, doc.submittedAt, locale);
  const approved = signed(view.people.approvedBy, doc.approvedAt, locale);
  const rejected = signed(view.people.rejectedBy, doc.rejectedAt, locale);
  if (submitted) fields.push({ label: x('submitted_by'), value: submitted });
  if (approved) fields.push({ label: x('approved_by'), value: approved });
  if (rejected) fields.push({ label: x('rejected_by'), value: `${rejected}${doc.rejectedReason ? ` · ${doc.rejectedReason}` : ''}` });
  if (view.variationNo) fields.push({ label: x('change_order'), value: view.variationNo, ltr: true });
  fields.push({ label: m.column('description'), value: doc.description });

  const rows: Row[] = view.lines.map((line) => ({
    cells: {
      line: String(line.lineNo),
      element: `${line.wbsCode}${line.elementName ? ` · ${line.elementName}` : ''}`,
      cost_code: `${line.costCode}${line.costName ? ` · ${costName(line.costName, line.costNameAr)}` : ''}`,
      description: line.description ?? '—',
      amount: line.amountIqd,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_budget'),
      number: doc.documentNo,
      status: m.status(doc.status),
      posted: doc.status === 'approved',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: x('lines'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.4 },
            { key: 'element', label: x('element'), kind: 'text', weight: 1.6 },
            { key: 'cost_code', label: x('cost_code'), kind: 'text', weight: 1.2 },
            { key: 'description', label: m.column('description'), kind: 'text', weight: 1.6 },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
          ],
          rows,
          empty: m.admin('none'),
          totals: { label: m.column('amount'), cells: { amount: doc.totalIqd }, sum: ['amount'] },
        },
      ],
      summary: [{ label: m.column('amount'), value: money(doc.totalIqd), ltr: true }],
      signatures: true,
      currency: 'IQD',
      fileName: doc.documentNo,
      sheetName: doc.documentNo,
    },
    branchCode: view.project.branchCode ?? ctx.branchCode,
    objectId: doc.documentNo,
  };
}

/** A change order — REQ-PM-001 §7, R2: the budget it moves, and its two approvals. */
export async function changeOrder(ctx: BuildContext, variationNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let view: Awaited<ReturnType<typeof budget.changeOrder>>;
  try {
    view = await budget.changeOrder(tx, actorOf(ctx), variationNo);
  } catch {
    return null;
  }
  const v = view.variation;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`projects.${key}`, values);
  const money = (value: string) => formatMoney(value, 'IQD', locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const costName = (en: string | null, ar: string | null) => (locale === 'ar' && ar ? ar : (en ?? ''));
  const commercial = signed(view.people.commercialBy, v.commercialApprovedAt, locale);
  const budgetApproval = signed(view.people.budgetBy, v.budgetApprovedAt, locale);
  const rejected = signed(view.people.rejectedBy, v.rejectedAt, locale);
  const fields: Fact[] = [
    { label: m.column('document_no'), value: v.variationNo, ltr: true },
    { label: m.column('status'), value: m.status(v.status) },
    { label: x('project'), value: `${view.project.code} · ${view.project.name}` },
    { label: m.column('date'), value: day(v.raisedOn), ltr: true },
    { label: x('version'), value: `v${v.version}${view.supersedesNo ? ` · ${x('supersedes')} ${view.supersedesNo}` : ''}`, ltr: true },
    { label: x('contract_delta'), value: money(v.contractDeltaIqd), ltr: true },
    { label: x('budget_delta'), value: money(v.budgetDeltaIqd), ltr: true },
    {
      label: x('schedule_delta'),
      value: v.revisedEndsOn ? day(v.revisedEndsOn) : v.scheduleDeltaDays ? x('days', { count: v.scheduleDeltaDays }) : '—',
      ltr: true,
    },
    { label: x('raised_by'), value: view.people.createdBy ?? '—' },
    { label: x('approval_commercial'), value: commercial ?? m.admin('none') },
    { label: x('approval_budget'), value: budgetApproval ?? m.admin('none') },
  ];
  if (rejected) fields.push({ label: x('rejected_by'), value: `${rejected}${v.rejectedReason ? ` · ${v.rejectedReason}` : ''}` });
  if (view.budgetDocumentNo) fields.push({ label: x('budget_document'), value: view.budgetDocumentNo, ltr: true });
  fields.push({ label: m.column('description'), value: v.description });
  if (v.scopeNote) fields.push({ label: x('scope_note'), value: v.scopeNote });

  const rows: Row[] = view.lines.map((line) => ({
    cells: {
      line: String(line.lineNo),
      element: `${line.wbsCode}${line.elementName ? ` · ${line.elementName}` : ''}`,
      cost_code: `${line.costCode}${line.costName ? ` · ${costName(line.costName, line.costNameAr)}` : ''}`,
      description: line.description ?? '—',
      amount: line.amountIqd,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_change_order'),
      number: v.variationNo,
      status: m.status(v.status),
      posted: v.status === 'approved',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: x('budget_moved'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.4 },
            { key: 'element', label: x('element'), kind: 'text', weight: 1.6 },
            { key: 'cost_code', label: x('cost_code'), kind: 'text', weight: 1.2 },
            { key: 'description', label: m.column('description'), kind: 'text', weight: 1.6 },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
          ],
          rows,
          empty: x('no_budget_moved'),
          totals: { label: x('budget_delta'), cells: { amount: v.budgetDeltaIqd }, sum: ['amount'] },
        },
      ],
      summary: [
        { label: x('contract_delta'), value: money(v.contractDeltaIqd), ltr: true },
        { label: x('budget_delta'), value: money(v.budgetDeltaIqd), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: v.variationNo,
      sheetName: v.variationNo,
    },
    branchCode: view.project.branchCode ?? ctx.branchCode,
    objectId: v.variationNo,
  };
}

/** A material issue or return — REQ-PM-001 §9: the items, their quantities and the cost each became. */
export async function materialIssue(ctx: BuildContext, documentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let view: Awaited<ReturnType<typeof execution.issue>>;
  try {
    view = await execution.issue(tx, actorOf(ctx), documentNo);
  } catch {
    return null;
  }
  const doc = view.document;
  const x = (key: string) => m.admin(`projects.${key}`);
  const money = (value: string) => formatMoney(value, 'IQD', locale);
  const posted = doc.status === 'posted';
  const fields: Fact[] = [
    { label: m.column('document_no'), value: doc.documentNo, ltr: true },
    { label: m.column('status'), value: m.status(doc.status) },
    { label: x('kind'), value: doc.kind === 'issue' ? x('kind_issue') : x('kind_return_stock') },
    { label: x('project'), value: `${view.project.code} · ${view.project.name}` },
    { label: x('element'), value: `${doc.wbsCode}${view.elementName ? ` · ${view.elementName}` : ''}` },
    { label: x('cost_code'), value: doc.costCode, ltr: true },
    { label: m.column('warehouse'), value: doc.warehouseCode, ltr: true },
    { label: m.column('date'), value: formatBusinessDate(doc.movementDate, locale), ltr: true },
    { label: x('raised_by'), value: view.people.createdBy ?? '—' },
  ];
  const postedBy = signed(view.people.postedBy, doc.postedAt, locale);
  const cancelledBy = signed(view.people.cancelledBy, doc.cancelledAt, locale);
  if (postedBy) fields.push({ label: x('posted_by'), value: postedBy });
  if (cancelledBy) fields.push({ label: x('cancelled_by'), value: `${cancelledBy}${doc.cancelReason ? ` · ${doc.cancelReason}` : ''}` });
  if (doc.description) fields.push({ label: m.column('description'), value: doc.description });

  const rows: Row[] = view.lines.map((line) => ({
    cells: {
      line: String(line.lineNo),
      item_code: line.itemCode,
      item_name: line.itemName ?? '—',
      quantity: line.quantity,
      batch: line.batchNumber ?? null,
      serial: line.serialNumber ?? null,
      // A draft's cost is the layer's at posting: nothing to print until then.
      unit_cost: line.unitCostIqd ?? null,
      cost: posted ? line.costIqd : null,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_material_issue'),
      number: doc.documentNo,
      status: m.status(doc.status),
      posted,
      orientation: 'landscape',
      fields,
      filters: [],
      tables: [
        {
          title: x('lines'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.4 },
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'item_name', label: m.column('item_name'), kind: 'text', weight: 2 },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
            { key: 'batch', label: m.column('batch_number'), kind: 'code' },
            { key: 'serial', label: m.column('serial_number'), kind: 'code' },
            { key: 'unit_cost', label: x('unit_cost'), kind: 'money', decimals: 4 },
            { key: 'cost', label: x('cost'), kind: 'money' },
          ],
          rows,
          empty: m.admin('none'),
          totals: { label: x('cost'), cells: { cost: posted ? doc.totalCostIqd : null }, sum: ['cost'] },
        },
      ],
      summary: [{ label: x('cost'), value: money(doc.totalCostIqd), ltr: true }],
      signatures: true,
      currency: 'IQD',
      fileName: doc.documentNo,
      sheetName: doc.documentNo,
    },
    branchCode: doc.branchCode,
    objectId: doc.documentNo,
  };
}
