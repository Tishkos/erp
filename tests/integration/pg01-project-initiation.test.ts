/**
 * The Project Guide (2026-10-12) — Project Initiation against a real
 * PostgreSQL instance.
 *
 *   PG7  Workflow One, end to end: a direct sale from its first contact to the
 *        signed contract, every gate closed until its stage is complete, and
 *        the conversion into an Active Project that carries the BOQ.
 *   PG8  Workflow Two: a tender through Go / No-Go, the compliance matrix and
 *        the guarantee to its award — confirmed by somebody who holds
 *        `approve` and nothing else; and a No-Go that ends one.
 *   PG9  What the database holds whatever the service does: one stage at a
 *        time, the identity frozen, a decided record final, never deleted,
 *        four eyes at the contract, the activities append-only.
 *   PG10 The edges: a guide project type is never typed in by hand, a lost
 *        record says why, the register's filters, and the branch wall.
 *   PG11 The financing road (2026-10-21) end to end; Leads → Opportunities →
 *        Projects as the register's phases; the board and the updates.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as initiation from '@/server/services/project-initiation';
import * as ps from '@/server/services/project-system';
import * as shipments from '@/server/services/shipments';
import { isNotFoundError } from '@/server/not-found';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';

let engineer: ActorContext;
let manager: ActorContext;
let ceo: ActorContext;
let customerId: string;
let seq = 0;

async function createUser(role: string, branch = BAGHDAD): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `${role}-${(seq += 1)}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}
const as = <T>(ctx: ActorContext, fn: Parameters<typeof withScope<T>>[1]) => withScope({ userId: ctx.principal.userId, branchCode: ctx.branchCode }, fn);

/** A file on a section of the record, as the paperclip would have left it. */
async function file(section: string, initiationNo: string, name: string) {
  const id = randomUUID();
  await ownerPool.query(
    `insert into attachment (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by, scan_status, scanned_at, branch_code)
     values ($1, $2, $3, 'application/pdf', 1024, $4, $5, $6, 'clean', now(), $7)`,
    [section, initiationNo, name, id.replace(/-/g, '').padEnd(64, '0'), `test/${id}`, engineer.principal.userId, BAGHDAD],
  );
}

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows[0] as T;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  engineer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  // The CEO approves and reads; holds no `create` on projects.
  ceo = await createUser('ceo');
  customerId = (
    await one<{ id: string }>(`insert into business_partner (code, legal_name, is_customer, status, active) values ('CUST-001','Al Noor Hospital', true, 'active', true) returning id`)
  ).id;
  await ownerPool.query(`insert into lead_source (code, name) values ('REFERRAL','Referral') on conflict do nothing`);
});

const open = (kind: string, title = 'Al Noor Hospital — 250 kWp rooftop', customerName = 'Al Noor Hospital') =>
  as(engineer, (tx) => initiation.create(tx, engineer, { kind, title, customerName }));
const save = (no: string, section: string, input: initiation.SectionInput, by = engineer) => as(by, (tx) => initiation.saveSection(tx, by, no, section, input));
const next = (no: string, by = engineer) => as(by, (tx) => initiation.advance(tx, by, no));
const view = (no: string, by = engineer) => as(by, (tx) => initiation.viewByNo(tx, no));
const boq = (no: string, category: string, description: string, quantity: string, unitCostIqd: string) =>
  as(engineer, (tx) => initiation.addBoqLine(tx, engineer, no, { category, description, quantity, unitCostIqd, unit: 'pcs' }));
const convert = (no: string, by: ActorContext, over: Partial<initiation.ConvertInput> = {}) =>
  as(by, (tx) =>
    initiation.convert(tx, by, no, {
      managerUserId: manager.principal.userId,
      baselineStartsOn: '2026-11-01',
      baselineEndsOn: '2027-03-31',
      ...over,
    }),
  );

/** A direct sale walked to its Contract Signing stage, everything but the contract's own form filled. */
async function directSaleAtContract() {
  const { initiationNo: no } = await open('direct_sales');
  await save(no, 'lead', { customerPhone: '+964 770 123 4567', leadSourceCode: 'REFERRAL' });
  await next(no);
  await save(no, 'pre_sales', {
    siteLatitude: '33.312806',
    siteLongitude: '44.361488',
    siteGovernorate: 'Baghdad',
    siteArea: 'Karrada',
    siteKind: 'rooftop',
    contactName: 'Sara Ali',
    contactJobTitle: 'Facilities manager',
    contactPhone: '0770 000 0000',
    contactEmail: 'sara@alnoor.example',
    systemType: 'hybrid',
  });
  await next(no);
  await save(no, 'site_survey', { surveyOn: '2026-10-10', siteVerified: true });
  await file('initiation_design', no, 'SLD-rev-C.pdf');
  await next(no);
  await boq(no, 'material', '550 W panel', '455', '120000');
  await boq(no, 'shipping', 'Sea freight and inland', '1', '6500000');
  await boq(no, 'installation', 'Mounting and commissioning', '1', '9000000.5');
  await next(no);
  await save(no, 'proposal', { proposalRef: 'Q-2026-014', proposalOn: '2026-10-11', proposalValueIqd: '95,000,000', proposalStatus: 'accepted' });
  await next(no);
  return no;
}

describe('PG7 · Workflow One — a direct sale from its first contact to an Active Project', () => {
  it('opens at Sales Lead with the next number of its series', async () => {
    const { initiationNo } = await open('direct_sales');
    expect(initiationNo).toMatch(/^PIN-BGW-\d{4}-000001$/);
    const record = await view(initiationNo);
    expect(record).toMatchObject({ kind: 'direct_sales', stage: 'lead', status: 'open', next: 'pre_sales', atContract: false });
    // Opened today, so the first contact is today until somebody says otherwise.
    expect(record.missing).toEqual(['customer_phone', 'lead_source']);
    expect(await rejection(open('franchise'))).toMatch(/a Direct Sales project, a Tender project or a Financed customer/);
    expect(await rejection(open('direct_sales', '  '))).toMatch(/project name is required/);
  });

  it('a stage is left only when it holds what the guide asks, and a later stage’s form waits its turn', async () => {
    const { initiationNo: no } = await open('direct_sales');
    expect(await rejection(next(no))).toMatch(/Stage 1 is not complete: customer phone, lead source/);
    // The Pre-Sales Form opens when the record gets there.
    expect(await rejection(save(no, 'pre_sales', { siteGovernorate: 'Baghdad' }))).toMatch(/has not reached that stage yet/);
    // A tender's form is never a direct sale's.
    expect(await rejection(save(no, 'go_no_go', { bidBondIqd: '0' }))).toMatch(/has not reached that stage yet/);
    await save(no, 'lead', { customerPhone: '0770', leadSourceCode: 'REFERRAL' });
    expect((await next(no)).stage).toBe('pre_sales');
    expect(await rejection(save(no, 'pre_sales', { siteLatitude: '133.5' }))).toMatch(/between -90 and 90/);
    expect(await rejection(save(no, 'pre_sales', { contactEmail: 'not-an-email' }))).toMatch(/not an email address/);
    expect(await rejection(save(no, 'pre_sales', { systemType: 'wind' }))).toMatch(/not a system type/);
    expect(await rejection(save(no, 'lead', { leadSourceCode: 'NOPE' }))).toMatch(/not a lead source in use/);
    // An earlier stage's form stays open while the record is.
    await save(no, 'lead', { leadNote: 'Met at the Baghdad energy exhibition.' });
    expect((await view(no)).initiation.leadNote).toBe('Met at the Baghdad energy exhibition.');
  });

  it('the BOQ is written at its stage, adds up by cost, and is the approved BOQ once the record moves on', async () => {
    const { initiationNo: no } = await open('direct_sales');
    await save(no, 'lead', { customerPhone: '0770', leadSourceCode: 'REFERRAL' });
    expect(await rejection(boq(no, 'material', 'Panel', '1', '100'))).toMatch(/has not reached its BOQ stage/);
    await next(no);
    await save(no, 'pre_sales', {
      siteLatitude: '33.3',
      siteLongitude: '44.4',
      siteGovernorate: 'Baghdad',
      siteArea: 'Karrada',
      siteKind: 'land',
      contactName: 'Sara',
      contactJobTitle: 'Manager',
      contactPhone: '0770',
      contactEmail: 's@a.example',
      systemType: 'on_grid',
    });
    await next(no);
    await save(no, 'site_survey', { surveyOn: '2026-10-10', siteVerified: true });
    // The SLD and layout are part of the stage: no file, no move.
    expect(await rejection(next(no))).toMatch(/Stage 3 is not complete: design files/);
    await file('initiation_design', no, 'layout.pdf');
    await next(no);

    expect(await rejection(next(no))).toMatch(/Stage 4 is not complete: boq lines/);
    await boq(no, 'material', '550 W panel', '455', '120000');
    await boq(no, 'shipping', 'Sea freight', '1', '6500000');
    const extra = await boq(no, 'installation', 'Typed twice', '2', '10');
    await boq(no, 'installation', 'Mounting and commissioning', '1', '9000000.5');
    expect(await rejection(boq(no, 'tax', 'x', '1', '1'))).toMatch(/not a BOQ cost/);
    expect(await rejection(boq(no, 'material', 'x', '0', '1'))).toMatch(/above zero/);
    const line = await one<{ id: string }>(`select l.id from project_initiation_boq_line l join project_initiation i on i.id = l.initiation_id where i.initiation_no = $1 and l.line_no = $2`, [no, extra.lineNo]);
    await as(engineer, (tx) => initiation.removeBoqLine(tx, engineer, no, line.id));

    const before = await view(no);
    expect(before.boqTotals).toEqual({ material: '54600000.0000', shipping: '6500000.0000', installation: '9000000.5000', total: '70100000.5000', lines: 3 });
    expect(before.boqWritable).toBe(true);
    await next(no);
    const after = await view(no);
    expect(after.stage).toBe('proposal');
    expect(after.boqWritable).toBe(false);
    expect(after.initiation.boqApprovedBy).toBe(engineer.principal.userId);
    expect(await rejection(boq(no, 'material', 'Afterthought', '1', '1'))).toMatch(/BOQ of .* is approved/);
  });

  it('only an accepted proposal reaches the contract; the signed contract is confirmed by somebody else and becomes an Active Project', async () => {
    const no = await directSaleAtContract();
    let record = await view(no);
    expect(record).toMatchObject({ stage: 'contract', atContract: true, next: null });
    expect(record.missing).toEqual(['contract_ref', 'contract_signed_on', 'contract_value', 'payment_terms', 'contract_files', 'customer_partner']);
    expect(await rejection(next(no))).toMatch(/last stage/);

    await save(no, 'contract', { contractRef: 'C-2026-007', contractSignedOn: '2026-10-12', contractValueIqd: '95000000', paymentTerms: '30 % advance, 60 % on delivery, 10 % at handover', partnerId: customerId });
    expect(await rejection(convert(no, manager))).toMatch(/Stage 6 is not complete: contract files/);
    await file('initiation_contract', no, 'signed-contract.pdf');
    record = await view(no);
    expect(record.missing).toEqual([]);

    // Whoever raised it does not confirm it — here the officer lacks the grant as well.
    expect(await rejection(convert(no, engineer))).toMatch(/approve/);
    expect(await rejection(convert(no, manager, { baselineEndsOn: '2026-10-01' }))).toMatch(/finish date is before the start/);
    expect(await rejection(convert(no, manager, { managerUserId: randomUUID() }))).toMatch(/project manager names no active user/);

    const { projectCode } = await convert(no, manager);
    expect(projectCode).toMatch(/^PRJ-BGW-\d{4}-000001$/);
    const project = await one<Record<string, unknown>>(
      `select status, type_code, partner_id, created_by, approved_by, contract_value_iqd::text as contract, baseline_budget_iqd::text as budget,
              baseline_starts_on::text as starts, baseline_ends_on::text as ends, manager_user_id from project where code = $1`,
      [projectCode],
    );
    expect(project).toMatchObject({
      // "Automatically converted into an Active Project."
      status: 'active',
      type_code: 'DIRECT_SALES',
      partner_id: customerId,
      // Raised by whoever raised the initiation; confirmed and released by the manager.
      created_by: engineer.principal.userId,
      approved_by: manager.principal.userId,
      contract: '95000000.0000',
      // The approved BOQ is the budget the project starts with.
      budget: '70100000.5000',
      starts: '2026-11-01',
      ends: '2027-03-31',
      manager_user_id: manager.principal.userId,
    });
    // Its level-1 element stands, and carries that budget until budget documents exist.
    const tree = await as(manager, (tx) => ps.tree(tx, projectCode));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ code: `${projectCode}-1`, budgetIqd: '70100000.5000', isBilling: true });

    record = await view(no);
    expect(record).toMatchObject({ status: 'converted', next: null, atContract: false });
    expect(record.initiation).toMatchObject({ projectCode, convertedBy: manager.principal.userId });
    expect(record.steps.every((step) => step.state === 'done')).toBe(true);

    // What the project's page reads: the form, the files and the BOQ — from the initiation, never a copy.
    const origin = await as(manager, (tx) => initiation.forProject(tx, projectCode));
    expect(origin?.initiation.initiationNo).toBe(no);
    expect(origin?.initiation).toMatchObject({ systemType: 'hybrid', siteGovernorate: 'Baghdad', siteKind: 'rooftop' });
    expect(origin?.boq).toHaveLength(3);
    const files = await as(manager, (tx) => initiation.filesOf(tx, no));
    expect(files.map((f) => `${f.section}:${f.fileName}`).sort()).toEqual(['initiation_contract:signed-contract.pdf', 'initiation_design:SLD-rev-C.pdf']);
    expect(await as(manager, (tx) => initiation.forProject(tx, 'NOPE'))).toBeNull();

    // A decided record does not change again — by the service, or under it.
    expect(await rejection(save(no, 'contract', { paymentTerms: 'changed' }))).toMatch(/is converted; a decided record does not change again/);
    expect(await rejection(as(engineer, (tx) => initiation.markLost(tx, engineer, no, 'changed our mind')))).toMatch(/decided record/);
    expect(await rejection(convert(no, manager))).toMatch(/decided record/);
    expect(await rejection(ownerPool.query(`update project_initiation set payment_terms = 'x' where initiation_no = $1`, [no]))).toMatch(/does not change again/);

    // The trail: every step on the record, and the project's own history says where it came from.
    const { rows: trail } = await ownerPool.query(`select action from audit_event where object_type = 'project_initiation' and object_id = $1 order by occurred_at, id`, [no]);
    const actions = trail.map((row) => row.action);
    expect(actions[0]).toBe('project_initiation.created');
    expect(actions.at(-1)).toBe('project_initiation.converted');
    expect(actions.filter((a) => a === 'project_initiation.stage_advanced')).toHaveLength(5);
    expect(actions).toContain('project_initiation.boq_line_added');
    const from = await one<{ after_value: { initiationNo: string } }>(`select after_value from audit_event where object_type = 'project' and object_id = $1 and action = 'project.initiated_from'`, [projectCode]);
    expect(from.after_value.initiationNo).toBe(no);
  });

  it('a customer who is not yet approved cannot be contracted to', async () => {
    const prospect = await one<{ id: string }>(`insert into business_partner (code, legal_name, is_customer, status, active) values ('CUST-002','New Lead Co', true, 'prospect', true) returning id`);
    const no = await directSaleAtContract();
    expect(await rejection(save(no, 'contract', { partnerId: prospect.id }))).toMatch(/not an approved customer in use/);
    expect(await rejection(save(no, 'contract', { partnerId: randomUUID() }))).toMatch(/customer does not exist/);
  });
});

describe('PG8 · Workflow Two — the tender pipeline', () => {
  async function tenderAtGoNoGo() {
    const { initiationNo: no } = await open('tender', 'MoE 5 MW solar plant — Karbala', 'Ministry of Electricity');
    expect((await view(no)).missing).toEqual(['tender_ref', 'tender_documents', 'submission_deadline']);
    expect(await rejection(save(no, 'tender_lead', { tenderDocumentsUrl: 'ftp://files/itb.zip' }))).toMatch(/http:\/\/ or https:\/\//);
    await save(no, 'tender_lead', { tenderRef: 'MOE/2026/14', tenderDocumentsUrl: 'https://tenders.example.gov/moe-2026-14', submissionDeadline: '2026-11-30' });
    await next(no);
    return no;
  }

  it('Go is approved by somebody who may; then the visit, the design, the matrix, the guarantee, the award and the contract', async () => {
    const no = await tenderAtGoNoGo();
    await save(no, 'go_no_go', { qualificationRequirements: 'Class A contractor; two plants over 1 MW delivered.', bidBondIqd: '50,000,000' });
    expect(await rejection(next(no))).toMatch(/Stage 8 is not complete: go decision/);
    // The officer keeps the record; the decision to take part is not theirs.
    expect(await rejection(as(engineer, (tx) => initiation.decideGo(tx, engineer, no, { decision: 'go' })))).toMatch(/approve/);
    expect(await rejection(as(ceo, (tx) => initiation.decideGo(tx, ceo, no, { decision: 'maybe' })))).toMatch(/Go or No-Go/);
    await as(ceo, (tx) => initiation.decideGo(tx, ceo, no, { decision: 'go', note: 'Within our class; margin acceptable.' }));
    expect((await view(no)).initiation).toMatchObject({ goDecision: 'go', goDecidedBy: ceo.principal.userId });
    await next(no);

    await save(no, 'pre_bid', { siteVisitOn: '2026-10-20', siteVisitMinutes: 'Access from the north gate; soil report promised by the owner.', clarifications: 'Grid connection point confirmed at 33 kV.' });
    await as(engineer, (tx) => initiation.logActivity(tx, engineer, no, { kind: 'addendum', happenedOn: '2026-10-11', summary: 'Addendum 1: deadline unchanged, BOQ item 14 revised.', nextAction: 'Revise BOQ', nextActionOn: '2026-10-25' }));
    await next(no);

    expect(await rejection(next(no))).toMatch(/Stage 10 is not complete: design files, boq lines/);
    await file('initiation_design', no, 'tender-design.pdf');
    await boq(no, 'material', 'Modules, inverters, structures', '1', '3,900,000,000');
    await boq(no, 'installation', 'Civil and electrical works', '1', '800,000,000');
    await next(no);

    // The compliance matrix is this stage's, and every line is answered before the bid goes in.
    const first = await as(engineer, (tx) => initiation.addComplianceLine(tx, engineer, no, { clause: '4.2.1', requirement: 'Tier-1 modules with 25-year warranty', response: 'compliant' }));
    const second = await as(engineer, (tx) => initiation.addComplianceLine(tx, engineer, no, { clause: '4.3', requirement: 'Local content of 20 %' }));
    await save(no, 'bidding', { bidPriceIqd: '5,400,000,000' });
    expect(await rejection(next(no))).toMatch(/Stage 11 is not complete: compliance answered, guarantee details, guarantee issued/);
    const unanswered = await one<{ id: string }>(`select l.id from project_initiation_compliance_line l join project_initiation i on i.id = l.initiation_id where i.initiation_no = $1 and l.line_no = $2`, [no, second.lineNo]);
    expect(await rejection(as(engineer, (tx) => initiation.answerComplianceLine(tx, engineer, no, unanswered.id, { response: 'perhaps' })))).toMatch(/not a compliance answer/);
    await as(engineer, (tx) => initiation.answerComplianceLine(tx, engineer, no, unanswered.id, { response: 'partial', remark: '15 % achievable; deviation stated.' }));
    await save(no, 'bidding', { guaranteeBank: 'Trade Bank of Iraq', guaranteeNo: 'LG-2026-0091', guaranteeIqd: '50000000', guaranteeExpiresOn: '2027-02-28', guaranteeStatus: 'issued' });
    expect(first.lineNo).toBe(1);
    await next(no);

    let record = await view(no);
    expect(record).toMatchObject({ stage: 'award', atContract: true });
    expect(record.complianceWritable).toBe(false);
    expect(await rejection(as(engineer, (tx) => initiation.addComplianceLine(tx, engineer, no, { requirement: 'Late thought' })))).toMatch(/written at Compliance Matrix & Bidding/);
    expect(await rejection(save(no, 'award', { submittedOn: '2026-11-29', awardedOn: '2026-11-01' }))).toMatch(/award cannot be dated before the submission/);
    await save(no, 'award', { submittedOn: '2026-11-29', submissionRef: 'SUB-4471', awardStatus: 'awarded', awardedOn: '2026-12-20', guaranteeStatus: 'converted' });
    await save(no, 'contract', { contractRef: 'MOE-C-2026-14', contractSignedOn: '2027-01-05', contractValueIqd: '5400000000', paymentTerms: 'Per milestones in annex C', partnerId: customerId });
    await file('initiation_contract', no, 'moe-contract.pdf');
    record = await view(no);
    expect(record.missing).toEqual([]);

    // The CEO holds `approve` on projects and no `create`: confirming a contract asks for the first only.
    expect(ceo.principal.grants.some((g) => g.object === 'project' && g.verb === 'create')).toBe(false);
    const { projectCode } = await convert(no, ceo, { baselineStartsOn: '2027-01-10', baselineEndsOn: '2027-12-31', billingMethod: 'milestone', retentionPercent: '5' });
    const project = await one<Record<string, unknown>>(
      `select status, type_code, created_by, approved_by, billing_method, retention_percent::text as retention, baseline_budget_iqd::text as budget from project where code = $1`,
      [projectCode],
    );
    expect(project).toMatchObject({ status: 'active', type_code: 'TENDER', created_by: engineer.principal.userId, approved_by: ceo.principal.userId, billing_method: 'milestone', retention: '5.0000', budget: '4700000000.0000' });
    expect((await view(no)).activities.map((a) => a.kind)).toEqual(['addendum']);
  });

  it('a No-Go says why, and ends the tender there', async () => {
    const no = await tenderAtGoNoGo();
    expect(await rejection(as(manager, (tx) => initiation.decideGo(tx, manager, no, { decision: 'no_go' })))).toMatch(/A No-Go says why/);
    await as(manager, (tx) => initiation.decideGo(tx, manager, no, { decision: 'no_go', note: 'Bid bond beyond our facility this quarter.' }));
    const record = await view(no);
    expect(record).toMatchObject({ status: 'lost', stage: 'go_no_go', next: null });
    expect(record.initiation).toMatchObject({ goDecision: 'no_go', lostReason: 'Bid bond beyond our facility this quarter.', lostBy: manager.principal.userId });
    expect(await rejection(next(no))).toMatch(/decided record/);
    expect(await rejection(as(manager, (tx) => initiation.decideGo(tx, manager, no, { decision: 'go' })))).toMatch(/decided record/);
  });

  it('a direct sale has no Go / No-Go and no compliance matrix', async () => {
    const { initiationNo: no } = await open('direct_sales');
    expect(await rejection(as(manager, (tx) => initiation.decideGo(tx, manager, no, { decision: 'go' })))).toMatch(/is not at Feasibility Review/);
    expect(await rejection(as(engineer, (tx) => initiation.addComplianceLine(tx, engineer, no, { requirement: 'x' })))).toMatch(/Only a tender carries a compliance matrix/);
  });
});

describe('PG9 · what the database holds whatever the service does (0421)', () => {
  it('one stage forward at a time, in its own workflow; the identity never changes; never deleted', async () => {
    const { initiationNo: no } = await open('direct_sales');
    const update = (sql: string) => rejection(ownerPool.query(`update project_initiation set ${sql} where initiation_no = $1`, [no]));
    expect(await update(`stage = 'site_survey'`)).toMatch(/one stage forward at a time/);
    expect(await update(`stage = 'go_no_go'`)).toMatch(/project_initiation_stage_of_kind|one stage forward/);
    expect(await update(`kind = 'tender'`)).toMatch(/number, type, branch and author never change/);
    expect(await update(`initiation_no = 'PIN-X'`)).toMatch(/never change/);
    expect(await update(`status = 'converted', project_code = null`)).toMatch(/converted at the last stage of its workflow|project_initiation_converted_has_project/);
    expect(await update(`status = 'lost'`)).toMatch(/project_initiation_lost_has_reason/);
    expect(await rejection(ownerPool.query(`delete from project_initiation where initiation_no = $1`, [no]))).toMatch(/append-only|cannot be|not allowed|immutable|reject/i);
    // A legitimate step still passes.
    await ownerPool.query(`update project_initiation set stage = 'pre_sales' where initiation_no = $1`, [no]);
  });

  it('a tender does not leave Go / No-Go without the decision to take part', async () => {
    const { initiationNo: no } = await open('tender', 'Tender', 'Owner');
    await ownerPool.query(`update project_initiation set stage = 'go_no_go' where initiation_no = $1`, [no]);
    expect(await rejection(ownerPool.query(`update project_initiation set stage = 'pre_bid' where initiation_no = $1`, [no]))).toMatch(/no decision to participate/);
    expect(await rejection(ownerPool.query(`update project_initiation set go_decision = 'go' where initiation_no = $1`, [no]))).toMatch(/project_initiation_go_decided/);
  });

  it('four eyes at the contract: not whoever raised the record', async () => {
    const no = await directSaleAtContract();
    await save(no, 'contract', { contractRef: 'C-1', contractSignedOn: '2026-10-12', contractValueIqd: '1000', paymentTerms: 'Net 30', partnerId: customerId });
    const project = await as(manager, (tx) =>
      ps.createDefinition(tx, manager, { name: 'Stand-in', typeCode: 'CUSTOMER', customerId, branchCode: BAGHDAD, managerUserId: manager.principal.userId, baselineStartsOn: '2026-11-01', baselineEndsOn: '2026-12-01' }),
    );
    const convertAs = (userId: string) =>
      ownerPool.query(`update project_initiation set status = 'converted', project_code = $2, converted_by = $3, converted_at = now() where initiation_no = $1`, [no, project.projectCode, userId]);
    expect(await rejection(convertAs(engineer.principal.userId))).toMatch(/project_initiation_four_eyes/);
    await convertAs(manager.principal.userId);
    // One initiation per project.
    const other = await directSaleAtContract();
    await save(other, 'contract', { partnerId: customerId });
    expect(
      await rejection(ownerPool.query(`update project_initiation set status = 'converted', project_code = $2, converted_by = $3, converted_at = now() where initiation_no = $1`, [other, project.projectCode, manager.principal.userId])),
    ).toMatch(/project_initiation_project_uniq/);
  });

  it('a line is the product of its quantity and cost; lines and activities of a decided record are kept as they were', async () => {
    const { initiationNo: no } = await open('direct_sales');
    const id = (await one<{ id: string }>(`select id from project_initiation where initiation_no = $1`, [no])).id;
    const line = (amount: string) =>
      ownerPool.query(
        `insert into project_initiation_boq_line (initiation_id, line_no, category, description, quantity, unit_cost_iqd, amount_iqd, created_by) values ($1, 1, 'material', 'Panel', 3, 0.3334, $2, $3)`,
        [id, amount, engineer.principal.userId],
      );
    expect(await rejection(line('1.0000'))).toMatch(/project_initiation_boq_amount_is_product/);
    await line('1.0002');
    await as(engineer, (tx) => initiation.logActivity(tx, engineer, no, { kind: 'call', summary: 'Called the customer; site visit agreed.' }));
    expect(await rejection(as(engineer, (tx) => initiation.logActivity(tx, engineer, no, { kind: 'call', summary: 'Tomorrow', happenedOn: '2999-01-01' })))).toMatch(/once it has happened/);
    // What was done and said is never rewritten.
    expect(await rejection(ownerPool.query(`update project_initiation_activity set summary = 'rewritten' where initiation_id = $1`, [id]))).toMatch(/append-only|cannot be|not allowed|immutable|reject/i);
    expect(await rejection(ownerPool.query(`delete from project_initiation_activity where initiation_id = $1`, [id]))).toMatch(/append-only|cannot be|not allowed|immutable|reject/i);

    await as(engineer, (tx) => initiation.markLost(tx, engineer, no, 'Customer chose another supplier on price.'));
    expect(await rejection(ownerPool.query(`delete from project_initiation_boq_line where initiation_id = $1`, [id]))).toMatch(/its lines no longer change/);
    expect(await rejection(as(engineer, (tx) => initiation.logActivity(tx, engineer, no, { kind: 'note', summary: 'After the fact' })))).toMatch(/decided record/);
  });
});

describe('PG10 · the edges', () => {
  it('a Direct Sales or a Tender project is never typed in by hand', async () => {
    for (const typeCode of ['DIRECT_SALES', 'TENDER', 'FINANCING']) {
      expect(
        await rejection(
          as(manager, (tx) =>
            ps.createDefinition(tx, manager, { name: 'By hand', typeCode, customerId, branchCode: BAGHDAD, managerUserId: manager.principal.userId, baselineStartsOn: '2026-11-01', baselineEndsOn: '2026-12-01' }),
          ),
        ),
      ).toMatch(/starts in Project Initiation/);
    }
    // And an initiation is only ever a customer's project.
    expect(
      await rejection(
        as(manager, (tx) =>
          ps.createDefinition(tx, manager, { name: 'Internal by proxy', typeCode: 'INTERNAL', branchCode: BAGHDAD, managerUserId: manager.principal.userId, raisedByUserId: engineer.principal.userId }),
        ),
      ),
    ).toMatch(/only a customer project is confirmed from an initiation/);
  });

  it('a record that is not there is "not found" — the code a page turns into its 404, never a bare failure', async () => {
    // Until 2026-10-12 a missing project was a plain Error, so every Projects screen handed a stale
    // code fell into the error page; and an id that was not an id was refused by the database as malformed.
    const refusal = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);
    const project = await refusal(as(manager, (tx) => ps.record(tx, manager, 'PRJ-NOPE')));
    expect(isNotFoundError(project)).toBe(true);
    expect((project as Error).message).toBe("No project 'PRJ-NOPE'.");
    expect(isNotFoundError(await refusal(as(manager, (tx) => initiation.viewByNo(tx, 'PIN-NOPE'))))).toBe(true);
    expect(isNotFoundError(await refusal(as(manager, (tx) => shipments.viewContainer(tx, 'MSCU0000000', 'not-an-id'))))).toBe(true);
    expect(isNotFoundError(await refusal(as(manager, (tx) => shipments.viewContainer(tx, 'MSCU0000000', '11111111-1111-4111-8111-111111111111'))))).toBe(true);
  });

  it('a lost record says why; the register filters by type, stage and status and searches what people type', async () => {
    const a = (await open('direct_sales', 'Villa rooftop 12 kWp', 'Ahmed Kareem')).initiationNo;
    const b = (await open('tender', 'Municipality street lighting', 'Baghdad Municipality')).initiationNo;
    await save(b, 'tender_lead', { tenderRef: 'BM/2026/7', tenderDocumentsUrl: 'https://example.gov/bm7', submissionDeadline: '2026-12-01' });
    expect(await rejection(as(engineer, (tx) => initiation.markLost(tx, engineer, a, '  ')))).toMatch(/says why/);
    await as(engineer, (tx) => initiation.markLost(tx, engineer, a, 'No budget this year.'));

    const list = (filter: initiation.ListFilter) => as(engineer, (tx) => initiation.list(tx, filter));
    expect((await list({})).total).toBe(2);
    expect((await list({ kind: 'tender' })).rows.map((row) => row.initiationNo)).toEqual([b]);
    expect((await list({ status: 'lost' })).rows.map((row) => row.initiationNo)).toEqual([a]);
    expect((await list({ stage: 'tender_lead', status: 'open' })).rows.map((row) => row.initiationNo)).toEqual([b]);
    expect((await list({ search: 'BM/2026' })).rows.map((row) => row.initiationNo)).toEqual([b]);
    expect((await list({ search: 'kareem' })).rows.map((row) => row.initiationNo)).toEqual([a]);
    expect((await list({ search: 'nothing-like-this' })).total).toBe(0);
  });

  it('another branch does not see the record, its lines or its files', async () => {
    await seedBranch(ERBIL, 'Erbil');
    const outsider = await createUser('accounting_manager', ERBIL);
    const { initiationNo: no } = await open('direct_sales');
    expect(await rejection(as(outsider, (tx) => initiation.viewByNo(tx, no)))).toMatch(/outside the branches you may see/);
    expect((await as(outsider, (tx) => initiation.list(tx, {}))).total).toBe(0);
    expect(await rejection(as(outsider, (tx) => initiation.saveSection(tx, outsider, no, 'lead', { leadNote: 'x' })))).toMatch(/outside the branches you may see/);
    // A reader with no grant on projects is refused before anything is read.
    const stranger = await createUser('warehouse_keeper').catch(() => null);
    if (stranger) expect(await rejection(as(stranger, (tx) => initiation.create(tx, stranger, { kind: 'direct_sales', title: 'x', customerName: 'y' })))).toMatch(/create|permission|not permitted/i);
  });
});

describe('PG11 · the financing road, Leads → Opportunities → Projects, and the live updates (2026-10-21)', () => {
  it('a financed customer walks the sheet’s seven stages to an Active Project, each moved on only by its good outcome', async () => {
    const { initiationNo: no } = await as(engineer, (tx) =>
      initiation.create(tx, engineer, { kind: 'financing', title: 'Ahmed Karim — 10 kW home system', customerName: 'Ahmed Karim', customerPhone: '0750 111 2233' }),
    );
    const list = (phase: 'lead' | 'opportunity' | 'project') => as(engineer, (tx) => initiation.list(tx, { phase })).then((r) => r.rows.map((row) => row.initiationNo));
    let record = await view(no);
    expect(record).toMatchObject({ kind: 'financing', stage: 'fin_customer', phase: 'lead', next: 'fin_quotation' });
    expect(record.missing).toEqual(['customer_city']);
    expect(await list('lead')).toEqual([no]);
    expect(await list('opportunity')).toEqual([]);
    expect(await rejection(next(no))).toMatch(/Stage 1 is not complete: customer city/);

    const before = await as(engineer, (tx) => initiation.liveVersion(tx, no));
    await save(no, 'lead', { customerCity: 'Erbil' });
    // The live pages see the record move.
    expect(await as(engineer, (tx) => initiation.liveVersion(tx, no))).not.toBe(before);
    await next(no);
    expect(await list('lead')).toEqual([]);
    expect(await list('opportunity')).toEqual([no]);

    // 2 — the quotation, priced from its BOQ; refused is not agreed.
    await boq(no, 'material', '10 kW hybrid kit', '1', '9000000');
    await save(no, 'proposal', { proposalOn: '2026-10-20', proposalValueIqd: '10,500,000', proposalStatus: 'rejected' });
    expect(await rejection(next(no))).toMatch(/quotation agreed/);
    expect(await rejection(save(no, 'proposal', { proposalStatus: 'negotiating' }))).toMatch(/quotation status/);
    await save(no, 'proposal', { proposalStatus: 'accepted' });
    expect((await view(no)).steps.find((step) => step.stage === 'fin_quotation')?.outcome).toBe('agreed');
    await next(no);
    expect((await view(no)).initiation.boqApprovedAt).not.toBeNull();

    // 3 — the bank. Rejected holds it, at the service and at the database.
    await save(no, 'bank_approval', { financingBank: 'Rafidain Bank', bankApprovalStatus: 'rejected', bankDecidedOn: '2026-10-22', loanAmountIqd: '8000000' });
    expect(await rejection(next(no))).toMatch(/bank approved/);
    expect(await rejection(ownerPool.query(`update project_initiation set stage = 'fin_loan_first' where initiation_no = $1`, [no]))).toMatch(/no bank approval/);
    await save(no, 'bank_approval', { bankApprovalStatus: 'approved' });
    await next(no);

    // 4 — the loan, paid in part; never more than the bank lent.
    expect(await rejection(save(no, 'loan', { loanReceivedIqd: '9000000' }))).toMatch(/more than the loan the bank approved/);
    expect(await rejection(ownerPool.query(`update project_initiation set loan_received_iqd = 9000000 where initiation_no = $1`, [no]))).toMatch(/project_initiation_loan_amounts/);
    await save(no, 'loan', { loanStatus: 'partially_paid', loanReceivedIqd: '3000000', loanFirstReceivedOn: '2026-10-25' });
    await next(no);

    // 5 — the installation.
    expect(await rejection(save(no, 'installation', { installationStartedOn: '2026-11-05', installationCompletedOn: '2026-11-01' }))).toMatch(/completed before it started/);
    await save(no, 'installation', { installationStatus: 'in_progress', installationStartedOn: '2026-11-01' });
    expect(await rejection(next(no))).toMatch(/installation completed/);
    await save(no, 'installation', { installationStatus: 'completed', installationCompletedOn: '2026-11-04' });
    await next(no);

    // 6 — the contract, signed and on file.
    await save(no, 'contract', { contractRef: 'FIN-C-7', contractSignedOn: '2026-11-05', contractValueIqd: '10500000', paymentTerms: 'Paid by the bank loan', partnerId: customerId });
    await file('initiation_contract', no, 'contract-signed.pdf');
    await next(no);
    record = await view(no);
    expect(record).toMatchObject({ stage: 'fin_loan_full', atContract: true });

    // 7 — fully granted only once all of it is in; then the record becomes a project.
    expect(await rejection(convert(no, ceo))).toMatch(/loan fully granted/);
    expect(await rejection(save(no, 'loan', { loanStatus: 'fully_granted', loanFullyGrantedOn: '2026-11-20' }))).toMatch(/only once all of it is received/);
    await save(no, 'loan', { loanStatus: 'fully_granted', loanReceivedIqd: '8000000', loanFullyGrantedOn: '2026-11-20' });
    const { projectCode } = await convert(no, ceo);
    const made = await one<{ type_code: string; status: string }>(`select type_code, status from project where code = $1`, [projectCode]);
    expect(made.type_code).toBe('FINANCING');
    expect(await list('opportunity')).toEqual([]);
    expect(await list('project')).toEqual([no]);
    expect((await view(no)).phase).toBe('project');

    // The updates say what moved, by whom, newest first.
    const updates = await as(engineer, (tx) => initiation.timeline(tx, no));
    expect(updates[0]!.action).toBe('converted');
    expect(updates.filter((entry) => entry.action === 'stage_advanced').map((entry) => entry.stage).reverse()).toEqual([
      'fin_quotation',
      'fin_bank_approval',
      'fin_loan_first',
      'fin_installation',
      'fin_contract',
      'fin_loan_full',
    ]);
    expect(updates.find((entry) => entry.action === 'bank_approval_saved')?.changed).toContainEqual({ field: 'bankApprovalStatus', value: 'approved' });
  });

  it('the board holds every open record by phase, and the decided ones of the last month', async () => {
    const lead = (await open('financing', 'Roof 5 kW', 'Sara')).initiationNo;
    const tender = (await open('tender', 'Street lights', 'Municipality')).initiationNo;
    const lost = (await open('direct_sales', 'Villa', 'Omar')).initiationNo;
    await as(engineer, (tx) => initiation.markLost(tx, engineer, lost, 'Went quiet.'));
    const { cards } = await as(engineer, (tx) => initiation.board(tx));
    expect(Object.fromEntries(cards.map((card) => [card.initiationNo, `${card.phase}/${card.status}`]))).toEqual({
      [lead]: 'lead/open',
      [tender]: 'lead/open',
      [lost]: 'lead/lost',
    });
    expect((await as(engineer, (tx) => initiation.board(tx, { kind: 'financing' }))).cards.map((card) => card.initiationNo)).toEqual([lead]);
    expect((await as(engineer, (tx) => initiation.board(tx, { ownerUserId: manager.principal.userId }))).cards).toEqual([]);
  });
});
