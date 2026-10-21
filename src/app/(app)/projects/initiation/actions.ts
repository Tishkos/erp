'use server';

/**
 * Project Initiation — the company's Project Guide (2026-10-12). Every form of
 * the register and the record is a call to `services/project-initiation.ts`
 * under the caller's own context, with an audit row behind it; the page it
 * returns to says what was saved or why it was refused.
 */
import { flag, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import * as initiation from '@/server/services/project-initiation';

const LIST = '/projects/initiation';
const record = (no: string) => `${LIST}/${encodeURIComponent(no)}`;
/** Back to the record, at the part of it the form sat in. */
const at = (no: string, anchor: string) => `${record(no)}#${anchor}`;

/** The Main Project Initiation Selector: the type chosen, the record opened at its first stage. */
export async function createInitiation(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      initiation.create(tx, ctx, {
        kind: text(form, 'kind'),
        title: text(form, 'title'),
        customerName: text(form, 'customer_name'),
        customerPhone: text(form, 'customer_phone') || null,
        customerCity: text(form, 'customer_city') || null,
        ownerUserId: text(form, 'owner_user_id') || null,
      }),
    (value) => {
      const created = value as { initiationNo?: string } | null | undefined;
      return created?.initiationNo ? record(created.initiationNo) : withQuery(LIST, 'new', '1');
    },
  );
}

/** What each form field is called in the service. A field the form did not carry is left as it was. */
const FIELDS: Readonly<Record<string, keyof initiation.SectionInput>> = {
  title: 'title',
  customer_name: 'customerName',
  customer_phone: 'customerPhone',
  initial_contact_on: 'initialContactOn',
  lead_source_code: 'leadSourceCode',
  lead_note: 'leadNote',
  partner_id: 'partnerId',
  site_latitude: 'siteLatitude',
  site_longitude: 'siteLongitude',
  site_governorate: 'siteGovernorate',
  site_area: 'siteArea',
  site_kind: 'siteKind',
  contact_name: 'contactName',
  contact_job_title: 'contactJobTitle',
  contact_phone: 'contactPhone',
  contact_phone_alt: 'contactPhoneAlt',
  contact_email: 'contactEmail',
  system_type: 'systemType',
  survey_on: 'surveyOn',
  survey_note: 'surveyNote',
  proposal_ref: 'proposalRef',
  proposal_on: 'proposalOn',
  proposal_value_iqd: 'proposalValueIqd',
  proposal_status: 'proposalStatus',
  tender_ref: 'tenderRef',
  tender_documents_url: 'tenderDocumentsUrl',
  submission_deadline: 'submissionDeadline',
  qualification_requirements: 'qualificationRequirements',
  bid_bond_iqd: 'bidBondIqd',
  site_visit_on: 'siteVisitOn',
  site_visit_minutes: 'siteVisitMinutes',
  clarifications: 'clarifications',
  bid_price_iqd: 'bidPriceIqd',
  guarantee_bank: 'guaranteeBank',
  guarantee_no: 'guaranteeNo',
  guarantee_iqd: 'guaranteeIqd',
  guarantee_expires_on: 'guaranteeExpiresOn',
  guarantee_status: 'guaranteeStatus',
  submitted_on: 'submittedOn',
  submission_ref: 'submissionRef',
  award_status: 'awardStatus',
  awarded_on: 'awardedOn',
  contract_ref: 'contractRef',
  contract_signed_on: 'contractSignedOn',
  contract_value_iqd: 'contractValueIqd',
  payment_terms: 'paymentTerms',
  // The financing road (0424).
  customer_city: 'customerCity',
  financing_bank: 'financingBank',
  financing_bank_ref: 'financingBankRef',
  bank_approval_status: 'bankApprovalStatus',
  bank_decided_on: 'bankDecidedOn',
  loan_amount_iqd: 'loanAmountIqd',
  loan_status: 'loanStatus',
  loan_received_iqd: 'loanReceivedIqd',
  loan_first_received_on: 'loanFirstReceivedOn',
  loan_fully_granted_on: 'loanFullyGrantedOn',
  installation_status: 'installationStatus',
  installation_started_on: 'installationStartedOn',
  installation_completed_on: 'installationCompletedOn',
  installation_note: 'installationNote',
};

/** One stage's form: the section it belongs to, and the fields it showed. */
export async function saveInitiationSection(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  const section = text(form, 'section');
  const input: Record<string, string | boolean | null> = {};
  for (const [name, key] of Object.entries(FIELDS)) {
    if (form.has(name)) input[key] = text(form, name) || null;
  }
  // An unticked box is not in the form at all, so the survey's form says which way it stands.
  if (section === 'site_survey') input.siteVerified = flag(form, 'site_verified');
  await runAdminAndReturn((tx, ctx) => initiation.saveSection(tx, ctx, no, section, input as initiation.SectionInput), at(no, `stage-${section}`));
}

export async function addBoqLine(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      initiation.addBoqLine(tx, ctx, no, {
        category: text(form, 'category'),
        itemCode: text(form, 'item_code') || null,
        description: text(form, 'description'),
        quantity: text(form, 'quantity'),
        unit: text(form, 'unit') || null,
        unitCostIqd: text(form, 'unit_cost_iqd'),
      }),
    at(no, 'initiation-document'),
  );
}

export async function removeBoqLine(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn((tx, ctx) => initiation.removeBoqLine(tx, ctx, no, text(form, 'line_id')), at(no, 'initiation-document'));
}

export async function addComplianceLine(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      initiation.addComplianceLine(tx, ctx, no, {
        clause: text(form, 'clause') || null,
        requirement: text(form, 'requirement'),
        response: text(form, 'response') || null,
        remark: text(form, 'remark') || null,
      }),
    at(no, 'compliance'),
  );
}

export async function answerComplianceLine(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn(
    (tx, ctx) => initiation.answerComplianceLine(tx, ctx, no, text(form, 'line_id'), { response: text(form, 'response'), remark: text(form, 'remark') || null }),
    at(no, 'compliance'),
  );
}

export async function removeComplianceLine(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn((tx, ctx) => initiation.removeComplianceLine(tx, ctx, no, text(form, 'line_id')), at(no, 'compliance'));
}

export async function logInitiationActivity(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      initiation.logActivity(tx, ctx, no, {
        kind: text(form, 'kind'),
        happenedOn: text(form, 'happened_on') || null,
        summary: text(form, 'summary'),
        nextAction: text(form, 'next_action') || null,
        nextActionOn: text(form, 'next_action_on') || null,
      }),
    at(no, 'activities'),
  );
}

/** One stage forward, when the current one holds what the guide asks. */
export async function advanceInitiation(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn((tx, ctx) => initiation.advance(tx, ctx, no), record(no));
}

/** The tender's Go / No-Go, approved. */
export async function decideInitiationGo(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn((tx, ctx) => initiation.decideGo(tx, ctx, no, { decision: text(form, 'decision'), note: text(form, 'note') || null }), record(no));
}

export async function markInitiationLost(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn((tx, ctx) => initiation.markLost(tx, ctx, no, text(form, 'reason')), record(no));
}

/** The signed contract confirmed: the record becomes an Active Project, and the reader lands on it. */
export async function convertInitiation(form: FormData): Promise<void> {
  const no = text(form, 'initiation_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      initiation.convert(tx, ctx, no, {
        managerUserId: text(form, 'manager_user_id'),
        baselineStartsOn: text(form, 'baseline_starts_on'),
        baselineEndsOn: text(form, 'baseline_ends_on'),
        departmentCode: text(form, 'department_code') || null,
        billingMethod: text(form, 'billing_method') || null,
        retentionPercent: text(form, 'retention_percent') || null,
        advanceRecoveryPercent: text(form, 'advance_recovery_percent') || null,
        projectCode: text(form, 'project_code') || null,
      }),
    (value) => {
      const made = value as { projectCode?: string } | null | undefined;
      return made?.projectCode ? `/projects/${encodeURIComponent(made.projectCode)}` : record(no);
    },
  );
}
