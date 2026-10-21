/**
 * Project Initiation — the company's Project Guide (2026-10-12, by direction:
 * "we need our project follow the project guides").
 *
 * The only writer of `project_initiation` and its lines. A record is opened
 * with the guide's Main Project Initiation Selector — a Direct Sales project
 * or a Tender project — and walked through its workflow one stage at a time:
 * each stage's form is saved here (`saveSection`), its bill of quantities,
 * compliance matrix and follow-up activities beside it, and `advance` moves
 * the record on only when the stage's gate is open
 * (`domain/project-initiation.missingFor`). A tender's decision to take part is
 * `decideGo`. At contract signing `convert` makes the project through the
 * Project System's own service, releases it (so it is an Active Project), and
 * the record names it — the Pre-Sales Form, the drawings and the approved BOQ
 * are then read from here by the project's page, never copied.
 *
 * Nothing here posts, commits stock or creates an obligation. Every change is
 * an audit row on the record (`project_initiation`, by its number).
 *
 * It calls `project-system.ts`, which calls `projects.ts`; neither calls back,
 * so the grant's name is a literal here as in the other project services.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  businessPartner,
  item,
  leadSource,
  project,
  projectInitiation,
  projectInitiationActivity,
  projectInitiationBoqLine,
  projectInitiationComplianceLine,
  projectType,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import {
  AWARD_STATUSES,
  BANK_APPROVAL_STATUSES,
  BOQ_CATEGORIES,
  COMPLIANCE_RESPONSES,
  GUARANTEE_STATUSES,
  INITIATION_ACTIVITY_KINDS,
  INITIATION_FILE_SECTIONS,
  INSTALLATION_STATUSES,
  InitiationGateError,
  InitiationRuleError,
  LEAD_STAGES,
  LOAN_STATUSES,
  PROPOSAL_STATUSES,
  QUOTATION_STATUSES,
  QUANTITY_SCALE,
  SITE_KINDS,
  SYSTEM_TYPES,
  assertAdvance,
  assertConvertible,
  assertSecondPerson,
  boqLineAmount,
  boqStage,
  boqTotals,
  coordinate,
  financingOutcome,
  firstStage,
  isInitiationKind,
  isInitiationSection,
  isLastStage,
  missingFor,
  nextStage,
  phaseOf,
  sectionWritable,
  stageStates,
  type InitiationFacts,
  type InitiationFileSection,
  type InitiationKind,
  type InitiationSection,
  type InitiationStage,
  type InitiationStatus,
  type PipelinePhase,
} from '../domain/project-initiation';
import type { ActorContext } from './chart-of-accounts';
import * as attachments from './attachments';
import * as audit from './audit';
import * as authz from './authorization';
import { allocateDocumentNumber } from './numbering';
import * as ps from './project-system';
import { registerPage, searchOf, type RegisterPaging } from './register-page';

/** The Project System's grant: whoever keeps projects keeps what comes before them. */
export const PERMISSION_OBJECT = 'project';
/** The audit object, the notes' and the paperclip's: the record, by its number. */
export const DOCUMENT_TYPE = 'project_initiation';
const SERIES = 'PROJECT_INITIATION';

/** The project type each workflow's contract becomes (0421's two seeded types, 0424's third). */
export const PROJECT_TYPE_OF: Readonly<Record<InitiationKind, string>> = { direct_sales: 'DIRECT_SALES', tender: 'TENDER', financing: 'FINANCING' };

export class InitiationNotFoundError extends Error {
  readonly code = 'PROJECT_INITIATION_NOT_FOUND';
  constructor(ref: string) {
    super(`No project initiation '${ref}', or it is outside the branches you may see.`);
    this.name = 'InitiationNotFoundError';
  }
}

export { InitiationGateError, InitiationRuleError };

type Row = typeof projectInitiation.$inferSelect;

// ---------------------------------------------------------------------------
// Reading what was typed
// ---------------------------------------------------------------------------

const clean = (value: string | null | undefined) => (value ?? '').trim();

function words(value: string | null | undefined, label: string, max = 200): string | null {
  const text = clean(value);
  if (!text) return null;
  if (text.length > max) throw new InitiationRuleError(`The ${label} is longer than ${max} characters.`);
  return text;
}

function day(value: string | null | undefined, label: string): string | null {
  const text = clean(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new InitiationRuleError(`The ${label} '${text}' is not a date.`);
  }
  return text;
}

/** An amount as typed ("3,500.00"), kept at the money scale; null when blank. */
function amount(value: string | null | undefined, label: string): string | null {
  const text = clean(value).replace(/[,\s]/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(text)) throw new InitiationRuleError(`The ${label} '${clean(value)}' is not an amount.`);
  return toDecimalString(parseDecimal(text, MONEY_SCALE), MONEY_SCALE);
}

function choice<T extends string>(value: string | null | undefined, allowed: readonly T[], label: string): T | null {
  const text = clean(value);
  if (!text) return null;
  if (!(allowed as readonly string[]).includes(text)) throw new InitiationRuleError(`'${text}' is not a ${label}.`);
  return text as T;
}

function email(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  if (text.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new InitiationRuleError(`'${text}' is not an email address.`);
  return text;
}

/** A link to the tender documents: an http(s) address and nothing else. */
function link(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  if (text.length > 500 || !/^https?:\/\/[^\s]+$/i.test(text)) {
    throw new InitiationRuleError('The link to the tender documents must be a web address beginning with http:// or https://.');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadByNo(tx: Tx, initiationNo: string): Promise<Row> {
  const [row] = await tx.select().from(projectInitiation).where(eq(projectInitiation.initiationNo, initiationNo)).limit(1);
  if (!row) throw new InitiationNotFoundError(initiationNo);
  return row;
}

/** HD9 — locked for a change, so two submits serialise and the second sees the first. */
async function lockByNo(tx: Tx, initiationNo: string): Promise<Row> {
  const [row] = await tx.select().from(projectInitiation).where(eq(projectInitiation.initiationNo, initiationNo)).for('update');
  if (!row) throw new InitiationNotFoundError(initiationNo);
  return row;
}

function assertOpen(row: Row): void {
  if (row.status !== 'open') {
    throw new InitiationRuleError(`${row.initiationNo} is ${row.status}; a decided record does not change again.`);
  }
}

async function may(ctx: ActorContext, verb: 'create' | 'edit_draft' | 'approve', row: { branchCode: string; initiationNo?: string }): Promise<void> {
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.initiationNo ?? null,
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

async function record(
  tx: Tx,
  ctx: ActorContext,
  row: { initiationNo: string; branchCode: string },
  action: string,
  detail: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; reason?: string | null } = {},
): Promise<void> {
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `project_initiation.${action}`,
    objectType: DOCUMENT_TYPE,
    objectId: row.initiationNo,
    branchCode: row.branchCode,
    before: detail.before ?? null,
    after: detail.after ?? null,
    reason: detail.reason ?? null,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/** An approved customer in use — the only kind a project is contracted to (§6). */
async function customerOf(tx: Tx, partnerId: string) {
  const [partner] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName, isCustomer: businessPartner.isCustomer, status: businessPartner.status, active: businessPartner.active })
    .from(businessPartner)
    .where(eq(businessPartner.id, partnerId))
    .limit(1);
  if (!partner) throw new InitiationRuleError('That customer does not exist. Choose one from the Customers list.');
  if (!partner.isCustomer) throw new InitiationRuleError(`${partner.code} is not a customer.`);
  if (partner.status !== 'active' || !partner.active) {
    throw new InitiationRuleError(`${partner.code} is not an approved customer in use. Approve it on its page under Customers first.`);
  }
  return partner;
}

async function leadSourceOf(tx: Tx, code: string) {
  const [row] = await tx.select().from(leadSource).where(eq(leadSource.code, code)).limit(1);
  if (!row || row.active !== 'true') throw new InitiationRuleError(`'${code}' is not a lead source in use.`);
  return row;
}

async function activeUser(tx: Tx, userId: string, label: string) {
  const [row] = await tx.select({ id: appUser.id, isActive: appUser.isActive, name: appUser.displayName }).from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!row || !row.isActive) throw new InitiationRuleError(`The ${label} names no active user.`);
  return row;
}

// ---------------------------------------------------------------------------
// What a gate reads
// ---------------------------------------------------------------------------

/** How many current files each section holds; the sections are kept under the record's number. */
export async function fileCounts(tx: Tx, initiationNo: string): Promise<Record<InitiationFileSection, number>> {
  const counts = Object.fromEntries(INITIATION_FILE_SECTIONS.map((section) => [section, 0])) as Record<InitiationFileSection, number>;
  for (const section of INITIATION_FILE_SECTIONS) {
    counts[section] = (await attachments.currentFor(tx, section, initiationNo)).length;
  }
  return counts;
}

async function boqOf(tx: Tx, initiationId: string) {
  return tx.select().from(projectInitiationBoqLine).where(eq(projectInitiationBoqLine.initiationId, initiationId)).orderBy(asc(projectInitiationBoqLine.lineNo));
}

async function complianceOf(tx: Tx, initiationId: string) {
  return tx
    .select()
    .from(projectInitiationComplianceLine)
    .where(eq(projectInitiationComplianceLine.initiationId, initiationId))
    .orderBy(asc(projectInitiationComplianceLine.lineNo));
}

async function factsOf(tx: Tx, row: Row): Promise<InitiationFacts> {
  const boq = await boqOf(tx, row.id);
  const compliance = await complianceOf(tx, row.id);
  return {
    kind: row.kind as InitiationKind,
    stage: row.stage as InitiationStage,
    status: row.status as InitiationStatus,
    title: row.title,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerCity: row.customerCity,
    leadSourceCode: row.leadSourceCode,
    initialContactOn: row.initialContactOn,
    partnerId: row.partnerId,
    siteLatitude: row.siteLatitude,
    siteLongitude: row.siteLongitude,
    siteGovernorate: row.siteGovernorate,
    siteArea: row.siteArea,
    siteKind: row.siteKind,
    contactName: row.contactName,
    contactJobTitle: row.contactJobTitle,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    systemType: row.systemType,
    surveyOn: row.surveyOn,
    siteVerified: row.siteVerified,
    proposalRef: row.proposalRef,
    proposalOn: row.proposalOn,
    proposalValueIqd: row.proposalValueIqd,
    proposalStatus: row.proposalStatus,
    tenderRef: row.tenderRef,
    tenderDocumentsUrl: row.tenderDocumentsUrl,
    submissionDeadline: row.submissionDeadline,
    qualificationRequirements: row.qualificationRequirements,
    bidBondIqd: row.bidBondIqd,
    goDecision: row.goDecision,
    siteVisitOn: row.siteVisitOn,
    siteVisitMinutes: row.siteVisitMinutes,
    bidPriceIqd: row.bidPriceIqd,
    guaranteeBank: row.guaranteeBank,
    guaranteeNo: row.guaranteeNo,
    guaranteeIqd: row.guaranteeIqd,
    guaranteeExpiresOn: row.guaranteeExpiresOn,
    guaranteeStatus: row.guaranteeStatus,
    submittedOn: row.submittedOn,
    awardStatus: row.awardStatus,
    awardedOn: row.awardedOn,
    contractRef: row.contractRef,
    contractSignedOn: row.contractSignedOn,
    contractValueIqd: row.contractValueIqd,
    paymentTerms: row.paymentTerms,
    financingBank: row.financingBank,
    bankApprovalStatus: row.bankApprovalStatus,
    bankDecidedOn: row.bankDecidedOn,
    loanAmountIqd: row.loanAmountIqd,
    loanStatus: row.loanStatus,
    loanReceivedIqd: row.loanReceivedIqd,
    loanFirstReceivedOn: row.loanFirstReceivedOn,
    loanFullyGrantedOn: row.loanFullyGrantedOn,
    installationStatus: row.installationStatus,
    installationCompletedOn: row.installationCompletedOn,
    boqLines: boq.length,
    boqTotalIqd: boqTotals(boq).total,
    complianceLines: compliance.length,
    complianceUnanswered: compliance.filter((line) => !line.response).length,
    files: await fileCounts(tx, row.initiationNo),
  };
}

// ---------------------------------------------------------------------------
// §1 — the Main Project Initiation Selector: a new record
// ---------------------------------------------------------------------------

export interface CreateInput {
  readonly kind: string;
  readonly title: string;
  /** The customer as first heard of; a tender's issuing entity. */
  readonly customerName: string;
  /** Optional on every road; the financing road's first stage asks both. */
  readonly customerPhone?: string | null;
  readonly customerCity?: string | null;
  readonly branchCode?: string | null;
  readonly ownerUserId?: string | null;
}

/** Opens a record at the first stage of the chosen workflow. */
export async function create(tx: Tx, ctx: ActorContext, input: CreateInput): Promise<{ id: string; initiationNo: string }> {
  const branchCode = clean(input.branchCode) || ctx.branchCode;
  await may(ctx, 'create', { branchCode });
  const kind = clean(input.kind);
  if (!isInitiationKind(kind)) {
    throw new InitiationRuleError('Choose the project type first: a Direct Sales project, a Tender project or a Financed customer.');
  }
  const customerPhone = words(input.customerPhone, 'customer phone', 40);
  const customerCity = words(input.customerCity, 'city', 80);
  const title = words(input.title, 'project name');
  if (!title) throw new InitiationRuleError('The project name is required.');
  const customerName = words(input.customerName, kind === 'tender' ? 'issuing entity' : 'customer name');
  if (!customerName) throw new InitiationRuleError(kind === 'tender' ? 'The issuing entity (owner) is required.' : 'The customer name is required.');
  const ownerUserId = clean(input.ownerUserId) || ctx.principal.userId;
  await activeUser(tx, ownerUserId, 'owner');

  const today = businessToday();
  const allocated = await allocateDocumentNumber(tx, SERIES, { branchCode, year: Number(today.slice(0, 4)) }, ctx.principal.userId);
  const stage = firstStage(kind);
  const [created] = await tx
    .insert(projectInitiation)
    .values({
      initiationNo: allocated.documentNo,
      kind,
      stage,
      status: 'open',
      title,
      branchCode,
      ownerUserId,
      customerName,
      customerPhone,
      customerCity,
      // The day the record is opened is the first contact until somebody says otherwise.
      initialContactOn: kind === 'tender' ? null : today,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectInitiation.id });
  await record(tx, ctx, { initiationNo: allocated.documentNo, branchCode }, 'created', {
    after: { initiationNo: allocated.documentNo, kind, stage, title, customerName, customerPhone, customerCity },
  });
  return { id: created!.id, initiationNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// The stages' forms
// ---------------------------------------------------------------------------

/** What a section's form may send; anything it does not send is left as it was. */
export interface SectionInput {
  readonly title?: string | null;
  readonly customerName?: string | null;
  readonly customerPhone?: string | null;
  readonly initialContactOn?: string | null;
  readonly leadSourceCode?: string | null;
  readonly leadNote?: string | null;
  readonly partnerId?: string | null;

  readonly siteLatitude?: string | null;
  readonly siteLongitude?: string | null;
  readonly siteGovernorate?: string | null;
  readonly siteArea?: string | null;
  readonly siteKind?: string | null;
  readonly contactName?: string | null;
  readonly contactJobTitle?: string | null;
  readonly contactPhone?: string | null;
  readonly contactPhoneAlt?: string | null;
  readonly contactEmail?: string | null;
  readonly systemType?: string | null;

  readonly surveyOn?: string | null;
  readonly siteVerified?: boolean;
  readonly surveyNote?: string | null;

  readonly proposalRef?: string | null;
  readonly proposalOn?: string | null;
  readonly proposalValueIqd?: string | null;
  readonly proposalStatus?: string | null;

  readonly tenderRef?: string | null;
  readonly tenderDocumentsUrl?: string | null;
  readonly submissionDeadline?: string | null;
  readonly qualificationRequirements?: string | null;
  readonly bidBondIqd?: string | null;
  readonly siteVisitOn?: string | null;
  readonly siteVisitMinutes?: string | null;
  readonly clarifications?: string | null;
  readonly bidPriceIqd?: string | null;
  readonly guaranteeBank?: string | null;
  readonly guaranteeNo?: string | null;
  readonly guaranteeIqd?: string | null;
  readonly guaranteeExpiresOn?: string | null;
  readonly guaranteeStatus?: string | null;
  readonly submittedOn?: string | null;
  readonly submissionRef?: string | null;
  readonly awardStatus?: string | null;
  readonly awardedOn?: string | null;

  readonly contractRef?: string | null;
  readonly contractSignedOn?: string | null;
  readonly contractValueIqd?: string | null;
  readonly paymentTerms?: string | null;

  readonly customerCity?: string | null;
  readonly financingBank?: string | null;
  readonly financingBankRef?: string | null;
  readonly bankApprovalStatus?: string | null;
  readonly bankDecidedOn?: string | null;
  readonly loanAmountIqd?: string | null;
  readonly loanStatus?: string | null;
  readonly loanReceivedIqd?: string | null;
  readonly loanFirstReceivedOn?: string | null;
  readonly loanFullyGrantedOn?: string | null;
  readonly installationStatus?: string | null;
  readonly installationStartedOn?: string | null;
  readonly installationCompletedOn?: string | null;
  readonly installationNote?: string | null;
}

type Patch = Partial<typeof projectInitiation.$inferInsert>;

/** One section's fields, read and checked. A field the form did not send is not in the patch. */
async function patchFor(tx: Tx, kind: InitiationKind, section: InitiationSection, input: SectionInput): Promise<Patch> {
  const patch: Patch = {};
  const has = <K extends keyof SectionInput>(key: K) => input[key] !== undefined;
  const partner = async () => {
    if (!has('partnerId')) return;
    const id = clean(input.partnerId);
    patch.partnerId = id ? (await customerOf(tx, id)).id : null;
  };

  switch (section) {
    case 'lead':
      if (has('title')) {
        const title = words(input.title, 'project name');
        if (!title) throw new InitiationRuleError('The project name is required.');
        patch.title = title;
      }
      if (has('customerName')) {
        const name = words(input.customerName, 'customer name');
        if (!name) throw new InitiationRuleError('The customer name is required.');
        patch.customerName = name;
      }
      if (has('customerPhone')) patch.customerPhone = words(input.customerPhone, 'customer phone', 40);
      if (has('customerCity')) patch.customerCity = words(input.customerCity, 'city', 80);
      if (has('initialContactOn')) patch.initialContactOn = day(input.initialContactOn, 'initial contact date');
      if (has('leadSourceCode')) {
        const code = clean(input.leadSourceCode);
        patch.leadSourceCode = code ? (await leadSourceOf(tx, code)).code : null;
      }
      if (has('leadNote')) patch.leadNote = words(input.leadNote, 'note', 2000);
      await partner();
      break;

    case 'pre_sales':
      if (has('siteLatitude')) patch.siteLatitude = coordinate(input.siteLatitude, 'latitude');
      if (has('siteLongitude')) patch.siteLongitude = coordinate(input.siteLongitude, 'longitude');
      if (has('siteGovernorate')) patch.siteGovernorate = words(input.siteGovernorate, 'governorate', 80);
      if (has('siteArea')) patch.siteArea = words(input.siteArea, 'area', 120);
      if (has('siteKind')) patch.siteKind = choice(input.siteKind, SITE_KINDS, 'site type (land or rooftop)');
      if (has('contactName')) patch.contactName = words(input.contactName, 'contact person', 120);
      if (has('contactJobTitle')) patch.contactJobTitle = words(input.contactJobTitle, 'job title', 120);
      if (has('contactPhone')) patch.contactPhone = words(input.contactPhone, 'phone', 40);
      if (has('contactPhoneAlt')) patch.contactPhoneAlt = words(input.contactPhoneAlt, 'second phone', 40);
      if (has('contactEmail')) patch.contactEmail = email(input.contactEmail);
      if (has('systemType')) patch.systemType = choice(input.systemType, SYSTEM_TYPES, 'system type');
      break;

    case 'site_survey':
      if (has('surveyOn')) patch.surveyOn = day(input.surveyOn, 'survey date');
      if (input.siteVerified !== undefined) patch.siteVerified = input.siteVerified;
      if (has('surveyNote')) patch.surveyNote = words(input.surveyNote, 'survey note', 2000);
      break;

    case 'proposal':
      if (has('proposalRef')) patch.proposalRef = words(input.proposalRef, 'proposal reference', 80);
      if (has('proposalOn')) patch.proposalOn = day(input.proposalOn, 'proposal date');
      if (has('proposalValueIqd')) patch.proposalValueIqd = amount(input.proposalValueIqd, 'proposal value');
      if (has('proposalStatus')) {
        patch.proposalStatus =
          kind === 'financing'
            ? choice(input.proposalStatus, QUOTATION_STATUSES, 'quotation status (sent, agreed or refused)')
            : choice(input.proposalStatus, PROPOSAL_STATUSES, 'proposal status');
      }
      break;

    case 'bank_approval':
      if (has('financingBank')) patch.financingBank = words(input.financingBank, 'bank', 120);
      if (has('financingBankRef')) patch.financingBankRef = words(input.financingBankRef, 'bank reference', 80);
      if (has('bankApprovalStatus')) patch.bankApprovalStatus = choice(input.bankApprovalStatus, BANK_APPROVAL_STATUSES, 'bank answer (pending, approved or rejected)');
      if (has('bankDecidedOn')) patch.bankDecidedOn = day(input.bankDecidedOn, 'bank decision date');
      if (has('loanAmountIqd')) patch.loanAmountIqd = amount(input.loanAmountIqd, 'loan amount');
      break;

    case 'loan':
      if (has('loanStatus')) patch.loanStatus = choice(input.loanStatus, LOAN_STATUSES, 'loan status (pending, partially paid or fully granted)');
      if (has('loanReceivedIqd')) patch.loanReceivedIqd = amount(input.loanReceivedIqd, 'loan received');
      if (has('loanFirstReceivedOn')) patch.loanFirstReceivedOn = day(input.loanFirstReceivedOn, 'first payment date');
      if (has('loanFullyGrantedOn')) patch.loanFullyGrantedOn = day(input.loanFullyGrantedOn, 'fully granted date');
      break;

    case 'installation':
      if (has('installationStatus')) patch.installationStatus = choice(input.installationStatus, INSTALLATION_STATUSES, 'installation status');
      if (has('installationStartedOn')) patch.installationStartedOn = day(input.installationStartedOn, 'installation start date');
      if (has('installationCompletedOn')) patch.installationCompletedOn = day(input.installationCompletedOn, 'installation completion date');
      if (has('installationNote')) patch.installationNote = words(input.installationNote, 'installation note', 2000);
      break;

    case 'tender_lead':
      if (has('title')) {
        const title = words(input.title, 'project name');
        if (!title) throw new InitiationRuleError('The project name is required.');
        patch.title = title;
      }
      if (has('customerName')) {
        const name = words(input.customerName, 'issuing entity');
        if (!name) throw new InitiationRuleError('The issuing entity (owner) is required.');
        patch.customerName = name;
      }
      if (has('tenderRef')) patch.tenderRef = words(input.tenderRef, 'tender reference number', 80);
      if (has('tenderDocumentsUrl')) patch.tenderDocumentsUrl = link(input.tenderDocumentsUrl);
      if (has('submissionDeadline')) patch.submissionDeadline = day(input.submissionDeadline, 'submission deadline');
      await partner();
      break;

    case 'go_no_go':
      if (has('qualificationRequirements')) patch.qualificationRequirements = words(input.qualificationRequirements, 'qualification requirements', 4000);
      if (has('bidBondIqd')) patch.bidBondIqd = amount(input.bidBondIqd, 'bid bond amount');
      break;

    case 'pre_bid':
      if (has('siteVisitOn')) patch.siteVisitOn = day(input.siteVisitOn, 'site visit date');
      if (has('siteVisitMinutes')) patch.siteVisitMinutes = words(input.siteVisitMinutes, 'site visit minutes', 4000);
      if (has('clarifications')) patch.clarifications = words(input.clarifications, 'technical clarifications', 4000);
      break;

    case 'bidding':
      if (has('bidPriceIqd')) patch.bidPriceIqd = amount(input.bidPriceIqd, 'bid price');
      if (has('guaranteeBank')) patch.guaranteeBank = words(input.guaranteeBank, 'guarantee bank', 120);
      if (has('guaranteeNo')) patch.guaranteeNo = words(input.guaranteeNo, 'guarantee number', 80);
      if (has('guaranteeIqd')) patch.guaranteeIqd = amount(input.guaranteeIqd, 'guarantee amount');
      if (has('guaranteeExpiresOn')) patch.guaranteeExpiresOn = day(input.guaranteeExpiresOn, 'guarantee expiry date');
      if (has('guaranteeStatus')) patch.guaranteeStatus = choice(input.guaranteeStatus, GUARANTEE_STATUSES, 'guarantee status');
      break;

    case 'award':
      if (has('submittedOn')) patch.submittedOn = day(input.submittedOn, 'submission date');
      if (has('submissionRef')) patch.submissionRef = words(input.submissionRef, 'submission reference', 80);
      if (has('awardStatus')) patch.awardStatus = choice(input.awardStatus, AWARD_STATUSES, 'award status');
      if (has('awardedOn')) patch.awardedOn = day(input.awardedOn, 'award date');
      if (has('guaranteeStatus')) patch.guaranteeStatus = choice(input.guaranteeStatus, GUARANTEE_STATUSES, 'guarantee status');
      break;

    case 'contract':
      if (has('contractRef')) patch.contractRef = words(input.contractRef, 'contract reference', 80);
      if (has('contractSignedOn')) patch.contractSignedOn = day(input.contractSignedOn, 'signing date');
      if (has('contractValueIqd')) patch.contractValueIqd = amount(input.contractValueIqd, 'contract value');
      if (has('paymentTerms')) patch.paymentTerms = words(input.paymentTerms, 'payment terms', 2000);
      await partner();
      break;
  }
  return patch;
}

/** Saves one stage's form. The stage must have been reached, and the record must be open. */
export async function saveSection(tx: Tx, ctx: ActorContext, initiationNo: string, section: string, input: SectionInput): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertOpen(row);
  if (!isInitiationSection(section)) throw new InitiationRuleError(`'${section}' is not a part of the record.`);
  const kind = row.kind as InitiationKind;
  if (!sectionWritable(kind, row.stage as InitiationStage, row.status as InitiationStatus, section)) {
    throw new InitiationRuleError(`${row.initiationNo} has not reached that stage yet. Stages are completed in order, one at a time.`);
  }
  const patch = await patchFor(tx, kind, section, input);
  if (patch.awardedOn && patch.submittedOn && patch.awardedOn < patch.submittedOn) {
    throw new InitiationRuleError('The award cannot be dated before the submission.');
  }
  // What the bank has paid out never exceeds what it agreed to lend (0424 holds it too).
  const lent = patch.loanAmountIqd !== undefined ? patch.loanAmountIqd : row.loanAmountIqd;
  const received = patch.loanReceivedIqd !== undefined ? patch.loanReceivedIqd : row.loanReceivedIqd;
  if (lent && received && parseDecimal(received, MONEY_SCALE) > parseDecimal(lent, MONEY_SCALE)) {
    throw new InitiationRuleError('The loan received is more than the loan the bank approved.');
  }
  if (patch.loanStatus === 'fully_granted' && lent && parseDecimal(received ?? '0', MONEY_SCALE) < parseDecimal(lent, MONEY_SCALE)) {
    throw new InitiationRuleError('The loan is fully granted only once all of it is received: raise Loan received to the approved amount.');
  }
  const startedOn = patch.installationStartedOn !== undefined ? patch.installationStartedOn : row.installationStartedOn;
  const completedOn = patch.installationCompletedOn !== undefined ? patch.installationCompletedOn : row.installationCompletedOn;
  if (startedOn && completedOn && completedOn < startedOn) {
    throw new InitiationRuleError('The installation cannot be completed before it started.');
  }
  const keys = Object.keys(patch) as (keyof Patch)[];
  const changed = keys.filter((key) => (row as Record<string, unknown>)[key] !== patch[key]);
  if (changed.length === 0) return;
  await tx
    .update(projectInitiation)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projectInitiation.id, row.id));
  await record(tx, ctx, row, `${section}_saved`, {
    before: Object.fromEntries(changed.map((key) => [key, (row as Record<string, unknown>)[key] ?? null])),
    after: Object.fromEntries(changed.map((key) => [key, patch[key] ?? null])),
  });
}

// ---------------------------------------------------------------------------
// The bill of quantities — written at its stage, approved by leaving it
// ---------------------------------------------------------------------------

function assertBoqOpen(row: Row): void {
  assertOpen(row);
  const kind = row.kind as InitiationKind;
  if (row.stage !== boqStage(kind)) {
    throw new InitiationRuleError(
      row.boqApprovedAt
        ? `The BOQ of ${row.initiationNo} is approved; it no longer changes.`
        : `${row.initiationNo} has not reached its BOQ stage yet.`,
    );
  }
}

export interface BoqLineInput {
  readonly category: string;
  readonly description: string;
  readonly itemCode?: string | null;
  readonly quantity: string;
  readonly unit?: string | null;
  readonly unitCostIqd: string;
}

export async function addBoqLine(tx: Tx, ctx: ActorContext, initiationNo: string, input: BoqLineInput): Promise<{ lineNo: number }> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertBoqOpen(row);
  const category = choice(input.category, BOQ_CATEGORIES, 'BOQ cost (material, shipping or installation)');
  if (!category) throw new InitiationRuleError('Choose what the line costs: material, shipping or installation.');
  const itemCode = clean(input.itemCode) || null;
  let description = words(input.description, 'description', 300);
  let unit = words(input.unit, 'unit', 20);
  if (itemCode) {
    const [found] = await tx.select({ code: item.code, name: item.name, baseUomCode: item.baseUomCode }).from(item).where(eq(item.code, itemCode)).limit(1);
    if (!found) throw new InitiationRuleError(`'${itemCode}' is not an item of the catalogue.`);
    description = description ?? found.name;
    unit = unit ?? found.baseUomCode;
  }
  if (!description) throw new InitiationRuleError('A BOQ line needs a description, or an item to take it from.');
  const quantityText = clean(input.quantity).replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,6})?$/.test(quantityText)) throw new InitiationRuleError(`The quantity '${clean(input.quantity)}' is not a number.`);
  const quantity = toDecimalString(parseDecimal(quantityText, QUANTITY_SCALE), QUANTITY_SCALE);
  const unitCostIqd = amount(input.unitCostIqd, 'unit cost');
  if (unitCostIqd === null) throw new InitiationRuleError('A BOQ line needs a unit cost.');
  const amountIqd = toDecimalString(boqLineAmount(quantity, unitCostIqd), MONEY_SCALE);

  const [last] = await tx
    .select({ lineNo: sql<number>`coalesce(max(${projectInitiationBoqLine.lineNo}), 0)::int` })
    .from(projectInitiationBoqLine)
    .where(eq(projectInitiationBoqLine.initiationId, row.id));
  const lineNo = (last?.lineNo ?? 0) + 1;
  await tx.insert(projectInitiationBoqLine).values({
    initiationId: row.id,
    lineNo,
    category,
    itemCode,
    description,
    quantity,
    unit,
    unitCostIqd,
    amountIqd,
    createdBy: ctx.principal.userId,
  });
  await record(tx, ctx, row, 'boq_line_added', { after: { lineNo, category, itemCode, description, quantity, unit, unitCostIqd, amountIqd } });
  return { lineNo };
}

export async function removeBoqLine(tx: Tx, ctx: ActorContext, initiationNo: string, lineId: string): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertBoqOpen(row);
  const [line] = await tx
    .select()
    .from(projectInitiationBoqLine)
    .where(and(eq(projectInitiationBoqLine.id, lineId), eq(projectInitiationBoqLine.initiationId, row.id)))
    .limit(1);
  if (!line) throw new InitiationRuleError('That BOQ line is not on this record.');
  await tx.delete(projectInitiationBoqLine).where(eq(projectInitiationBoqLine.id, line.id));
  await record(tx, ctx, row, 'boq_line_removed', {
    before: { lineNo: line.lineNo, category: line.category, description: line.description, quantity: line.quantity, unitCostIqd: line.unitCostIqd, amountIqd: line.amountIqd },
  });
}

// ---------------------------------------------------------------------------
// The tender's Compliance Matrix — written at Compliance Matrix & Bidding
// ---------------------------------------------------------------------------

function assertComplianceOpen(row: Row): void {
  assertOpen(row);
  if (row.kind !== 'tender') throw new InitiationRuleError('Only a tender carries a compliance matrix.');
  if (row.stage !== 'bidding') {
    throw new InitiationRuleError(`The compliance matrix of ${row.initiationNo} is written at Compliance Matrix & Bidding.`);
  }
}

export async function addComplianceLine(
  tx: Tx,
  ctx: ActorContext,
  initiationNo: string,
  input: { clause?: string | null; requirement: string; response?: string | null; remark?: string | null },
): Promise<{ lineNo: number }> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertComplianceOpen(row);
  const requirement = words(input.requirement, 'requirement', 600);
  if (!requirement) throw new InitiationRuleError('A compliance line names the requirement it answers.');
  const clause = words(input.clause, 'clause', 60);
  const response = choice(input.response, COMPLIANCE_RESPONSES, 'compliance answer');
  const remark = words(input.remark, 'remark', 600);
  const [last] = await tx
    .select({ lineNo: sql<number>`coalesce(max(${projectInitiationComplianceLine.lineNo}), 0)::int` })
    .from(projectInitiationComplianceLine)
    .where(eq(projectInitiationComplianceLine.initiationId, row.id));
  const lineNo = (last?.lineNo ?? 0) + 1;
  await tx.insert(projectInitiationComplianceLine).values({ initiationId: row.id, lineNo, clause, requirement, response, remark, createdBy: ctx.principal.userId });
  await record(tx, ctx, row, 'compliance_line_added', { after: { lineNo, clause, requirement, response, remark } });
  return { lineNo };
}

export async function answerComplianceLine(
  tx: Tx,
  ctx: ActorContext,
  initiationNo: string,
  lineId: string,
  input: { response: string; remark?: string | null },
): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertComplianceOpen(row);
  const [line] = await tx
    .select()
    .from(projectInitiationComplianceLine)
    .where(and(eq(projectInitiationComplianceLine.id, lineId), eq(projectInitiationComplianceLine.initiationId, row.id)))
    .limit(1);
  if (!line) throw new InitiationRuleError('That compliance line is not on this record.');
  const response = choice(input.response, COMPLIANCE_RESPONSES, 'compliance answer');
  if (!response) throw new InitiationRuleError('Choose the answer: compliant, partially compliant, not compliant or not applicable.');
  const remark = input.remark === undefined ? line.remark : words(input.remark, 'remark', 600);
  await tx.update(projectInitiationComplianceLine).set({ response, remark, updatedAt: new Date() }).where(eq(projectInitiationComplianceLine.id, line.id));
  await record(tx, ctx, row, 'compliance_line_answered', {
    before: { lineNo: line.lineNo, response: line.response, remark: line.remark },
    after: { lineNo: line.lineNo, response, remark },
  });
}

export async function removeComplianceLine(tx: Tx, ctx: ActorContext, initiationNo: string, lineId: string): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertComplianceOpen(row);
  const [line] = await tx
    .select()
    .from(projectInitiationComplianceLine)
    .where(and(eq(projectInitiationComplianceLine.id, lineId), eq(projectInitiationComplianceLine.initiationId, row.id)))
    .limit(1);
  if (!line) throw new InitiationRuleError('That compliance line is not on this record.');
  await tx.delete(projectInitiationComplianceLine).where(eq(projectInitiationComplianceLine.id, line.id));
  await record(tx, ctx, row, 'compliance_line_removed', { before: { lineNo: line.lineNo, clause: line.clause, requirement: line.requirement, response: line.response } });
}

// ---------------------------------------------------------------------------
// Follow-up activities — append-only
// ---------------------------------------------------------------------------

export async function logActivity(
  tx: Tx,
  ctx: ActorContext,
  initiationNo: string,
  input: { kind: string; happenedOn?: string | null; summary: string; nextAction?: string | null; nextActionOn?: string | null },
): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertOpen(row);
  const kind = choice(input.kind, INITIATION_ACTIVITY_KINDS, 'kind of activity');
  if (!kind) throw new InitiationRuleError('Choose the kind of activity.');
  const summary = words(input.summary, 'summary', 2000);
  if (!summary) throw new InitiationRuleError('An activity says what happened.');
  const happenedOn = day(input.happenedOn, 'date') ?? businessToday();
  if (happenedOn > businessToday()) throw new InitiationRuleError('An activity is recorded once it has happened; plan the next one under Next action.');
  const nextAction = words(input.nextAction, 'next action', 300);
  const nextActionOn = day(input.nextActionOn, 'next action date');
  await tx.insert(projectInitiationActivity).values({
    initiationId: row.id,
    kind,
    stage: row.stage,
    happenedOn,
    summary,
    nextAction,
    nextActionOn,
    createdBy: ctx.principal.userId,
  });
  // The record was updated: the live pages and the board follow `updated_at`.
  await tx.update(projectInitiation).set({ updatedAt: new Date() }).where(eq(projectInitiation.id, row.id));
  await record(tx, ctx, row, 'activity_logged', { after: { kind, stage: row.stage, happenedOn, summary, nextAction, nextActionOn } });
}

// ---------------------------------------------------------------------------
// Moving on
// ---------------------------------------------------------------------------

/** One stage forward, when the current stage holds what the guide asks of it. */
export async function advance(tx: Tx, ctx: ActorContext, initiationNo: string): Promise<{ stage: InitiationStage }> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  const facts = await factsOf(tx, row);
  const to = assertAdvance(facts);
  const leavesBoq = row.stage === boqStage(row.kind as InitiationKind);
  const now = new Date();
  await tx
    .update(projectInitiation)
    .set({
      stage: to,
      ...(leavesBoq ? { boqApprovedBy: ctx.principal.userId, boqApprovedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(projectInitiation.id, row.id));
  await record(tx, ctx, row, 'stage_advanced', {
    before: { stage: row.stage },
    after: { stage: to, ...(leavesBoq ? { boqApproved: true, boqTotalIqd: facts.boqTotalIqd } : {}) },
  });
  return { stage: to };
}

/**
 * §3 step 8 — "approve the decision to participate". Go lets the tender move
 * on (with its requirements and bid bond recorded); No-Go ends it, and the
 * note is why.
 */
export async function decideGo(tx: Tx, ctx: ActorContext, initiationNo: string, input: { decision: string; note?: string | null }): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'approve', row);
  assertOpen(row);
  if (row.kind !== 'tender' || row.stage !== 'go_no_go') {
    throw new InitiationRuleError(`${row.initiationNo} is not at Feasibility Review and Tender Qualification (Go / No-Go).`);
  }
  const decision = clean(input.decision);
  if (decision !== 'go' && decision !== 'no_go') throw new InitiationRuleError('The decision is Go or No-Go.');
  const note = words(input.note, 'note', 1000);
  const now = new Date();
  if (decision === 'no_go') {
    if (!note) throw new InitiationRuleError('A No-Go says why the company will not take part.');
    await tx
      .update(projectInitiation)
      .set({ goDecision: 'no_go', goDecidedBy: ctx.principal.userId, goDecidedAt: now, goNote: note, status: 'lost', lostReason: note, lostBy: ctx.principal.userId, lostAt: now, updatedAt: now })
      .where(eq(projectInitiation.id, row.id));
    await record(tx, ctx, row, 'no_go', { before: { status: row.status, goDecision: row.goDecision }, after: { status: 'lost', goDecision: 'no_go' }, reason: note });
    return;
  }
  await tx
    .update(projectInitiation)
    .set({ goDecision: 'go', goDecidedBy: ctx.principal.userId, goDecidedAt: now, goNote: note, updatedAt: now })
    .where(eq(projectInitiation.id, row.id));
  await record(tx, ctx, row, 'go', { before: { goDecision: row.goDecision }, after: { goDecision: 'go' }, reason: note });
}

/** Lost at any stage, with its reason: a proposal refused, a tender not awarded, a customer gone quiet. */
export async function markLost(tx: Tx, ctx: ActorContext, initiationNo: string, reason: string): Promise<void> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'edit_draft', row);
  assertOpen(row);
  const why = words(reason, 'reason', 1000);
  if (!why) throw new InitiationRuleError('A lost record says why — it is how the company learns why it loses.');
  const now = new Date();
  await tx
    .update(projectInitiation)
    .set({ status: 'lost', lostReason: why, lostBy: ctx.principal.userId, lostAt: now, updatedAt: now })
    .where(eq(projectInitiation.id, row.id));
  await record(tx, ctx, row, 'lost', { before: { status: row.status, stage: row.stage }, after: { status: 'lost', stage: row.stage }, reason: why });
}

// ---------------------------------------------------------------------------
// §4 — the conversion point: the signed contract becomes an Active Project
// ---------------------------------------------------------------------------

export interface ConvertInput {
  readonly managerUserId: string;
  readonly baselineStartsOn: string;
  readonly baselineEndsOn: string;
  readonly departmentCode?: string | null;
  readonly billingMethod?: string | null;
  readonly retentionPercent?: string | null;
  readonly advanceRecoveryPercent?: string | null;
  /** Typed when the company already names the project; allocated otherwise. */
  readonly projectCode?: string | null;
}

const BILLING_METHODS = ['milestone', 'progress', 'time_and_material', 'lump_sum'] as const;

/**
 * Confirms the signed contract. The project is made by the Project System's
 * own service — raised by whoever raised this record, confirmed and released
 * by the caller, who holds `approve` and is somebody else (a super user alone
 * excepted) — with the contract's value, the approved BOQ's total as its
 * baseline budget and the dates given; then this record is closed as
 * converted and names it. One transaction: a refusal leaves nothing behind.
 */
export async function convert(tx: Tx, ctx: ActorContext, initiationNo: string, input: ConvertInput): Promise<{ projectCode: string }> {
  const row = await lockByNo(tx, initiationNo);
  await may(ctx, 'approve', row);
  assertOpen(row);
  const facts = await factsOf(tx, row);
  assertConvertible(facts);
  assertSecondPerson(row.createdBy, ctx.principal);

  const customer = await customerOf(tx, row.partnerId!);
  const manager = await activeUser(tx, clean(input.managerUserId), 'project manager');
  const startsOn = day(input.baselineStartsOn, 'start date');
  const endsOn = day(input.baselineEndsOn, 'finish date');
  if (!startsOn || !endsOn) throw new InitiationRuleError('The project needs its start and finish dates: they are its baseline.');
  if (endsOn < startsOn) throw new InitiationRuleError('The finish date is before the start date.');
  const billingMethod = choice(input.billingMethod, BILLING_METHODS, 'billing method');

  const kind = row.kind as InitiationKind;
  // The project is the initiation's, in the initiation's branch — whichever branch the caller is working in.
  const inBranch: ActorContext = { ...ctx, branchCode: row.branchCode };
  const { projectCode } = await ps.createDefinition(tx, inBranch, {
    code: clean(input.projectCode) || null,
    name: row.title,
    typeCode: PROJECT_TYPE_OF[kind],
    customerId: customer.id,
    branchCode: row.branchCode,
    managerUserId: manager.id,
    departmentCode: clean(input.departmentCode) || null,
    contractValueIqd: row.contractValueIqd,
    // The approved BOQ is the budget the project starts with.
    baselineBudgetIqd: facts.boqTotalIqd,
    baselineStartsOn: startsOn,
    baselineEndsOn: endsOn,
    ...(billingMethod ? { billingMethod } : {}),
    retentionPercent: clean(input.retentionPercent) || null,
    advanceRecoveryPercent: clean(input.advanceRecoveryPercent) || null,
    raisedByUserId: row.createdBy,
  });
  // "Automatically converted into an Active Project": released in the same step.
  await ps.release(tx, inBranch, projectCode);

  const now = new Date();
  await tx
    .update(projectInitiation)
    .set({ status: 'converted', projectCode, convertedBy: ctx.principal.userId, convertedAt: now, updatedAt: now })
    .where(eq(projectInitiation.id, row.id));
  await record(tx, ctx, row, 'converted', {
    before: { status: row.status },
    after: {
      status: 'converted',
      projectCode,
      customer: customer.code,
      contractRef: row.contractRef,
      contractSignedOn: row.contractSignedOn,
      contractValueIqd: row.contractValueIqd,
      baselineBudgetIqd: facts.boqTotalIqd,
    },
  });
  // The project's own history says where it came from.
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.initiated_from',
    objectType: PERMISSION_OBJECT,
    objectId: projectCode,
    branchCode: row.branchCode,
    after: { initiationNo: row.initiationNo, kind },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return { projectCode };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListFilter extends RegisterPaging {
  readonly kind?: string | null;
  readonly stage?: string | null;
  readonly status?: string | null;
  readonly search?: string | null;
  /** Leads, Opportunities or Projects — the three screens over the same records. */
  readonly phase?: PipelinePhase | null;
}

/** The SQL of `domain › phaseOf`: change the two together. */
function phaseWhere(phase: PipelinePhase | null | undefined) {
  if (!phase) return undefined;
  if (phase === 'project') return eq(projectInitiation.status, 'converted');
  const leadStages = sql.join(LEAD_STAGES.map((stage) => sql`${stage}`), sql`, `);
  return phase === 'lead'
    ? sql`${projectInitiation.status} <> 'converted' and ${projectInitiation.stage} in (${leadStages})`
    : sql`${projectInitiation.status} <> 'converted' and ${projectInitiation.stage} not in (${leadStages})`;
}

export async function list(tx: Tx, filter: ListFilter = {}) {
  const term = searchOf(
    [
      projectInitiation.initiationNo,
      projectInitiation.title,
      projectInitiation.customerName,
      projectInitiation.customerPhone,
      projectInitiation.customerCity,
      projectInitiation.tenderRef,
      projectInitiation.projectCode,
      businessPartner.legalName,
    ],
    filter.search,
  );
  const where = and(
    filter.kind ? eq(projectInitiation.kind, filter.kind) : undefined,
    filter.stage ? eq(projectInitiation.stage, filter.stage) : undefined,
    filter.status ? eq(projectInitiation.status, filter.status) : undefined,
    phaseWhere(filter.phase),
    term ?? undefined,
  );
  return registerPage({
    paging: filter,
    count: async () => {
      const [row] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(projectInitiation)
        .leftJoin(businessPartner, eq(businessPartner.id, projectInitiation.partnerId))
        .where(where);
      return row?.total ?? 0;
    },
    rows: ({ limit, offset }) =>
      tx
        .select({
          id: projectInitiation.id,
          initiationNo: projectInitiation.initiationNo,
          kind: projectInitiation.kind,
          stage: projectInitiation.stage,
          status: projectInitiation.status,
          title: projectInitiation.title,
          customerName: projectInitiation.customerName,
          customerCode: businessPartner.code,
          ownerName: appUser.displayName,
          branchCode: projectInitiation.branchCode,
          submissionDeadline: projectInitiation.submissionDeadline,
          contractValueIqd: projectInitiation.contractValueIqd,
          proposalValueIqd: projectInitiation.proposalValueIqd,
          bidPriceIqd: projectInitiation.bidPriceIqd,
          projectCode: projectInitiation.projectCode,
          customerCity: projectInitiation.customerCity,
          loanAmountIqd: projectInitiation.loanAmountIqd,
          createdAt: projectInitiation.createdAt,
          updatedAt: projectInitiation.updatedAt,
        })
        .from(projectInitiation)
        .leftJoin(businessPartner, eq(businessPartner.id, projectInitiation.partnerId))
        .leftJoin(appUser, eq(appUser.id, projectInitiation.ownerUserId))
        .where(where)
        // What moved last comes first: the pipeline is watched, not filed.
        .orderBy(desc(projectInitiation.updatedAt), desc(projectInitiation.initiationNo))
        .limit(limit)
        .offset(offset),
  });
}

// ---------------------------------------------------------------------------
// The live board and the updates — "live updates tracking, each with its own code"
// ---------------------------------------------------------------------------

/** Cards on the board: the open records and what was decided in the last month. */
const BOARD_LIMIT = 400;

export interface BoardCard {
  readonly initiationNo: string;
  readonly kind: InitiationKind;
  readonly stage: InitiationStage;
  readonly status: InitiationStatus;
  readonly phase: PipelinePhase;
  readonly title: string;
  readonly customerName: string;
  readonly customerCity: string | null;
  readonly ownerName: string | null;
  readonly valueIqd: string | null;
  readonly projectCode: string | null;
  readonly updatedAt: Date;
}

/**
 * Every open record, and those converted or lost in the last thirty days, as
 * cards. With a road chosen the screen lays them out by its stages; without,
 * by phase (Leads, Opportunities, Projects, Lost).
 */
export async function board(tx: Tx, filter: { readonly kind?: InitiationKind | null; readonly ownerUserId?: string | null } = {}): Promise<{ cards: BoardCard[]; truncated: boolean }> {
  const rows = await tx
    .select({
      initiationNo: projectInitiation.initiationNo,
      kind: projectInitiation.kind,
      stage: projectInitiation.stage,
      status: projectInitiation.status,
      title: projectInitiation.title,
      customerName: projectInitiation.customerName,
      customerCity: projectInitiation.customerCity,
      ownerName: appUser.displayName,
      contractValueIqd: projectInitiation.contractValueIqd,
      proposalValueIqd: projectInitiation.proposalValueIqd,
      bidPriceIqd: projectInitiation.bidPriceIqd,
      projectCode: projectInitiation.projectCode,
      updatedAt: projectInitiation.updatedAt,
    })
    .from(projectInitiation)
    .leftJoin(appUser, eq(appUser.id, projectInitiation.ownerUserId))
    .where(
      and(
        filter.kind ? eq(projectInitiation.kind, filter.kind) : undefined,
        filter.ownerUserId ? eq(projectInitiation.ownerUserId, filter.ownerUserId) : undefined,
        sql`(${projectInitiation.status} = 'open' or ${projectInitiation.updatedAt} > now() - interval '30 days')`,
      ),
    )
    .orderBy(desc(projectInitiation.updatedAt))
    .limit(BOARD_LIMIT + 1);
  return {
    truncated: rows.length > BOARD_LIMIT,
    cards: rows.slice(0, BOARD_LIMIT).map((r) => ({
      initiationNo: r.initiationNo,
      kind: r.kind as InitiationKind,
      stage: r.stage as InitiationStage,
      status: r.status as InitiationStatus,
      phase: phaseOf(r.stage as InitiationStage, r.status as InitiationStatus),
      title: r.title,
      customerName: r.customerName,
      customerCity: r.customerCity,
      ownerName: r.ownerName,
      valueIqd: r.contractValueIqd ?? r.proposalValueIqd ?? r.bidPriceIqd,
      projectCode: r.projectCode,
      updatedAt: r.updatedAt,
    })),
  };
}

/**
 * A number that moves whenever anything the reader can see moves — the record
 * (`updated_at`, which every write of this service stamps) and its own audit
 * rows (a note is one). The live pages ask it every few seconds and redraw only when
 * it changed. Row security scopes it to the reader's branches.
 */
export async function liveVersion(tx: Tx, initiationNo?: string | null): Promise<string> {
  if (initiationNo) {
    const result = await tx.execute(sql`
      select greatest(
               (select max(updated_at) from project_initiation where initiation_no = ${initiationNo}),
               (select max(occurred_at) from audit_event where object_type = ${DOCUMENT_TYPE} and object_id = ${initiationNo})
             ) as at
    `);
    const at = (result.rows[0] as { at: Date | string | null } | undefined)?.at;
    return at ? new Date(at).toISOString() : '0';
  }
  const [row] = await tx
    .select({ at: sql<string | null>`max(${projectInitiation.updatedAt})::text`, count: sql<number>`count(*)::int` })
    .from(projectInitiation);
  return `${row?.at ?? '0'}|${row?.count ?? 0}`;
}

/** One line of a record's updates, newest first: what moved, who moved it, when. */
export interface TimelineEntry {
  readonly at: Date;
  readonly actor: string | null;
  /** The audit action without its `project_initiation.` prefix: `stage_advanced`, `bank_approval_saved`, … */
  readonly action: string;
  readonly stage: string | null;
  /** The codes of the fields a section's save changed, and the new value of each closed-list one. */
  readonly changed: readonly { readonly field: string; readonly value: string | null }[];
  readonly reason: string | null;
}

/** The fields whose new value the updates say in words (each a closed list on the screen). */
const SAID_FIELDS: ReadonlySet<string> = new Set([
  'stage',
  'status',
  'proposalStatus',
  'bankApprovalStatus',
  'loanStatus',
  'installationStatus',
  'awardStatus',
  'guaranteeStatus',
  'goDecision',
  'systemType',
]);

/** The record's updates: every audited change of it, read back as lines. */
export async function timeline(tx: Tx, initiationNo: string, limit = 100): Promise<TimelineEntry[]> {
  const rows = await audit.timelineWithAttachments(tx, DOCUMENT_TYPE, initiationNo, limit);
  const actorIds = [...new Set(rows.map((r) => r.actor_user_id as string | null).filter((id): id is string => Boolean(id)))];
  const people = actorIds.length
    ? await tx
        .select({ id: appUser.id, name: appUser.displayName })
        .from(appUser)
        .where(sql`${appUser.id} in (${sql.join(actorIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  return rows
    .filter((r) => r.outcome === 'success')
    .map((r) => {
      const after = (r.after_value ?? {}) as Record<string, unknown>;
      const objectType = r.object_type as string | undefined;
      const action = objectType === 'attachment' ? 'file' : String(r.action).replace(/^project_initiation\./, '');
      const changed = Object.entries(after)
        .filter(([field]) => action.endsWith('_saved') || SAID_FIELDS.has(field))
        .map(([field, value]) => ({ field, value: SAID_FIELDS.has(field) && typeof value === 'string' ? value : null }));
      return {
        at: new Date(r.occurred_at as string | Date),
        actor: people.find((p) => p.id === r.actor_user_id)?.name ?? null,
        action,
        stage: typeof after.stage === 'string' ? after.stage : null,
        changed: action === 'stage_advanced' || action === 'created' ? [] : changed,
        reason: (r.reason as string | null) ?? (typeof after.note === 'string' ? after.note : null),
      };
    });
}

async function viewOf(tx: Tx, row: Row) {
  const boq = await boqOf(tx, row.id);
  const compliance = await complianceOf(tx, row.id);
  const activities = await tx
    .select({
      id: projectInitiationActivity.id,
      kind: projectInitiationActivity.kind,
      stage: projectInitiationActivity.stage,
      happenedOn: projectInitiationActivity.happenedOn,
      summary: projectInitiationActivity.summary,
      nextAction: projectInitiationActivity.nextAction,
      nextActionOn: projectInitiationActivity.nextActionOn,
      createdAt: projectInitiationActivity.createdAt,
      byName: appUser.displayName,
    })
    .from(projectInitiationActivity)
    .leftJoin(appUser, eq(appUser.id, projectInitiationActivity.createdBy))
    .where(eq(projectInitiationActivity.initiationId, row.id))
    .orderBy(desc(projectInitiationActivity.happenedOn), desc(projectInitiationActivity.createdAt));
  const [customer] = row.partnerId
    ? await tx.select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName }).from(businessPartner).where(eq(businessPartner.id, row.partnerId)).limit(1)
    : [];
  const [source] = row.leadSourceCode ? await tx.select().from(leadSource).where(eq(leadSource.code, row.leadSourceCode)).limit(1) : [];
  const [became] = row.projectCode
    ? await tx.select({ code: project.code, name: project.name, status: project.status }).from(project).where(eq(project.code, row.projectCode)).limit(1)
    : [];
  const ids = [row.ownerUserId, row.createdBy, row.boqApprovedBy, row.goDecidedBy, row.convertedBy, row.lostBy].filter((id): id is string => Boolean(id));
  const people = ids.length
    ? await tx
        .select({ id: appUser.id, name: appUser.displayName })
        .from(appUser)
        .where(sql`${appUser.id} in (${sql.join([...new Set(ids)].map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const nameOf = (id: string | null) => people.find((person) => person.id === id)?.name ?? null;
  const facts: InitiationFacts = {
    ...(await factsOf(tx, row)),
  };
  const kind = row.kind as InitiationKind;
  const stage = row.stage as InitiationStage;
  const status = row.status as InitiationStatus;
  return {
    initiation: row,
    kind,
    stage,
    status,
    steps: stageStates(kind, stage, status).map((step) => ({
      ...step,
      // The financing sheet's own outcome under each stage reached (agreed, approved, partially paid …).
      outcome: kind === 'financing' && step.state !== 'pending' ? financingOutcome(step.stage, facts) : null,
    })),
    phase: phaseOf(stage, status),
    next: status === 'open' ? nextStage(kind, stage) : null,
    atContract: status === 'open' && isLastStage(kind, stage),
    /** What the current stage still lacks; empty when its gate is open. */
    missing: status === 'open' ? missingFor(facts) : [],
    facts,
    boq,
    boqTotals: boqTotals(boq),
    boqWritable: status === 'open' && stage === boqStage(kind),
    compliance,
    complianceWritable: status === 'open' && kind === 'tender' && stage === 'bidding',
    activities,
    customer: customer ?? null,
    leadSource: source ?? null,
    project: became ?? null,
    people: {
      owner: nameOf(row.ownerUserId),
      createdBy: nameOf(row.createdBy),
      boqApprovedBy: nameOf(row.boqApprovedBy),
      goDecidedBy: nameOf(row.goDecidedBy),
      convertedBy: nameOf(row.convertedBy),
      lostBy: nameOf(row.lostBy),
    },
  };
}

export type InitiationView = Awaited<ReturnType<typeof viewOf>>;

/** The record page: the record, its lines, its activities and what its stage still lacks. */
export async function viewByNo(tx: Tx, initiationNo: string): Promise<InitiationView> {
  return viewOf(tx, await loadByNo(tx, initiationNo));
}

/** The initiation a project came from, for the project's own page; null for a project raised by hand. */
export async function forProject(tx: Tx, projectCode: string): Promise<InitiationView | null> {
  const [row] = await tx.select().from(projectInitiation).where(eq(projectInitiation.projectCode, projectCode)).limit(1);
  return row ? viewOf(tx, row) : null;
}

/**
 * Every current file of the record, section by section — the drawings and
 * documents the project's page shows once the record is converted. Read live
 * from where they are filed, never copied.
 */
export async function filesOf(tx: Tx, initiationNo: string) {
  const out: { section: string; id: string; fileName: string; createdAt: Date }[] = [];
  for (const section of [DOCUMENT_TYPE, ...INITIATION_FILE_SECTIONS]) {
    for (const file of await attachments.currentFor(tx, section, initiationNo)) {
      out.push({ section, id: file.id, fileName: file.fileName, createdAt: file.createdAt });
    }
  }
  return out;
}

/** What the forms choose from. */
export async function pickers(tx: Tx) {
  const leadSources = await tx.select().from(leadSource).where(eq(leadSource.active, 'true')).orderBy(asc(leadSource.name));
  const customers = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(and(eq(businessPartner.isCustomer, true), eq(businessPartner.active, true), eq(businessPartner.status, 'active')))
    .orderBy(asc(businessPartner.legalName));
  const people = await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(eq(appUser.isActive, true)).orderBy(asc(appUser.displayName));
  const items = await tx.select({ code: item.code, name: item.name }).from(item).where(eq(item.active, true)).orderBy(asc(item.code)).limit(500);
  const types = await tx.select().from(projectType).where(eq(projectType.active, true));
  return { leadSources, customers, people, items, types };
}
