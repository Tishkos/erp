/**
 * A Project Initiation as print models (the Project Guide, 2026-10-12).
 *
 *   `projectInitiation` — the record as its page shows it: the header, what
 *   each stage it has reached recorded, the bill of quantities with its three
 *   costs, a tender's compliance matrix, and the follow-up activities.
 *   `projectProposal` — the guide's "generate the technical and commercial
 *   proposal": the customer, the site and the system asked for (the technical
 *   part) and the scope of supply and works with the proposal's value (the
 *   commercial part). It prints the BOQ's lines without their costs — a cost is
 *   the company's own figure, the proposal's value is what the customer reads.
 *
 * Both read through `services/project-initiation.viewByNo`, so a copy is the
 * screen; the reader's row security and the project `view` grant decide.
 */
import { formatBusinessDate, formatMoney } from '@/i18n/config';
import { businessDateOf } from '../domain/business-date';
import { guideNumber, hasReached, sectionStage, type InitiationStage } from '../domain/project-initiation';
import * as initiation from '../services/project-initiation';
import type { BuildContext, Built } from './documents';
import type { Fact, Row, Table } from './model';

/** The lead sources 0421 seeded; one added later prints by its own name. */
const SEEDED_SOURCES = ['REFERRAL', 'EXISTING_CUSTOMER', 'WEBSITE', 'SOCIAL_MEDIA', 'EXHIBITION', 'WALK_IN', 'COLD_CALL', 'PARTNER', 'OTHER'];

async function read(ctx: BuildContext, initiationNo: string) {
  try {
    return await initiation.viewByNo(ctx.tx, initiationNo);
  } catch {
    return null;
  }
}

/** The words every initiation model shares. */
function wordsOf(ctx: BuildContext, view: initiation.InitiationView) {
  const { m, locale } = ctx;
  const row = view.initiation;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`project_initiation.${key}`, values);
  const money = (value: string | null) => (value ? formatMoney(value, 'IQD', locale) : '—');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const option = (group: string, code: string | null) => (code ? x(`${group}.${code}`) : '—');
  const stageTitle = (stage: InitiationStage) => `${guideNumber(stage)} · ${x(`stage.${stage}`)}`;
  const reached = (stage: InitiationStage) => hasReached(view.kind, view.stage, stage);
  const customer = view.customer ? `${view.customer.code} · ${view.customer.name}` : row.customerName;
  const leadSource = row.leadSourceCode ? (SEEDED_SOURCES.includes(row.leadSourceCode) ? x(`lead_source_option.${row.leadSourceCode}`) : (view.leadSource?.name ?? row.leadSourceCode)) : '—';
  return { row, x, money, day, option, stageTitle, reached, customer, leadSource };
}

/** The bill of quantities, with or without what each line costs the company. */
function boqTable(ctx: BuildContext, view: initiation.InitiationView, costs: boolean): Table {
  const { m } = ctx;
  const x = (key: string) => m.admin(`project_initiation.${key}`);
  const rows: Row[] = view.boq.map((line) => ({
    cells: {
      line: String(line.lineNo),
      category: x(`boq_category_option.${line.category}`),
      item: line.itemCode,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      ...(costs ? { unit_cost: line.unitCostIqd, amount: line.amountIqd } : {}),
    },
  }));
  return {
    title: costs ? x('boq_title') : x('proposal_scope'),
    columns: [
      { key: 'line', label: '#', kind: 'code', weight: 0.4 },
      { key: 'category', label: x('boq_category'), kind: 'text', weight: 0.9 },
      { key: 'item', label: x('boq_item'), kind: 'code', weight: 1 },
      { key: 'description', label: m.column('description'), kind: 'text', weight: 2.2 },
      { key: 'quantity', label: x('boq_quantity'), kind: 'quantity' },
      { key: 'unit', label: x('boq_unit'), kind: 'text', weight: 0.6 },
      ...(costs
        ? [
            { key: 'unit_cost', label: x('boq_unit_cost'), kind: 'money' as const, decimals: 4 },
            { key: 'amount', label: x('boq_amount'), kind: 'money' as const },
          ]
        : []),
    ],
    rows,
    empty: x('boq_none'),
    ...(costs ? { totals: { label: x('boq_total'), cells: { amount: view.boqTotals.total }, sum: ['amount'] } } : {}),
  };
}

/** The record, as its page shows it. */
export async function projectInitiation(ctx: BuildContext, initiationNo: string): Promise<Built | null> {
  const view = await read(ctx, initiationNo);
  if (!view) return null;
  const { m, locale } = ctx;
  const { row, x, money, day, option, stageTitle, reached, customer, leadSource } = wordsOf(ctx, view);

  const fields: Fact[] = [
    { label: x('number'), value: row.initiationNo, ltr: true },
    { label: m.column('status'), value: x(`status.${view.status}`) },
    { label: x('kind'), value: x(`kind_option.${view.kind}`) },
    { label: x('stage_field'), value: stageTitle(view.stage) },
    { label: x('title_field'), value: row.title },
    { label: view.kind === 'tender' ? x('issuing_entity') : x('customer_name'), value: row.customerName },
    { label: x('customer_partner'), value: view.customer ? customer : x('customer_partner_none') },
    { label: x('owner'), value: view.people.owner ?? '—' },
    { label: m.column('branch'), value: row.branchCode, ltr: true },
    { label: x('raised_by'), value: `${view.people.createdBy ?? '—'} · ${formatBusinessDate(businessDateOf(row.createdAt), locale)}` },
  ];
  const add = (label: string, value: string | null, ltr = false) => fields.push({ label, value: value && value.trim() ? value : '—', ...(ltr ? { ltr: true } : {}) });

  if (view.kind === 'direct_sales') {
    add(x('customer_phone'), row.customerPhone, true);
    add(x('initial_contact_on'), day(row.initialContactOn), true);
    add(x('lead_source'), leadSource);
    if (row.leadNote) add(x('lead_note'), row.leadNote);
    if (reached('pre_sales')) {
      add(x('site_coordinates'), row.siteLatitude && row.siteLongitude ? `${row.siteLatitude}, ${row.siteLongitude}` : null, true);
      add(x('site_governorate'), row.siteGovernorate);
      add(x('site_area'), row.siteArea);
      add(x('site_kind'), option('site_kind_option', row.siteKind));
      add(x('system_type'), option('system_type_option', row.systemType));
      add(x('contact_name'), row.contactName);
      add(x('contact_job_title'), row.contactJobTitle);
      add(x('contact_phone'), [row.contactPhone, row.contactPhoneAlt].filter(Boolean).join(' · '), true);
      add(x('contact_email'), row.contactEmail, true);
    }
    if (reached('site_survey')) {
      add(x('survey_on'), day(row.surveyOn), true);
      add(x('site_verified'), row.siteVerified ? m.admin('yes') : m.admin('no'));
      if (row.surveyNote) add(x('survey_note'), row.surveyNote);
    }
    if (reached('proposal')) {
      add(x('proposal_ref'), row.proposalRef, true);
      add(x('proposal_on'), day(row.proposalOn), true);
      add(x('proposal_value'), money(row.proposalValueIqd), true);
      add(x('proposal_status'), option('proposal_status_option', row.proposalStatus));
    }
  } else if (view.kind === 'financing') {
    // The Renewable Energy Financing Initiative's sheet, stage by stage.
    add(x('customer_city'), row.customerCity);
    add(x('customer_phone'), row.customerPhone, true);
    add(x('initial_contact_on'), day(row.initialContactOn), true);
    if (reached('fin_quotation')) {
      add(x('quotation_ref'), row.proposalRef, true);
      add(x('quotation_on'), day(row.proposalOn), true);
      add(x('quotation_value'), money(row.proposalValueIqd), true);
      add(x('quotation_status'), option('quotation_status_option', row.proposalStatus));
    }
    if (reached('fin_bank_approval')) {
      add(x('financing_bank'), row.financingBank);
      add(x('financing_bank_ref'), row.financingBankRef, true);
      add(x('bank_approval_status'), option('bank_approval_option', row.bankApprovalStatus ?? 'pending'));
      add(x('bank_decided_on'), day(row.bankDecidedOn), true);
      add(x('loan_amount'), money(row.loanAmountIqd), true);
    }
    if (reached('fin_loan_first')) {
      add(x('loan_status'), option('loan_status_option', row.loanStatus ?? 'pending'));
      add(x('loan_received'), money(row.loanReceivedIqd), true);
      add(x('loan_first_received_on'), day(row.loanFirstReceivedOn), true);
      if (row.loanFullyGrantedOn) add(x('loan_fully_granted_on'), day(row.loanFullyGrantedOn), true);
    }
    if (reached('fin_installation')) {
      add(x('installation_status'), option('installation_status_option', row.installationStatus ?? 'not_started'));
      add(x('installation_started_on'), day(row.installationStartedOn), true);
      add(x('installation_completed_on'), day(row.installationCompletedOn), true);
      if (row.installationNote) add(x('installation_note'), row.installationNote);
    }
  } else {
    add(x('tender_ref'), row.tenderRef, true);
    add(x('submission_deadline'), day(row.submissionDeadline), true);
    add(x('tender_documents_url'), row.tenderDocumentsUrl, true);
    if (reached('go_no_go')) {
      add(x('qualification_requirements'), row.qualificationRequirements);
      add(x('bid_bond'), money(row.bidBondIqd), true);
      add(x('go_decision'), row.goDecision ? option('go_decision_option', row.goDecision) : x('go_decision_waiting'));
      if (row.goDecidedAt) add(x('go_decided_by'), `${view.people.goDecidedBy ?? '—'} · ${formatBusinessDate(businessDateOf(row.goDecidedAt), locale)}`);
      if (row.goNote) add(x('go_note'), row.goNote);
    }
    if (reached('pre_bid')) {
      add(x('site_visit_on'), day(row.siteVisitOn), true);
      add(x('site_visit_minutes'), row.siteVisitMinutes);
      add(x('clarifications'), row.clarifications);
    }
    if (reached('bidding')) {
      add(x('bid_price'), money(row.bidPriceIqd), true);
      add(x('guarantee_bank'), row.guaranteeBank);
      add(x('guarantee_no'), row.guaranteeNo, true);
      add(x('guarantee_amount'), money(row.guaranteeIqd), true);
      add(x('guarantee_expires_on'), day(row.guaranteeExpiresOn), true);
      add(x('guarantee_status'), option('guarantee_status_option', row.guaranteeStatus));
    }
    if (reached('award')) {
      add(x('submitted_on'), day(row.submittedOn), true);
      add(x('submission_ref'), row.submissionRef, true);
      add(x('award_status'), option('award_status_option', row.awardStatus));
      add(x('awarded_on'), day(row.awardedOn), true);
    }
  }
  if (reached(sectionStage(view.kind, 'contract')!)) {
    add(x('contract_ref'), row.contractRef, true);
    add(x('contract_signed_on'), day(row.contractSignedOn), true);
    add(x('contract_value'), money(row.contractValueIqd), true);
    add(x('payment_terms'), row.paymentTerms);
  }
  if (row.boqApprovedAt) add(x('boq_approved_by'), `${view.people.boqApprovedBy ?? '—'} · ${formatBusinessDate(businessDateOf(row.boqApprovedAt), locale)}`);
  if (view.project) {
    add(x('project'), `${view.project.code} · ${view.project.name}`);
    add(x('converted_by'), `${view.people.convertedBy ?? '—'}${row.convertedAt ? ` · ${formatBusinessDate(businessDateOf(row.convertedAt), locale)}` : ''}`);
  }
  if (view.status === 'lost') add(x('lost_reason'), `${row.lostReason ?? ''}${view.people.lostBy ? ` · ${view.people.lostBy}` : ''}`);

  const tables: Table[] = [boqTable(ctx, view, true)];
  if (view.kind === 'tender' && reached('bidding')) {
    tables.push({
      title: x('compliance_title'),
      columns: [
        { key: 'line', label: '#', kind: 'code', weight: 0.4 },
        { key: 'clause', label: x('compliance_clause'), kind: 'text', weight: 0.8 },
        { key: 'requirement', label: x('compliance_requirement'), kind: 'text', weight: 2.4 },
        { key: 'response', label: x('compliance_response'), kind: 'text', weight: 1 },
        { key: 'remark', label: x('compliance_remark'), kind: 'text', weight: 1.6 },
      ],
      rows: view.compliance.map((line) => ({
        cells: {
          line: String(line.lineNo),
          clause: line.clause,
          requirement: line.requirement,
          response: line.response ? x(`compliance_response_option.${line.response}`) : x('compliance_unanswered'),
          remark: line.remark,
        },
      })),
      empty: x('compliance_none'),
    });
  }
  tables.push({
    title: x('activities_title'),
    columns: [
      { key: 'date', label: m.column('date'), kind: 'date' },
      { key: 'kind', label: x('activity_kind'), kind: 'text', weight: 0.9 },
      { key: 'summary', label: x('activity_summary'), kind: 'text', weight: 2.6 },
      { key: 'next', label: x('activity_next'), kind: 'text', weight: 1.4 },
      { key: 'by', label: x('activity_by'), kind: 'text', weight: 1 },
    ],
    rows: view.activities.map((activity) => ({
      cells: {
        date: activity.happenedOn,
        kind: x(`activity_kind_option.${activity.kind}`),
        summary: activity.summary,
        next: activity.nextAction ? `${activity.nextAction}${activity.nextActionOn ? ` · ${formatBusinessDate(activity.nextActionOn, locale)}` : ''}` : null,
        by: activity.byName,
      },
    })),
    empty: x('activities_none'),
  });

  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_initiation'),
      number: row.initiationNo,
      status: x(`status.${view.status}`),
      // Not a posting document: it carries no DRAFT mark, and says its status in words.
      posted: true,
      orientation: 'portrait',
      fields,
      filters: [],
      tables,
      summary: [
        { label: x('boq_category_option.material'), value: money(view.boqTotals.material), ltr: true },
        { label: x('boq_category_option.shipping'), value: money(view.boqTotals.shipping), ltr: true },
        { label: x('boq_category_option.installation'), value: money(view.boqTotals.installation), ltr: true },
        { label: x('boq_total'), value: money(view.boqTotals.total), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: row.initiationNo,
      sheetName: row.initiationNo,
    },
    branchCode: row.branchCode,
    objectId: row.initiationNo,
  };
}

/** The technical and commercial proposal of a direct sale, once the record has reached its Proposal stage. */
export async function projectProposal(ctx: BuildContext, initiationNo: string): Promise<Built | null> {
  const view = await read(ctx, initiationNo);
  if (!view || view.kind !== 'direct_sales' || !hasReached(view.kind, view.stage, 'proposal')) return null;
  const { m } = ctx;
  const { row, x, money, day, option, customer } = wordsOf(ctx, view);
  const reference = row.proposalRef ?? row.initiationNo;

  const fields: Fact[] = [
    { label: x('proposal_ref'), value: reference, ltr: true },
    { label: x('proposal_on'), value: day(row.proposalOn), ltr: true },
    { label: x('proposal_status'), value: option('proposal_status_option', row.proposalStatus ?? 'draft') },
    { label: x('number'), value: row.initiationNo, ltr: true },
    { label: x('title_field'), value: row.title },
    { label: x('customer'), value: customer },
    { label: x('contact_name'), value: [row.contactName, row.contactJobTitle].filter(Boolean).join(' · ') || '—' },
    { label: x('contact_phone'), value: [row.contactPhone, row.contactPhoneAlt].filter(Boolean).join(' · ') || '—', ltr: true },
    { label: x('contact_email'), value: row.contactEmail ?? '—', ltr: true },
    // The technical part: what is asked for, and where.
    { label: x('proposal_technical'), value: option('system_type_option', row.systemType) },
    { label: x('site_kind'), value: option('site_kind_option', row.siteKind) },
    { label: x('site_governorate'), value: [row.siteGovernorate, row.siteArea].filter(Boolean).join(' · ') || '—' },
    { label: x('site_coordinates'), value: row.siteLatitude && row.siteLongitude ? `${row.siteLatitude}, ${row.siteLongitude}` : '—', ltr: true },
  ];

  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_proposal'),
      number: reference,
      status: option('proposal_status_option', row.proposalStatus ?? 'draft'),
      // A proposal still being written says so across the page.
      posted: Boolean(row.proposalStatus) && row.proposalStatus !== 'draft',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [boqTable(ctx, view, false)],
      // The commercial part: one figure, the proposal's value.
      summary: [{ label: `${x('proposal_commercial')} — ${x('proposal_total')}`, value: money(row.proposalValueIqd), ltr: true }],
      signatures: true,
      currency: 'IQD',
      fileName: `${row.initiationNo}-proposal`,
      sheetName: row.initiationNo,
    },
    branchCode: row.branchCode,
    objectId: row.initiationNo,
  };
}
