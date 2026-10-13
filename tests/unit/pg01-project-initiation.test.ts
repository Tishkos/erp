/**
 * The Project Guide (2026-10-12) — the pure rules of Project Initiation: the
 * two workflows in the guide's own order and numbering, the gate of every
 * stage, the bill of quantities' arithmetic, the site's coordinates, who may
 * confirm a contract, and that the migration's closed lists are this file's.
 * The halves that need no database.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AWARD_STATUSES,
  BOQ_CATEGORIES,
  COMPLIANCE_RESPONSES,
  DIRECT_SALES_STAGES,
  GUARANTEE_STATUSES,
  INITIATION_ACTIVITY_KINDS,
  INITIATION_FILE_SECTIONS,
  INITIATION_KINDS,
  INITIATION_SECTIONS,
  INITIATION_STAGES,
  INITIATION_STATUSES,
  InitiationGateError,
  PROPOSAL_STATUSES,
  SITE_KINDS,
  SYSTEM_TYPES,
  TENDER_STAGES,
  assertAdvance,
  assertConvertible,
  assertSecondPerson,
  boqLineAmount,
  boqStage,
  boqTotals,
  coordinate,
  firstStage,
  guideNumber,
  hasReached,
  initiationChip,
  isLastStage,
  missingFor,
  nextStage,
  sectionStage,
  sectionWritable,
  stageStates,
  stagesOf,
  type InitiationFacts,
  type InitiationFileSection,
} from '@/server/domain/project-initiation';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';

const noFiles = Object.fromEntries(INITIATION_FILE_SECTIONS.map((section) => [section, 0])) as Record<InitiationFileSection, number>;

/** A record with nothing on it, at the first stage of a direct sale. */
const empty: InitiationFacts = {
  kind: 'direct_sales',
  stage: 'lead',
  status: 'open',
  title: null,
  customerName: null,
  customerPhone: null,
  leadSourceCode: null,
  initialContactOn: null,
  partnerId: null,
  siteLatitude: null,
  siteLongitude: null,
  siteGovernorate: null,
  siteArea: null,
  siteKind: null,
  contactName: null,
  contactJobTitle: null,
  contactPhone: null,
  contactEmail: null,
  systemType: null,
  surveyOn: null,
  siteVerified: false,
  proposalRef: null,
  proposalOn: null,
  proposalValueIqd: null,
  proposalStatus: null,
  tenderRef: null,
  tenderDocumentsUrl: null,
  submissionDeadline: null,
  qualificationRequirements: null,
  bidBondIqd: null,
  goDecision: null,
  siteVisitOn: null,
  siteVisitMinutes: null,
  bidPriceIqd: null,
  guaranteeBank: null,
  guaranteeNo: null,
  guaranteeIqd: null,
  guaranteeExpiresOn: null,
  guaranteeStatus: null,
  submittedOn: null,
  awardStatus: null,
  awardedOn: null,
  contractRef: null,
  contractSignedOn: null,
  contractValueIqd: null,
  paymentTerms: null,
  boqLines: 0,
  boqTotalIqd: '0.0000',
  complianceLines: 0,
  complianceUnanswered: 0,
  files: noFiles,
};
const facts = (over: Partial<InitiationFacts>): InitiationFacts => ({ ...empty, ...over });
const contract = { contractRef: 'C-1', contractSignedOn: '2026-10-12', contractValueIqd: '1000.0000', paymentTerms: '30 % advance', partnerId: 'p', files: { ...noFiles, initiation_contract: 1 } };

describe('PG1 · the two workflows are the guide’s, in its order and numbering', () => {
  it('six stages each, numbered 1–6 and 7–12', () => {
    expect(INITIATION_KINDS).toEqual(['direct_sales', 'tender']);
    expect(DIRECT_SALES_STAGES).toEqual(['lead', 'pre_sales', 'site_survey', 'boq_costing', 'proposal', 'contract']);
    expect(TENDER_STAGES).toEqual(['tender_lead', 'go_no_go', 'pre_bid', 'tender_design', 'bidding', 'award']);
    expect(DIRECT_SALES_STAGES.map(guideNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(TENDER_STAGES.map(guideNumber)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(firstStage('direct_sales')).toBe('lead');
    expect(firstStage('tender')).toBe('tender_lead');
  });

  it('a stage is followed by the next of its own workflow, and the last by nothing', () => {
    expect(nextStage('direct_sales', 'lead')).toBe('pre_sales');
    expect(nextStage('direct_sales', 'proposal')).toBe('contract');
    expect(nextStage('direct_sales', 'contract')).toBeNull();
    expect(nextStage('tender', 'bidding')).toBe('award');
    expect(nextStage('tender', 'award')).toBeNull();
    expect(isLastStage('direct_sales', 'contract')).toBe(true);
    expect(isLastStage('tender', 'pre_bid')).toBe(false);
    // A direct sale is never at a tender's stage.
    expect(() => nextStage('direct_sales', 'go_no_go')).toThrow(/not a stage/);
  });

  it('the stepper: done behind, current here, pending ahead; all done once converted', () => {
    expect(stageStates('direct_sales', 'site_survey', 'open').map((step) => step.state)).toEqual(['done', 'done', 'current', 'pending', 'pending', 'pending']);
    expect(stageStates('tender', 'award', 'converted').every((step) => step.state === 'done')).toBe(true);
    expect(stageStates('tender', 'go_no_go', 'lost').map((step) => step.state)).toEqual(['done', 'current', 'pending', 'pending', 'pending', 'pending']);
    expect(initiationChip('open')).toBe('submitted');
    expect(initiationChip('converted')).toBe('approved');
    expect(initiationChip('lost')).toBe('rejected');
  });

  it('sections open as their stage is reached; the contract ends both roads', () => {
    expect(sectionStage('direct_sales', 'contract')).toBe('contract');
    expect(sectionStage('tender', 'contract')).toBe('award');
    expect(sectionStage('tender', 'pre_sales')).toBeNull();
    expect(sectionStage('direct_sales', 'bidding')).toBeNull();
    expect(boqStage('direct_sales')).toBe('boq_costing');
    expect(boqStage('tender')).toBe('tender_design');
    expect(hasReached('direct_sales', 'proposal', 'pre_sales')).toBe(true);
    expect(hasReached('direct_sales', 'pre_sales', 'proposal')).toBe(false);
    expect(sectionWritable('direct_sales', 'pre_sales', 'open', 'lead')).toBe(true);
    expect(sectionWritable('direct_sales', 'pre_sales', 'open', 'proposal')).toBe(false);
    expect(sectionWritable('direct_sales', 'contract', 'converted', 'contract')).toBe(false);
    expect(sectionWritable('tender', 'award', 'open', 'contract')).toBe(true);
    expect(sectionWritable('tender', 'bidding', 'open', 'contract')).toBe(false);
  });
});

describe('PG2 · Workflow One — what each Direct Sales stage holds before the record moves on', () => {
  it('1 Sales Lead: the initial contact, basic customer information and the lead source', () => {
    expect(missingFor(empty)).toEqual(['title', 'customer_name', 'customer_phone', 'initial_contact_on', 'lead_source']);
    const lead = facts({ title: 'Villa rooftop', customerName: 'Ahmed', customerPhone: '0770', initialContactOn: '2026-10-12', leadSourceCode: 'REFERRAL' });
    expect(missingFor(lead)).toEqual([]);
    expect(assertAdvance(lead)).toBe('pre_sales');
  });

  it('2 the Pre-Sales Form: site, contact person and system type', () => {
    const stage = facts({ stage: 'pre_sales' });
    expect(missingFor(stage)).toEqual([
      'site_coordinates',
      'site_governorate',
      'site_area',
      'site_kind',
      'contact_name',
      'contact_job_title',
      'contact_phone',
      'contact_email',
      'system_type',
    ]);
    // One coordinate is not a place.
    expect(missingFor(facts({ stage: 'pre_sales', siteLatitude: '33.3' }))).toContain('site_coordinates');
    const filled = facts({
      stage: 'pre_sales',
      siteLatitude: '33.312806',
      siteLongitude: '44.361488',
      siteGovernorate: 'Baghdad',
      siteArea: 'Karrada',
      siteKind: 'rooftop',
      contactName: 'Sara',
      contactJobTitle: 'Facilities manager',
      contactPhone: '0770',
      contactEmail: 'sara@example.com',
      systemType: 'hybrid',
    });
    expect(assertAdvance(filled)).toBe('site_survey');
  });

  it('3 Site Survey Design: verified, dated, and the SLD and layout on file', () => {
    expect(missingFor(facts({ stage: 'site_survey' }))).toEqual(['survey_on', 'site_verified', 'design_files']);
    expect(missingFor(facts({ stage: 'site_survey', surveyOn: '2026-10-12', siteVerified: true, files: { ...noFiles, initiation_design: 2 } }))).toEqual([]);
  });

  it('4 BOQ Costing: lines that cost something', () => {
    expect(missingFor(facts({ stage: 'boq_costing' }))).toEqual(['boq_lines']);
    expect(missingFor(facts({ stage: 'boq_costing', boqLines: 2, boqTotalIqd: '0.0000' }))).toEqual(['boq_lines']);
    expect(assertAdvance(facts({ stage: 'boq_costing', boqLines: 2, boqTotalIqd: '4500000.0000' }))).toBe('proposal');
  });

  it('5 Proposal Follow-up: only an accepted proposal goes to contract', () => {
    expect(missingFor(facts({ stage: 'proposal' }))).toEqual(['proposal_ref', 'proposal_on', 'proposal_value', 'proposal_accepted']);
    const sent = facts({ stage: 'proposal', proposalRef: 'Q-1', proposalOn: '2026-10-12', proposalValueIqd: '6000000', proposalStatus: 'sent' });
    expect(missingFor(sent)).toEqual(['proposal_accepted']);
    expect(() => assertAdvance(sent)).toThrow(InitiationGateError);
    expect(assertAdvance({ ...sent, proposalStatus: 'accepted' })).toBe('contract');
  });

  it('6 Contract Signing: the signed contract, its terms and an approved customer — then conversion, not another stage', () => {
    const stage = facts({ stage: 'contract' });
    expect(missingFor(stage)).toEqual(['contract_ref', 'contract_signed_on', 'contract_value', 'payment_terms', 'contract_files', 'customer_partner']);
    const signed = facts({ stage: 'contract', ...contract });
    expect(missingFor(signed)).toEqual([]);
    expect(() => assertAdvance(signed)).toThrow(/last stage/);
    expect(() => assertConvertible(signed)).not.toThrow();
    expect(() => assertConvertible(stage)).toThrow(InitiationGateError);
    // Conversion is the contract's and nowhere before it.
    expect(() => assertConvertible(facts({ stage: 'proposal', ...contract }))).toThrow(/contract signing/);
    expect(() => assertConvertible({ ...signed, status: 'lost' })).toThrow(/lost/);
  });
});

describe('PG3 · Workflow Two — the tender pipeline’s gates', () => {
  const tender = (over: Partial<InitiationFacts>) => facts({ kind: 'tender', stage: 'tender_lead', ...over });

  it('7 Tender Lead: the owner, the reference, the documents (a link or an upload) and the deadline', () => {
    expect(missingFor(tender({}))).toEqual(['title', 'customer_name', 'tender_ref', 'tender_documents', 'submission_deadline']);
    const base = { title: '5 MW plant', customerName: 'Ministry of Electricity', tenderRef: 'MOE/2026/14', submissionDeadline: '2026-11-30' };
    expect(missingFor(tender({ ...base, tenderDocumentsUrl: 'https://example.gov/itb.pdf' }))).toEqual([]);
    expect(missingFor(tender({ ...base, files: { ...noFiles, initiation_tender_docs: 1 } }))).toEqual([]);
    expect(missingFor(tender(base))).toEqual(['tender_documents']);
  });

  it('8 Go / No-Go: requirements, the bid bond (nothing is an answer, a blank is not) and an approved Go', () => {
    expect(missingFor(tender({ stage: 'go_no_go' }))).toEqual(['qualification_requirements', 'bid_bond', 'go_decision']);
    expect(missingFor(tender({ stage: 'go_no_go', qualificationRequirements: 'Class A', bidBondIqd: '0', goDecision: 'go' }))).toEqual([]);
    expect(missingFor(tender({ stage: 'go_no_go', qualificationRequirements: 'Class A', bidBondIqd: '50000000', goDecision: 'no_go' }))).toEqual(['go_decision']);
  });

  it('9 Site Visit & Pre-Bid Meeting: the visit and its minutes', () => {
    expect(missingFor(tender({ stage: 'pre_bid' }))).toEqual(['site_visit_on', 'site_visit_minutes']);
  });

  it('10 Tender Design BOQ: the approved designs and the bill of quantities', () => {
    expect(missingFor(tender({ stage: 'tender_design' }))).toEqual(['design_files', 'boq_lines']);
    expect(missingFor(tender({ stage: 'tender_design', boqLines: 3, boqTotalIqd: '900.0000', files: { ...noFiles, initiation_design: 1 } }))).toEqual([]);
  });

  it('11 Compliance Matrix & Bidding: every line answered, a price, and the guarantee in hand where a bond is asked', () => {
    expect(missingFor(tender({ stage: 'bidding' }))).toEqual(['compliance_lines', 'bid_price']);
    expect(missingFor(tender({ stage: 'bidding', complianceLines: 4, complianceUnanswered: 1, bidPriceIqd: '100' }))).toEqual(['compliance_answered']);
    // No bond asked: no guarantee asked either.
    expect(missingFor(tender({ stage: 'bidding', complianceLines: 4, bidPriceIqd: '100', bidBondIqd: '0' }))).toEqual([]);
    const bonded = tender({ stage: 'bidding', complianceLines: 4, bidPriceIqd: '100', bidBondIqd: '5000' });
    expect(missingFor(bonded)).toEqual(['guarantee_details', 'guarantee_issued']);
    const issued = { ...bonded, guaranteeBank: 'TBI', guaranteeNo: 'LG-1', guaranteeIqd: '5000', guaranteeExpiresOn: '2027-01-31', guaranteeStatus: 'issued' };
    expect(missingFor(issued)).toEqual([]);
    expect(assertAdvance(issued)).toBe('award');
  });

  it('12 Submission & Award: submitted, awarded, the guarantee converted or released — and the contract', () => {
    const stage = tender({ stage: 'award', bidBondIqd: '5000', guaranteeStatus: 'issued' });
    expect(missingFor(stage)).toEqual([
      'submitted_on',
      'awarded',
      'guarantee_settled',
      'contract_ref',
      'contract_signed_on',
      'contract_value',
      'payment_terms',
      'contract_files',
      'customer_partner',
    ]);
    const won = tender({ stage: 'award', bidBondIqd: '5000', guaranteeStatus: 'converted', submittedOn: '2026-11-29', awardStatus: 'awarded', awardedOn: '2026-12-20', ...contract });
    expect(missingFor(won)).toEqual([]);
    expect(() => assertConvertible(won)).not.toThrow();
    // Awarded with no date is not yet an award on record.
    expect(missingFor({ ...won, awardedOn: null })).toEqual(['awarded']);
    expect(missingFor({ ...won, awardStatus: 'not_awarded' })).toEqual(['awarded']);
  });

  it('a decided record does not move', () => {
    expect(() => assertAdvance(tender({ status: 'lost' }))).toThrow(/decided record/);
  });
});

describe('PG4 · the bill of quantities and the site', () => {
  it('a line is quantity × unit cost, half up at the money scale; the three costs add to the total', () => {
    expect(boqLineAmount('10', '1250.5')).toBe(125_050_000n);
    expect(boqLineAmount('0.333333', '100')).toBe(333_333n);
    // 3 × 0.33335 = 1.00005 → 1.0001 (half up), never truncated.
    expect(boqLineAmount('3', '0.3334')).toBe(10_002n);
    expect(() => boqLineAmount('0', '5')).toThrow(/above zero/);
    expect(() => boqLineAmount('1', '-5')).toThrow(/negative/);
    const totals = boqTotals([
      { category: 'material', amountIqd: '4000000.0000' },
      { category: 'material', amountIqd: '250000.5000' },
      { category: 'shipping', amountIqd: '300000.0000' },
      { category: 'installation', amountIqd: '450000.2500' },
    ]);
    expect(totals).toEqual({ material: '4250000.5000', shipping: '300000.0000', installation: '450000.2500', total: '5000000.7500', lines: 4 });
    expect(boqTotals([]).total).toBe('0.0000');
    expect(() => boqTotals([{ category: 'tax', amountIqd: '1' }])).toThrow(/not a BOQ cost/);
  });

  it('coordinates are decimal degrees within the globe, kept to six places', () => {
    expect(coordinate('33.312806', 'latitude')).toBe('33.312806');
    expect(coordinate(' 44.3615 ', 'longitude')).toBe('44.361500');
    expect(coordinate('-12.5', 'latitude')).toBe('-12.500000');
    expect(coordinate('33.31280699', 'latitude')).toBe('33.312806');
    expect(coordinate('', 'latitude')).toBeNull();
    expect(() => coordinate('91', 'latitude')).toThrow(/between -90 and 90/);
    expect(() => coordinate('181', 'longitude')).toThrow(/between -180 and 180/);
    expect(() => coordinate('33°18′', 'latitude')).toThrow(/decimal degrees/);
  });
});

describe('PG5 · the conversion point: somebody else confirms the contract', () => {
  it('whoever raised the record does not confirm it — a super user alone excepted', () => {
    expect(() => assertSecondPerson('a', { userId: 'a', isSuperUser: false })).toThrow(/somebody else/);
    expect(() => assertSecondPerson('a', { userId: 'b', isSuperUser: false })).not.toThrow();
    expect(() => assertSecondPerson('a', { userId: 'a', isSuperUser: true })).not.toThrow();
  });
});

describe('PG6 · the migration and the catalogues say what this file says', () => {
  const sql = readFileSync('src/server/db/migrations/0421_project_initiation.sql', 'utf8');
  const listed = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

  it('migration 0421 holds the same closed lists', () => {
    expect(sql).toContain(`ARRAY[${listed(DIRECT_SALES_STAGES)}]`);
    expect(sql).toContain(`ARRAY[${listed(TENDER_STAGES)}]`);
    expect(sql).toContain(`"kind" IN (${listed(INITIATION_KINDS)})`);
    expect(sql).toContain(`"status" IN (${listed(INITIATION_STATUSES)})`);
    expect(sql).toContain(`"site_kind" IN (${listed(SITE_KINDS)})`);
    expect(sql).toContain(`"system_type" IN (${listed(SYSTEM_TYPES)})`);
    expect(sql).toContain(`"proposal_status" IN (${listed(PROPOSAL_STATUSES)})`);
    expect(sql).toContain(`"guarantee_status" IN (${listed(GUARANTEE_STATUSES)})`);
    expect(sql).toContain(`"award_status" IN (${listed(AWARD_STATUSES)})`);
    expect(sql).toContain(`"category" IN (${listed(BOQ_CATEGORIES)})`);
    expect(sql).toContain(`"response" IN (${listed(COMPLIANCE_RESPONSES)})`);
    expect(sql).toContain(listed(INITIATION_ACTIVITY_KINDS));
  });

  it('every code a screen shows has its label in both languages', () => {
    for (const [locale, catalogue] of [
      ['en', en],
      ['ar', ar],
    ] as const) {
      const x = (catalogue as unknown as { admin: { project_initiation: Record<string, Record<string, string>> } }).admin.project_initiation;
      const has = (group: string, codes: readonly string[]) => {
        for (const code of codes) expect(x[group]?.[code], `${locale}: ${group}.${code}`).toBeTruthy();
      };
      has('kind_option', INITIATION_KINDS);
      has('kind_about', INITIATION_KINDS);
      has('stage', INITIATION_STAGES);
      has('section', INITIATION_SECTIONS);
      has('status', INITIATION_STATUSES);
      has('site_kind_option', SITE_KINDS);
      has('system_type_option', SYSTEM_TYPES);
      has('proposal_status_option', PROPOSAL_STATUSES);
      has('guarantee_status_option', GUARANTEE_STATUSES);
      has('award_status_option', AWARD_STATUSES);
      has('boq_category_option', BOQ_CATEGORIES);
      has('compliance_response_option', COMPLIANCE_RESPONSES);
      has('activity_kind_option', INITIATION_ACTIVITY_KINDS);
      has('go_decision_option', ['go', 'no_go']);
      has('file_section', ['project_initiation', ...INITIATION_FILE_SECTIONS]);
      // Every gate can be said: a missing code with no words would print as its code.
      const everyMissing = new Set<string>();
      for (const kind of INITIATION_KINDS) {
        for (const stage of stagesOf(kind)) {
          for (const code of missingFor(facts({ kind, stage, bidBondIqd: '1', complianceLines: 1, complianceUnanswered: 1 }))) everyMissing.add(code);
        }
      }
      everyMissing.add('compliance_lines');
      has('missing', [...everyMissing]);
      // The seeded lead sources read by the Sales Lead form.
      const seeded = [...sql.matchAll(/\('([A-Z_]+)',\s+'[^']+'\)/g)].map((match) => match[1]!);
      expect(seeded.length).toBeGreaterThanOrEqual(9);
      has('lead_source_option', seeded);
    }
  });
});
