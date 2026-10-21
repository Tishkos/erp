/**
 * Project Initiation — the company's Project Guide, as rules.
 *
 * The guide (2026-10-12, by direction: "we need our project follow the project
 * guides") opens every customer project with one choice — the **Main Project
 * Initiation Selector** — and then walks one of two roads to the same end:
 *
 *   Direct Sales   1 Sales Lead → 2 Opportunity and Pre-Sales Form → 3 Site
 *                  Survey Design → 4 BOQ Costing → 5 Proposal Follow-up →
 *                  6 Contract Signing
 *   Tender         7 Tender Lead → 8 Feasibility Review and Tender
 *                  Qualification (Go / No-Go) → 9 Site Visit & Pre-Bid Meeting →
 *                  10 Tender Design BOQ → 11 Compliance Matrix & Bidding →
 *                  12 Submission & Award
 *   Financing      the Renewable Energy Financing Initiative (2026-10-21, by
 *                  direction, from its own sheet, numbered 1–7 on its own):
 *                  1 Customer → 2 Quotation sent (agreed / refused) → 3 Bank
 *                  approval (approved / rejected) → 4 Loan (partially paid /
 *                  pending) → 5 Installation (in progress / completed) →
 *                  6 Contract (signed / pending) → 7 Loan (fully granted /
 *                  pending)
 *
 * and at contract signing "the record is automatically converted into an
 * Active Project", carrying its Pre-Sales Form, drawings and approved BOQ to
 * the project master.
 *
 * This file is the road and its gates, with no database: which stage follows
 * which, what a stage must hold before the record leaves it, the arithmetic of
 * a bill of quantities. `services/project-initiation.ts` writes; migration 0421
 * holds the same road by trigger. Nothing here posts, commits stock or creates
 * an obligation — an initiation is what comes before the project.
 *
 * Money is scaled at 10^4 and quantities at 10^6, summed as bigints.
 */
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from './money';

export class InitiationRuleError extends Error {
  readonly code = 'PROJECT_INITIATION_RULE';
  constructor(message: string) {
    super(message);
    this.name = 'InitiationRuleError';
  }
}

// ---------------------------------------------------------------------------
// §1 — the Main Project Initiation Selector
// ---------------------------------------------------------------------------

export const INITIATION_KINDS = ['direct_sales', 'tender', 'financing'] as const;
export type InitiationKind = (typeof INITIATION_KINDS)[number];

export function isInitiationKind(value: string): value is InitiationKind {
  return (INITIATION_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// §2, §3 — the two workflows, in the guide's own order and numbering
// ---------------------------------------------------------------------------

export const DIRECT_SALES_STAGES = ['lead', 'pre_sales', 'site_survey', 'boq_costing', 'proposal', 'contract'] as const;
export const TENDER_STAGES = ['tender_lead', 'go_no_go', 'pre_bid', 'tender_design', 'bidding', 'award'] as const;
/** The Renewable Energy Financing Initiative: a customer whose system a bank loan pays for. */
export const FINANCING_STAGES = [
  'fin_customer',
  'fin_quotation',
  'fin_bank_approval',
  'fin_loan_first',
  'fin_installation',
  'fin_contract',
  'fin_loan_full',
] as const;
export const INITIATION_STAGES = [...DIRECT_SALES_STAGES, ...TENDER_STAGES, ...FINANCING_STAGES] as const;
export type InitiationStage = (typeof INITIATION_STAGES)[number];

export function isInitiationStage(value: string): value is InitiationStage {
  return (INITIATION_STAGES as readonly string[]).includes(value);
}

/** The stages of one workflow, first to last. */
export function stagesOf(kind: InitiationKind): readonly InitiationStage[] {
  return kind === 'direct_sales' ? DIRECT_SALES_STAGES : kind === 'tender' ? TENDER_STAGES : FINANCING_STAGES;
}

/**
 * The number the guide gives a stage: 1–6 for Direct Sales, 7–12 for the
 * tender pipeline; the financing sheet numbers its own seven 1–7.
 */
export function guideNumber(stage: InitiationStage): number {
  const financing = (FINANCING_STAGES as readonly string[]).indexOf(stage);
  if (financing >= 0) return financing + 1;
  return INITIATION_STAGES.indexOf(stage) + 1;
}

export function firstStage(kind: InitiationKind): InitiationStage {
  return stagesOf(kind)[0]!;
}

/** The stage after this one, or null at the last — where the next step is the contract's conversion. */
export function nextStage(kind: InitiationKind, stage: InitiationStage): InitiationStage | null {
  const road = stagesOf(kind);
  const at = road.indexOf(stage);
  if (at < 0) throw new InitiationRuleError(`'${stage}' is not a stage of the ${kind} workflow.`);
  return road[at + 1] ?? null;
}

export function isLastStage(kind: InitiationKind, stage: InitiationStage): boolean {
  return nextStage(kind, stage) === null;
}

/** done · current · pending — how the record page draws each stage. */
export type StageState = 'done' | 'current' | 'pending';

export function stageStates(
  kind: InitiationKind,
  stage: InitiationStage,
  status: InitiationStatus,
): readonly { readonly stage: InitiationStage; readonly state: StageState }[] {
  const road = stagesOf(kind);
  const at = road.indexOf(stage);
  return road.map((step, index) => ({
    stage: step,
    // A converted record has walked the whole road, its last stage included.
    state: status === 'converted' || index < at ? 'done' : index === at ? 'current' : 'pending',
  }));
}

// ---------------------------------------------------------------------------
// Status — open until it becomes a project or is lost
// ---------------------------------------------------------------------------

export const INITIATION_STATUSES = ['open', 'converted', 'lost'] as const;
export type InitiationStatus = (typeof INITIATION_STATUSES)[number];

/** The chip each status wears (the shared status vocabulary). */
export function initiationChip(status: InitiationStatus): string {
  return status === 'converted' ? 'approved' : status === 'lost' ? 'rejected' : 'submitted';
}

// ---------------------------------------------------------------------------
// Leads → Opportunities → Projects (2026-10-21, by direction)
// ---------------------------------------------------------------------------

/**
 * Where a record stands in the company's pipeline: a **lead** while it is at
 * the first stage of its road, an **opportunity** from the second stage until
 * it is decided, a **project** once its contract converted it. A lost record
 * stays in the phase it was lost in. One record and one number throughout.
 */
export const PIPELINE_PHASES = ['lead', 'opportunity', 'project'] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

export function isPipelinePhase(value: string): value is PipelinePhase {
  return (PIPELINE_PHASES as readonly string[]).includes(value);
}

/** The first stage of every road — the stages a lead stands at. */
export const LEAD_STAGES: readonly InitiationStage[] = INITIATION_KINDS.map((kind) => firstStage(kind));

export function phaseOf(stage: InitiationStage, status: InitiationStatus): PipelinePhase {
  if (status === 'converted') return 'project';
  return LEAD_STAGES.includes(stage) ? 'lead' : 'opportunity';
}

// ---------------------------------------------------------------------------
// The Pre-Sales Form's closed lists (§2)
// ---------------------------------------------------------------------------

/** "Specify the required system type, such as On-Grid, Off-Grid, Hybrid, BESS, or Solar Pumping." */
export const SYSTEM_TYPES = ['on_grid', 'off_grid', 'hybrid', 'bess', 'solar_pumping'] as const;
export type SystemType = (typeof SYSTEM_TYPES)[number];

/** "The type of project land or rooftop." */
export const SITE_KINDS = ['land', 'rooftop'] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export const PROPOSAL_STATUSES = ['draft', 'sent', 'negotiating', 'accepted', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// The tender pipeline's closed lists (§3)
// ---------------------------------------------------------------------------

export const GO_DECISIONS = ['go', 'no_go'] as const;
export type GoDecision = (typeof GO_DECISIONS)[number];

/** The bid bond's life: asked of the bank, issued, then released or converted on award — or lost. */
export const GUARANTEE_STATUSES = ['requested', 'issued', 'released', 'converted', 'forfeited'] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];

export const AWARD_STATUSES = ['pending', 'awarded', 'not_awarded'] as const;
export type AwardStatus = (typeof AWARD_STATUSES)[number];

export const COMPLIANCE_RESPONSES = ['compliant', 'partial', 'non_compliant', 'not_applicable'] as const;
export type ComplianceResponse = (typeof COMPLIANCE_RESPONSES)[number];

// ---------------------------------------------------------------------------
// The financing road's closed lists — each stage's outcome on the sheet
// ---------------------------------------------------------------------------

/**
 * The quotation is kept in the proposal's columns: sent, then agreed
 * (`accepted`) or refused (`rejected`) by the customer.
 */
export const QUOTATION_STATUSES = ['sent', 'accepted', 'rejected'] as const satisfies readonly ProposalStatus[];

/** "Bank Approval — Approved / Rejected", pending until the bank answers. */
export const BANK_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type BankApprovalStatus = (typeof BANK_APPROVAL_STATUSES)[number];

/** "Loan — Partially paid / Pending" at stage 4, "Fully granted / pending" at stage 7. */
export const LOAN_STATUSES = ['pending', 'partially_paid', 'fully_granted'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** "Installation — In Progress / Completed". */
export const INSTALLATION_STATUSES = ['not_started', 'in_progress', 'completed'] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// What is filed where — each stage that names documents keeps its own
// ---------------------------------------------------------------------------

/**
 * The record's sections that file their own papers, each keyed by the
 * initiation's number under a name of its own (the import application's
 * manner): the customer's documents of the Pre-Sales Form, the SLD and layout,
 * the proposal, the tender documents, the bid and its guarantee, the signed
 * contract.
 */
export const INITIATION_FILE_SECTIONS = [
  'initiation_customer_docs',
  'initiation_design',
  'initiation_proposal',
  'initiation_tender_docs',
  'initiation_bid',
  'initiation_contract',
  // The financing road (0424): the bank's approval and loan papers, the installation's.
  'initiation_bank',
  'initiation_installation',
] as const;
export type InitiationFileSection = (typeof INITIATION_FILE_SECTIONS)[number];

// ---------------------------------------------------------------------------
// Follow-up activities (§2 step 5, §3 step 9) — append-only
// ---------------------------------------------------------------------------

export const INITIATION_ACTIVITY_KINDS = ['follow_up', 'call', 'meeting', 'site_visit', 'clarification', 'addendum', 'note'] as const;
export type InitiationActivityKind = (typeof INITIATION_ACTIVITY_KINDS)[number];

// ---------------------------------------------------------------------------
// The bill of quantities (§2 step 4, §3 step 10)
// ---------------------------------------------------------------------------

/** "Calculate material, shipping, and installation costs." */
export const BOQ_CATEGORIES = ['material', 'shipping', 'installation'] as const;
export type BoqCategory = (typeof BOQ_CATEGORIES)[number];

export const QUANTITY_SCALE = 6n;

export interface BoqLineInput {
  readonly category: BoqCategory;
  /** Decimal strings as stored: quantity at 6 places, unit cost at 4. */
  readonly quantity: string;
  readonly unitCostIqd: string;
}

/** One line's amount: quantity × unit cost, to the fils-of-a-dinar scale, half up. */
export function boqLineAmount(quantity: string, unitCostIqd: string): bigint {
  const qty = parseDecimal(quantity, QUANTITY_SCALE);
  const cost = parseDecimal(unitCostIqd, MONEY_SCALE);
  if (qty <= 0n) throw new InitiationRuleError('A BOQ line needs a quantity above zero.');
  if (cost < 0n) throw new InitiationRuleError('A BOQ line cannot carry a negative unit cost.');
  return divideHalfUp(qty * cost, 10n ** QUANTITY_SCALE);
}

export interface BoqTotals {
  readonly material: string;
  readonly shipping: string;
  readonly installation: string;
  readonly total: string;
  readonly lines: number;
}

/** The three costs the guide names and their sum, from amounts already at the money scale. */
export function boqTotals(lines: readonly { readonly category: string; readonly amountIqd: string }[]): BoqTotals {
  const sums: Record<BoqCategory, bigint> = { material: 0n, shipping: 0n, installation: 0n };
  for (const line of lines) {
    if (!(BOQ_CATEGORIES as readonly string[]).includes(line.category)) {
      throw new InitiationRuleError(`'${line.category}' is not a BOQ cost: material, shipping or installation.`);
    }
    sums[line.category as BoqCategory] += parseDecimal(line.amountIqd, MONEY_SCALE);
  }
  return {
    material: toDecimalString(sums.material, MONEY_SCALE),
    shipping: toDecimalString(sums.shipping, MONEY_SCALE),
    installation: toDecimalString(sums.installation, MONEY_SCALE),
    total: toDecimalString(sums.material + sums.shipping + sums.installation, MONEY_SCALE),
    lines: lines.length,
  };
}

// ---------------------------------------------------------------------------
// Site coordinates — "Site coordinates (GPS)"
// ---------------------------------------------------------------------------

/** A latitude or longitude as typed, checked and kept to six places (about ten centimetres). */
export function coordinate(value: string | null | undefined, axis: 'latitude' | 'longitude'): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!/^-?\d{1,3}(\.\d{1,8})?$/.test(text)) {
    throw new InitiationRuleError(`The site ${axis} '${text}' is not a coordinate in decimal degrees (like 33.312806).`);
  }
  const limit = axis === 'latitude' ? 90 : 180;
  // A bound check on a coordinate, not money: a float comparison is exact enough for ±90 / ±180.
  if (Math.abs(Number(text)) > limit) {
    throw new InitiationRuleError(`The site ${axis} must lie between -${limit} and ${limit}.`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const kept = fraction.slice(0, 6).padEnd(6, '0');
  return `${negative ? '-' : ''}${Number(whole)}.${kept}`;
}

// ---------------------------------------------------------------------------
// The gates — what a stage holds before the record leaves it
// ---------------------------------------------------------------------------

/** Everything a gate reads. Amounts are decimal strings; counts are the record's own rows and files. */
export interface InitiationFacts {
  readonly kind: InitiationKind;
  readonly stage: InitiationStage;
  readonly status: InitiationStatus;
  readonly title: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerCity: string | null;
  readonly leadSourceCode: string | null;
  readonly initialContactOn: string | null;
  readonly partnerId: string | null;

  readonly siteLatitude: string | null;
  readonly siteLongitude: string | null;
  readonly siteGovernorate: string | null;
  readonly siteArea: string | null;
  readonly siteKind: string | null;
  readonly contactName: string | null;
  readonly contactJobTitle: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly systemType: string | null;

  readonly surveyOn: string | null;
  readonly siteVerified: boolean;

  readonly proposalRef: string | null;
  readonly proposalOn: string | null;
  readonly proposalValueIqd: string | null;
  readonly proposalStatus: string | null;

  readonly tenderRef: string | null;
  readonly tenderDocumentsUrl: string | null;
  readonly submissionDeadline: string | null;
  readonly qualificationRequirements: string | null;
  readonly bidBondIqd: string | null;
  readonly goDecision: string | null;
  readonly siteVisitOn: string | null;
  readonly siteVisitMinutes: string | null;
  readonly bidPriceIqd: string | null;
  readonly guaranteeBank: string | null;
  readonly guaranteeNo: string | null;
  readonly guaranteeIqd: string | null;
  readonly guaranteeExpiresOn: string | null;
  readonly guaranteeStatus: string | null;
  readonly submittedOn: string | null;
  readonly awardStatus: string | null;
  readonly awardedOn: string | null;

  readonly contractRef: string | null;
  readonly contractSignedOn: string | null;
  readonly contractValueIqd: string | null;
  readonly paymentTerms: string | null;

  readonly financingBank: string | null;
  readonly bankApprovalStatus: string | null;
  readonly bankDecidedOn: string | null;
  readonly loanAmountIqd: string | null;
  readonly loanStatus: string | null;
  readonly loanReceivedIqd: string | null;
  readonly loanFirstReceivedOn: string | null;
  readonly loanFullyGrantedOn: string | null;
  readonly installationStatus: string | null;
  readonly installationCompletedOn: string | null;

  readonly boqLines: number;
  readonly boqTotalIqd: string;
  readonly complianceLines: number;
  readonly complianceUnanswered: number;
  readonly files: Readonly<Record<InitiationFileSection, number>>;
}

/**
 * What is still missing, as codes — `admin.project_initiation.missing.<code>`
 * says each in the reader's language. An empty list is an open gate.
 */
export type MissingCode =
  | 'title'
  | 'customer_name'
  | 'customer_phone'
  | 'lead_source'
  | 'initial_contact_on'
  | 'site_coordinates'
  | 'site_governorate'
  | 'site_area'
  | 'site_kind'
  | 'contact_name'
  | 'contact_job_title'
  | 'contact_phone'
  | 'contact_email'
  | 'system_type'
  | 'survey_on'
  | 'site_verified'
  | 'design_files'
  | 'boq_lines'
  | 'proposal_ref'
  | 'proposal_on'
  | 'proposal_value'
  | 'proposal_accepted'
  | 'tender_ref'
  | 'tender_documents'
  | 'submission_deadline'
  | 'qualification_requirements'
  | 'bid_bond'
  | 'go_decision'
  | 'site_visit_on'
  | 'site_visit_minutes'
  | 'compliance_lines'
  | 'compliance_answered'
  | 'bid_price'
  | 'guarantee_details'
  | 'guarantee_issued'
  | 'submitted_on'
  | 'awarded'
  | 'guarantee_settled'
  | 'contract_ref'
  | 'contract_signed_on'
  | 'contract_value'
  | 'payment_terms'
  | 'contract_files'
  | 'customer_partner'
  | 'customer_city'
  | 'quotation_on'
  | 'quotation_value'
  | 'quotation_agreed'
  | 'financing_bank'
  | 'bank_approved'
  | 'bank_decided_on'
  | 'loan_amount'
  | 'loan_partially_paid'
  | 'loan_received'
  | 'installation_completed'
  | 'loan_fully_granted';

const blank = (value: string | null | undefined) => !value || !value.trim();
const positive = (value: string | null | undefined) => !blank(value) && parseDecimal(value as string, MONEY_SCALE) > 0n;
/** A bid bond of nothing is an answer (some tenders ask none); a blank is not. */
const answered = (value: string | null | undefined) => !blank(value) && parseDecimal(value as string, MONEY_SCALE) >= 0n;

/** The signed contract and its terms — the last gate of both workflows (§4). */
function contractMissing(facts: InitiationFacts): MissingCode[] {
  const missing: MissingCode[] = [];
  if (blank(facts.contractRef)) missing.push('contract_ref');
  if (blank(facts.contractSignedOn)) missing.push('contract_signed_on');
  if (!positive(facts.contractValueIqd)) missing.push('contract_value');
  if (blank(facts.paymentTerms)) missing.push('payment_terms');
  if (facts.files.initiation_contract === 0) missing.push('contract_files');
  // §6 of the blueprint: a lead may exist without an approved partner; a project may not.
  if (blank(facts.partnerId)) missing.push('customer_partner');
  return missing;
}

/**
 * What the record's current stage still lacks. At the last stage of either
 * workflow the gate is the contract's: passing it is what conversion asks.
 */
export function missingFor(facts: InitiationFacts): MissingCode[] {
  const missing: MissingCode[] = [];
  const need = (absent: boolean, code: MissingCode) => {
    if (absent) missing.push(code);
  };

  switch (facts.stage) {
    // 1 — "Record the initial contact, basic customer information, and lead source."
    case 'lead':
      need(blank(facts.title), 'title');
      need(blank(facts.customerName), 'customer_name');
      need(blank(facts.customerPhone), 'customer_phone');
      need(blank(facts.initialContactOn), 'initial_contact_on');
      need(blank(facts.leadSourceCode), 'lead_source');
      break;
    // 2 — the Pre-Sales Form: site, contact person, system type (the customer's documents are filed as they arrive).
    case 'pre_sales':
      need(blank(facts.siteLatitude) || blank(facts.siteLongitude), 'site_coordinates');
      need(blank(facts.siteGovernorate), 'site_governorate');
      need(blank(facts.siteArea), 'site_area');
      need(blank(facts.siteKind), 'site_kind');
      need(blank(facts.contactName), 'contact_name');
      need(blank(facts.contactJobTitle), 'contact_job_title');
      need(blank(facts.contactPhone), 'contact_phone');
      need(blank(facts.contactEmail), 'contact_email');
      need(blank(facts.systemType), 'system_type');
      break;
    // 3 — "Verify the site data and prepare the final SLD and layout."
    case 'site_survey':
      need(blank(facts.surveyOn), 'survey_on');
      need(!facts.siteVerified, 'site_verified');
      need(facts.files.initiation_design === 0, 'design_files');
      break;
    // 4 — the costs, line by line.
    case 'boq_costing':
      need(facts.boqLines === 0 || !positive(facts.boqTotalIqd), 'boq_lines');
      break;
    // 5 — the proposal the customer accepted.
    case 'proposal':
      need(blank(facts.proposalRef), 'proposal_ref');
      need(blank(facts.proposalOn), 'proposal_on');
      need(!positive(facts.proposalValueIqd), 'proposal_value');
      need(facts.proposalStatus !== 'accepted', 'proposal_accepted');
      break;
    case 'contract':
      missing.push(...contractMissing(facts));
      break;

    // 7 — "the issuing entity (Owner), tender reference number, and link to the tender documents (ITB/RFP)."
    case 'tender_lead':
      need(blank(facts.title), 'title');
      need(blank(facts.customerName), 'customer_name');
      need(blank(facts.tenderRef), 'tender_ref');
      need(blank(facts.tenderDocumentsUrl) && facts.files.initiation_tender_docs === 0, 'tender_documents');
      need(blank(facts.submissionDeadline), 'submission_deadline');
      break;
    // 8 — the requirements, the bid bond, and the approved decision to take part.
    case 'go_no_go':
      need(blank(facts.qualificationRequirements), 'qualification_requirements');
      need(!answered(facts.bidBondIqd), 'bid_bond');
      need(facts.goDecision !== 'go', 'go_decision');
      break;
    // 9 — the visit and its minutes (clarifications and addenda are logged as they come).
    case 'pre_bid':
      need(blank(facts.siteVisitOn), 'site_visit_on');
      need(blank(facts.siteVisitMinutes), 'site_visit_minutes');
      break;
    // 10 — "the approved designs and a Bill of Quantities."
    case 'tender_design':
      need(facts.files.initiation_design === 0, 'design_files');
      need(facts.boqLines === 0 || !positive(facts.boqTotalIqd), 'boq_lines');
      break;
    // 11 — the matrix answered, the price, the guarantee in hand where a bond is asked.
    case 'bidding': {
      need(facts.complianceLines === 0, 'compliance_lines');
      need(facts.complianceLines > 0 && facts.complianceUnanswered > 0, 'compliance_answered');
      need(!positive(facts.bidPriceIqd), 'bid_price');
      if (positive(facts.bidBondIqd)) {
        need(
          blank(facts.guaranteeBank) || blank(facts.guaranteeNo) || !positive(facts.guaranteeIqd) || blank(facts.guaranteeExpiresOn),
          'guarantee_details',
        );
        need(facts.guaranteeStatus !== 'issued', 'guarantee_issued');
      }
      break;
    }
    // 12 — submitted, awarded, the guarantee converted or released, and then the contract.
    case 'award':
      need(blank(facts.submittedOn), 'submitted_on');
      need(facts.awardStatus !== 'awarded' || blank(facts.awardedOn), 'awarded');
      if (positive(facts.bidBondIqd)) {
        need(facts.guaranteeStatus !== 'converted' && facts.guaranteeStatus !== 'released', 'guarantee_settled');
      }
      missing.push(...contractMissing(facts));
      break;

    // Financing 1 — "Customer Fields: Name, City, Phone number."
    case 'fin_customer':
      need(blank(facts.title), 'title');
      need(blank(facts.customerName), 'customer_name');
      need(blank(facts.customerCity), 'customer_city');
      need(blank(facts.customerPhone), 'customer_phone');
      break;
    // 2 — "Quotation sent: agreed / refused." It moves on agreed.
    case 'fin_quotation':
      need(blank(facts.proposalOn), 'quotation_on');
      need(!positive(facts.proposalValueIqd), 'quotation_value');
      need(facts.proposalStatus !== 'accepted', 'quotation_agreed');
      break;
    // 3 — "Bank Approval: approved / rejected." It moves on approved, with the loan the bank agreed.
    case 'fin_bank_approval':
      need(blank(facts.financingBank), 'financing_bank');
      need(facts.bankApprovalStatus !== 'approved', 'bank_approved');
      need(blank(facts.bankDecidedOn), 'bank_decided_on');
      need(!positive(facts.loanAmountIqd), 'loan_amount');
      break;
    // 4 — "Loan: partially paid / pending." It moves on once the first part is in.
    case 'fin_loan_first':
      need(facts.loanStatus !== 'partially_paid' && facts.loanStatus !== 'fully_granted', 'loan_partially_paid');
      need(!positive(facts.loanReceivedIqd) || blank(facts.loanFirstReceivedOn), 'loan_received');
      break;
    // 5 — "Installation: in progress / completed."
    case 'fin_installation':
      need(facts.installationStatus !== 'completed' || blank(facts.installationCompletedOn), 'installation_completed');
      break;
    // 6 — "Contract: signed / pending."
    case 'fin_contract':
      missing.push(...contractMissing(facts));
      break;
    // 7 — "Loan: fully granted / pending." Then the record becomes a project.
    case 'fin_loan_full':
      need(facts.loanStatus !== 'fully_granted' || blank(facts.loanFullyGrantedOn), 'loan_fully_granted');
      missing.push(...contractMissing(facts));
      break;
  }
  return missing;
}

/**
 * The sheet's outcome of a financing stage, as a code of
 * `admin.project_initiation.outcome.<code>` — what the stepper and the board
 * print under the stage.
 */
export function financingOutcome(stage: InitiationStage, facts: InitiationFacts): string | null {
  switch (stage) {
    case 'fin_customer':
      return blank(facts.customerCity) || blank(facts.customerPhone) ? 'pending' : 'recorded';
    case 'fin_quotation':
      return facts.proposalStatus === 'accepted' ? 'agreed' : facts.proposalStatus === 'rejected' ? 'refused' : facts.proposalOn ? 'sent' : 'pending';
    case 'fin_bank_approval':
      return facts.bankApprovalStatus === 'approved' ? 'approved' : facts.bankApprovalStatus === 'rejected' ? 'rejected' : 'pending';
    case 'fin_loan_first':
      return facts.loanStatus === 'partially_paid' || facts.loanStatus === 'fully_granted' ? 'partially_paid' : 'pending';
    case 'fin_installation':
      return facts.installationStatus === 'completed' ? 'completed' : facts.installationStatus === 'in_progress' ? 'in_progress' : 'pending';
    case 'fin_contract':
      return facts.contractSignedOn ? 'signed' : 'pending';
    case 'fin_loan_full':
      return facts.loanStatus === 'fully_granted' ? 'fully_granted' : 'pending';
    default:
      return null;
  }
}

/** Whether the record may be moved on, and to where. */
export function assertAdvance(facts: InitiationFacts): InitiationStage {
  if (facts.status !== 'open') {
    throw new InitiationRuleError(`The record is ${facts.status}; a decided record does not move again.`);
  }
  const to = nextStage(facts.kind, facts.stage);
  if (!to) {
    throw new InitiationRuleError('This is the last stage: the next step is the signed contract, which converts the record into a project.');
  }
  const missing = missingFor(facts);
  if (missing.length > 0) throw new InitiationGateError(facts.stage, missing);
  return to;
}

/** Whether the contract's conversion may happen now (§4). */
export function assertConvertible(facts: InitiationFacts): void {
  if (facts.status !== 'open') {
    throw new InitiationRuleError(`The record is ${facts.status}; it cannot be converted.`);
  }
  if (!isLastStage(facts.kind, facts.stage)) {
    throw new InitiationRuleError('The record becomes a project at contract signing — the last stage of its workflow. Complete the stages before it first.');
  }
  const missing = missingFor(facts);
  if (missing.length > 0) throw new InitiationGateError(facts.stage, missing);
}

/** A closed gate: the stage and what it still lacks, for the screen to say in the reader's language. */
export class InitiationGateError extends Error {
  readonly code = 'PROJECT_INITIATION_GATE';
  constructor(
    readonly stage: InitiationStage,
    readonly missing: readonly MissingCode[],
  ) {
    super(`Stage ${guideNumber(stage)} is not complete: ${missing.map((code) => code.replace(/_/g, ' ')).join(', ')}.`);
    this.name = 'InitiationGateError';
  }
}

/**
 * Who confirms the signed contract. The project it makes is released in the
 * same step, and the Project System releases a project only by somebody other
 * than whoever raised it (a super user alone excepted) — so the same holds
 * here, of whoever raised the initiation.
 */
export function assertSecondPerson(raisedBy: string, actor: { readonly userId: string; readonly isSuperUser: boolean }): void {
  if (raisedBy === actor.userId && !actor.isSuperUser) {
    throw new InitiationRuleError(
      'You raised this record, so somebody else confirms the signed contract. Confirming it releases the project and fixes its baseline.',
    );
  }
}

// ---------------------------------------------------------------------------
// Sections — the part of the record each stage fills
// ---------------------------------------------------------------------------

/**
 * A section is the form of one stage. The contract's is shared by both
 * workflows: it is the Direct Sales road's last stage, and the tender's last
 * stage (Submission & Award) ends with it — "so the contract can be signed".
 */
export const INITIATION_SECTIONS = [
  'lead',
  'pre_sales',
  'site_survey',
  'proposal',
  'tender_lead',
  'go_no_go',
  'pre_bid',
  'bidding',
  'award',
  'contract',
  'bank_approval',
  'loan',
  'installation',
] as const;
export type InitiationSection = (typeof INITIATION_SECTIONS)[number];

export function isInitiationSection(value: string): value is InitiationSection {
  return (INITIATION_SECTIONS as readonly string[]).includes(value);
}

/** The stage a section belongs to in a workflow, or null where that workflow has no such section. */
export function sectionStage(kind: InitiationKind, section: InitiationSection): InitiationStage | null {
  if (kind === 'financing') return FINANCING_SECTION_STAGE[section] ?? null;
  if (section === 'contract') return kind === 'direct_sales' ? 'contract' : 'award';
  return (stagesOf(kind) as readonly string[]).includes(section) ? (section as InitiationStage) : null;
}

/**
 * The financing road reuses the forms whose fields it shares — the lead's
 * customer, the proposal's columns as the quotation, the contract — and has
 * three of its own: the bank's approval, the loan (stages 4 and 7) and the
 * installation.
 */
const FINANCING_SECTION_STAGE: Partial<Record<InitiationSection, InitiationStage>> = {
  lead: 'fin_customer',
  proposal: 'fin_quotation',
  bank_approval: 'fin_bank_approval',
  loan: 'fin_loan_first',
  installation: 'fin_installation',
  contract: 'fin_contract',
};

/**
 * The stage at which the bill of quantities is written — and after which it is
 * the approved BOQ. A financed system is priced at its quotation.
 */
export function boqStage(kind: InitiationKind): InitiationStage {
  return kind === 'direct_sales' ? 'boq_costing' : kind === 'tender' ? 'tender_design' : 'fin_quotation';
}

/** Whether the record has reached a stage (it is the current one or behind it). */
export function hasReached(kind: InitiationKind, current: InitiationStage, stage: InitiationStage): boolean {
  const road = stagesOf(kind);
  return road.indexOf(stage) >= 0 && road.indexOf(stage) <= road.indexOf(current);
}

/**
 * Whether a section may be written now: the record is open and has reached the
 * section's stage. Stages are filled in order — a later stage's form opens
 * when the record gets there.
 */
export function sectionWritable(kind: InitiationKind, stage: InitiationStage, status: InitiationStatus, section: InitiationSection): boolean {
  if (status !== 'open') return false;
  const at = sectionStage(kind, section);
  return at !== null && hasReached(kind, stage, at);
}
