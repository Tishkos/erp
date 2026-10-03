/**
 * The Project System — REQ-PM-001 Stage PM-2: the cost plan in versions,
 * the budget as documents, availability control against the tolerance
 * profile, and change orders that raise the supplement they carry.
 *
 * Over `services/projects.ts` (Phase 11) as PM-1 is: that module keeps the
 * commitment, the cost, the stock issue and the variation's two approvals;
 * this one gives the budget its documents and reads availability per
 * element — and `projects.assertSpendable` calls back into it for the
 * element check, so no spending path reaches the element without the
 * profile being read.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  project,
  projectBudgetDocument,
  projectBudgetDocumentLine,
  projectBudgetLine,
  projectCommitment,
  projectCost,
  projectCostCode,
  projectPlanLine,
  projectPlanVersion,
  projectToleranceProfile,
  projectVariation,
  projectVariationLine,
  projectWbs,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  BUDGET_DOCUMENT_KINDS,
  assertRaisedStopLine,
  availabilityDecision,
  budgetDocumentTotal,
  monthsBetween,
  spreadEvenly,
  type AvailabilityDecision,
  type BudgetDocumentKind,
  type BudgetLineInput,
} from '../domain/project-budget';
import { ProjectSystemError, rollUp, treeOrder, type ProjectStatus } from '../domain/project-system';
import { AdminNotFoundError, optionalText, permit, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import * as projects from './projects';

/** A literal, not `projects.PERMISSION_OBJECT`: this module and `projects.ts` import each other, and a binding read while the other is still loading is undefined. */
export const PERMISSION_OBJECT = 'project';
export const BUDGET_DOCUMENT_TYPE = 'project_budget';
export const PLAN_DOCUMENT_TYPE = 'project_plan';
export const VARIATION_DOCUMENT_TYPE = 'project_variation';
export const BUDGET_SEQUENCE_KEY = 'PROJECT_BUDGET';
export const VARIATION_SEQUENCE_KEY = 'PROJECT_VARIATION';

const MONEY = 4n;
const PAGE_SIZE = 50;

export class AvailabilityStopError extends Error {
  readonly code = 'AVAILABILITY_STOP';
  constructor(
    readonly projectCode: string,
    readonly wbsCode: string,
    readonly decision: AvailabilityDecision,
    readonly requestedIqd: bigint,
  ) {
    super(
      `${projectCode} / ${wbsCode}: ${toDecimalString(decision.availableBeforeIqd, MONEY)} is available and this needs ` +
        `${toDecimalString(requestedIqd, MONEY)} — the stop line of ${decision.stopPercent} % is reached (REQ-PM-001 §7). ` +
        'Raise a supplement or a transfer, or have the stop line raised for this element with a reason.',
    );
    this.name = 'AvailabilityStopError';
  }
}

async function load(tx: Tx, projectCode: string) {
  const [row] = await tx.select().from(project).where(eq(project.code, projectCode)).limit(1);
  if (!row) throw new AdminNotFoundError('project', projectCode);
  return row;
}

async function profileOf(tx: Tx, code: string) {
  const [row] = await tx.select().from(projectToleranceProfile).where(eq(projectToleranceProfile.code, code)).limit(1);
  return { warnPercent: Number(row?.warnPercent ?? 90), stopPercent: Number(row?.stopPercent ?? 100) };
}

const money = (value: string | bigint | null | undefined, field: string): bigint => {
  if (typeof value === 'bigint') return value;
  const text = (value ?? '').trim();
  if (!text) return 0n;
  try {
    return parseDecimal(text, MONEY);
  } catch {
    throw new ProjectSystemError(field, `'${text}' is not an amount`);
  }
};

const day = (value: string | null | undefined, field: string): string | null => {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ProjectSystemError(field, `'${text}' is not a date`);
  return text;
};

// ---------------------------------------------------------------------------
// The budget by element — the sum of approved documents (§7, PM4)
// ---------------------------------------------------------------------------

export interface ElementBudget {
  readonly wbsCode: string;
  readonly originalIqd: bigint;
  readonly supplementsIqd: bigint;
  readonly returnsIqd: bigint;
  readonly transfersIqd: bigint;
  readonly currentIqd: bigint;
}

/** Each element's own budget from the approved documents, by kind. Empty when the project has none yet. */
export async function budgetByElement(tx: Tx, projectCode: string): Promise<Map<string, ElementBudget>> {
  const rows = (
    await tx.execute(sql`
      select l.wbs_code,
             coalesce(sum(l.amount_iqd) filter (where d.kind = 'original'), 0)::text   as original,
             coalesce(sum(l.amount_iqd) filter (where d.kind = 'supplement'), 0)::text as supplements,
             coalesce(sum(l.amount_iqd) filter (where d.kind = 'return'), 0)::text     as returns,
             coalesce(sum(l.amount_iqd) filter (where d.kind = 'transfer'), 0)::text   as transfers
        from project_budget_document_line l
        join project_budget_document d on d.id = l.document_id
       where l.project_code = ${projectCode} and d.status = 'approved'
       group by l.wbs_code`)
  ).rows as { wbs_code: string; original: string; supplements: string; returns: string; transfers: string }[];
  const out = new Map<string, ElementBudget>();
  for (const r of rows) {
    const originalIqd = parseDecimal(r.original, MONEY);
    const supplementsIqd = parseDecimal(r.supplements, MONEY);
    const returnsIqd = parseDecimal(r.returns, MONEY);
    const transfersIqd = parseDecimal(r.transfers, MONEY);
    out.set(r.wbs_code, { wbsCode: r.wbs_code, originalIqd, supplementsIqd, returnsIqd, transfersIqd, currentIqd: originalIqd + supplementsIqd + returnsIqd + transfersIqd });
  }
  return out;
}

/** Whether the project's budget comes from documents yet (else Phase 11's lines or the definition). */
export async function hasBudgetDocuments(tx: Tx, projectCode: string, kind?: BudgetDocumentKind): Promise<boolean> {
  const [row] = await tx
    .select({ id: projectBudgetDocument.id })
    .from(projectBudgetDocument)
    .where(and(eq(projectBudgetDocument.projectCode, projectCode), eq(projectBudgetDocument.status, 'approved'), ...(kind ? [eq(projectBudgetDocument.kind, kind)] : [])))
    .limit(1);
  return Boolean(row);
}

/**
 * Each element's own budget, whatever wrote it: the approved documents once
 * the original is approved (it wrote Phase 11's baseline lines, so those
 * are not counted again); before that, the documents plus Phase 11's lines
 * by element; before any of those, the definition's revised budget on the
 * root. One answer for the tree, availability and the budget register.
 */
export async function ownBudgetByElement(tx: Tx, projectCode: string): Promise<{ own: Map<string, bigint>; source: 'documents' | 'lines' | 'definition' }> {
  const documents = await budgetByElement(tx, projectCode);
  const own = new Map<string, bigint>();
  for (const [code, b] of documents) own.set(code, (own.get(code) ?? 0n) + b.currentIqd);
  if (await hasBudgetDocuments(tx, projectCode, 'original')) return { own, source: 'documents' };
  const root = (await tx.select({ code: projectWbs.code }).from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.level, 1))).limit(1))[0]?.code ?? null;
  const lines = await tx.select({ wbsCode: projectBudgetLine.wbsCode, baselineIqd: projectBudgetLine.baselineIqd }).from(projectBudgetLine).where(eq(projectBudgetLine.projectCode, projectCode));
  if (lines.length > 0) {
    for (const l of lines) {
      const code = l.wbsCode ?? root;
      if (code) own.set(code, (own.get(code) ?? 0n) + parseDecimal(l.baselineIqd, MONEY));
    }
    return { own, source: documents.size > 0 ? 'documents' : 'lines' };
  }
  if (documents.size > 0) return { own, source: 'documents' };
  if (root) own.set(root, (await projects.position(tx, projectCode)).budgetIqd);
  return { own, source: 'definition' };
}

/** Approved document lines for one cost code, other than the original — the revisions `budgetFor` reads. */
export async function revisionsForCostCode(tx: Tx, projectCode: string, costCode: string): Promise<bigint | null> {
  if (!(await hasBudgetDocuments(tx, projectCode))) return null;
  const [row] = (
    await tx.execute(sql`
      select coalesce(sum(l.amount_iqd), 0)::text as total
        from project_budget_document_line l
        join project_budget_document d on d.id = l.document_id
       where l.project_code = ${projectCode} and l.cost_code = ${costCode} and d.status = 'approved' and d.kind <> 'original'`)
  ).rows as { total: string }[];
  return parseDecimal(row?.total ?? '0', MONEY);
}

// ---------------------------------------------------------------------------
// Availability control (§7, PM5)
// ---------------------------------------------------------------------------

interface ElementPosition {
  readonly wbsCode: string;
  readonly budgetIqd: bigint;
  readonly assignedIqd: bigint;
  readonly raisedStopPercent: number | null;
  readonly responsibleUserId: string | null;
}

/**
 * The element whose budget an assignment on `wbsCode` is checked against:
 * the element itself when it carries budget, else the nearest ancestor that
 * does (PS's budget-carrying element), with that element's subtree rolled
 * up. Without any budget on the path the project's root is the answer.
 */
async function carryingElement(tx: Tx, projectCode: string, wbsCode: string): Promise<ElementPosition> {
  const elements = await tx
    .select({ code: projectWbs.code, parentCode: projectWbs.parentCode, level: projectWbs.level, responsibleUserId: projectWbs.responsibleUserId, raised: projectWbs.stopPercentRaised })
    .from(projectWbs)
    .where(eq(projectWbs.projectCode, projectCode));
  if (!elements.some((e) => e.code === wbsCode)) throw new ProjectSystemError('wbs', `${projectCode} has no such element: ${wbsCode}`);
  const own = new Map<string, { budgetIqd: bigint; committedIqd: bigint; actualIqd: bigint }>();
  const at = (code: string) => {
    const current = own.get(code) ?? { budgetIqd: 0n, committedIqd: 0n, actualIqd: 0n };
    own.set(code, current);
    return current;
  };
  const root = elements.find((e) => e.level === 1)?.code ?? wbsCode;
  for (const [code, budgetIqd] of (await ownBudgetByElement(tx, projectCode)).own) at(code).budgetIqd += budgetIqd;
  const commitments = await tx
    .select({ wbsCode: projectCommitment.wbsCode, amountIqd: projectCommitment.amountIqd, consumedIqd: projectCommitment.consumedIqd, releasedOn: projectCommitment.releasedOn })
    .from(projectCommitment)
    .where(eq(projectCommitment.projectCode, projectCode));
  for (const c of commitments) {
    if (c.releasedOn) continue;
    const open = parseDecimal(c.amountIqd, MONEY) - parseDecimal(c.consumedIqd, MONEY);
    if (open > 0n) at(c.wbsCode ?? root).committedIqd += open;
  }
  const costs = await tx.select({ wbsCode: projectCost.wbsCode, amountIqd: projectCost.amountIqd }).from(projectCost).where(eq(projectCost.projectCode, projectCode));
  for (const k of costs) at(k.wbsCode ?? root).actualIqd += parseDecimal(k.amountIqd, MONEY);

  const totals = rollUp(elements, own);
  const parentOf = new Map(elements.map((e) => [e.code, e.parentCode] as const));
  let cursor: string | null = wbsCode;
  let carrier = root;
  while (cursor) {
    if ((totals.get(cursor)?.budgetIqd ?? 0n) > 0n) {
      carrier = cursor;
      break;
    }
    cursor = parentOf.get(cursor) ?? null;
  }
  const sum = totals.get(carrier) ?? { budgetIqd: 0n, committedIqd: 0n, actualIqd: 0n };
  const element = elements.find((e) => e.code === carrier)!;
  return {
    wbsCode: carrier,
    budgetIqd: sum.budgetIqd,
    assignedIqd: sum.committedIqd + sum.actualIqd,
    raisedStopPercent: element.raised === null ? null : Number(element.raised),
    responsibleUserId: element.responsibleUserId,
  };
}

/** Where an element stands now, for the screens. */
export async function availabilityOf(tx: Tx, projectCode: string, wbsCode: string) {
  const row = await load(tx, projectCode);
  const profile = await profileOf(tx, row.toleranceProfileCode);
  const carrier = await carryingElement(tx, projectCode, wbsCode);
  return { carrier: carrier.wbsCode, ...availabilityDecision(carrier.budgetIqd, carrier.assignedIqd, 0n, profile, carrier.raisedStopPercent) };
}

/**
 * PM5 — the check every assignment passes: refused above the stop line;
 * the responsible person and the project manager told when the warning
 * line is crossed; the crossing audited. Called by `projects.assertSpendable`
 * for every commitment, cost and issue that names an element.
 */
export async function assertAvailable(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  wbsCode: string,
  requestedIqd: bigint,
): Promise<AvailabilityDecision> {
  const row = await load(tx, projectCode);
  const profile = await profileOf(tx, row.toleranceProfileCode);
  const carrier = await carryingElement(tx, projectCode, wbsCode);
  const decision = availabilityDecision(carrier.budgetIqd, carrier.assignedIqd, requestedIqd, profile, carrier.raisedStopPercent);
  if (decision.state === 'stop' && requestedIqd > 0n) {
    throw new AvailabilityStopError(projectCode, carrier.wbsCode, decision, requestedIqd);
  }
  if (decision.crossedWarn) {
    const percent = decision.percentAfter === null ? '' : `${decision.percentAfter.toFixed(2)} %`;
    const recipients = new Set<string>([carrier.responsibleUserId, row.managerUserId].filter((id): id is string => Boolean(id)));
    const today = businessToday();
    for (const recipientUserId of recipients) {
      await notifications.insertNotification(tx, {
        ruleCode: null,
        eventType: 'project.availability_warning',
        objectType: projects.DOCUMENT_TYPE,
        objectId: projectCode,
        recipientUserId,
        subject: `${projectCode} / ${carrier.wbsCode}: ${percent} of the budget is assigned`,
        body:
          `The element ${carrier.wbsCode} on ${projectCode} has ${toDecimalString(decision.availableAfterIqd, MONEY)} IQD left of ` +
          `${toDecimalString(carrier.budgetIqd, MONEY)} IQD after this assignment — the warning line of ${profile.warnPercent} % is reached; ` +
          `the stop line is ${decision.stopPercent} %.`,
        context: { projectCode, wbsCode: carrier.wbsCode, percentAfter: decision.percentAfter, requestedIqd: toDecimalString(requestedIqd, MONEY) },
        dedupeKey: `project_availability:${projectCode}:${carrier.wbsCode}:warn:${today}:${recipientUserId}`,
        branchCode: row.branchCode,
      });
    }
    await recordChange(tx, ctx, {
      action: 'project.availability_warned',
      objectType: projects.DOCUMENT_TYPE,
      objectId: projectCode,
      branchCode: row.branchCode,
      after: { wbsCode: carrier.wbsCode, percentAfter: decision.percentAfter, requestedIqd: toDecimalString(requestedIqd, MONEY), availableAfterIqd: toDecimalString(decision.availableAfterIqd, MONEY) },
    });
  }
  return decision;
}

/**
 * D-PM-5 — the stop line raised for one element with a reason: the project
 * manager to 110 %, the accounting manager beyond. Recorded on the element
 * and in the audit; cleared by raising it to nothing.
 */
export async function raiseStopLine(tx: Tx, ctx: ActorContext, projectCode: string, wbsCode: string, percent: string | null, reason: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'submit', PERMISSION_OBJECT, projectCode);
  const [element] = await tx.select().from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, wbsCode))).limit(1);
  if (!element) throw new AdminNotFoundError('project_wbs', wbsCode);
  const why = requireText(reason, 'reason');
  const text = (percent ?? '').trim();
  const value = text ? Number(text) : null;
  if (value !== null) {
    const profile = await profileOf(tx, row.toleranceProfileCode);
    const mayExceed = ctx.principal.isSuperUser || ctx.principal.roleCodes.includes('accounting_manager');
    assertRaisedStopLine(value, profile, mayExceed);
  }
  await tx
    .update(projectWbs)
    .set(
      value === null
        ? { stopPercentRaised: null, stopRaisedReason: null, stopRaisedBy: null, stopRaisedAt: null, updatedAt: new Date() }
        : { stopPercentRaised: value.toFixed(4), stopRaisedReason: why, stopRaisedBy: ctx.principal.userId, stopRaisedAt: new Date(), updatedAt: new Date() },
    )
    .where(eq(projectWbs.id, element.id));
  await recordChange(tx, ctx, {
    action: value === null ? 'project_wbs.stop_line_restored' : 'project_wbs.stop_line_raised',
    objectType: 'project_wbs',
    objectId: `${projectCode}:${wbsCode}`,
    branchCode: row.branchCode,
    before: { stopPercentRaised: element.stopPercentRaised },
    after: { stopPercentRaised: value },
    reason: why,
  });
}

// ---------------------------------------------------------------------------
// Budget documents (§7, PM4)
// ---------------------------------------------------------------------------

export interface BudgetDocumentInput {
  readonly kind: string;
  readonly raisedOn?: string | null;
  readonly description: string;
  readonly lines: readonly { readonly wbsCode: string; readonly costCode: string; readonly amountIqd: string | bigint; readonly description?: string | null }[];
}

function kindOf(value: string): BudgetDocumentKind {
  if (!(BUDGET_DOCUMENT_KINDS as readonly string[]).includes(value)) throw new ProjectSystemError('kind', `'${value}' is not a budget document kind`);
  return value as BudgetDocumentKind;
}

async function checkLines(tx: Tx, projectCode: string, lines: BudgetDocumentInput['lines']): Promise<BudgetLineInput[]> {
  const elements = await tx.select({ code: projectWbs.code, active: projectWbs.active, isPlanning: projectWbs.isPlanning }).from(projectWbs).where(eq(projectWbs.projectCode, projectCode));
  const codes = await tx.select({ code: projectCostCode.code, active: projectCostCode.active }).from(projectCostCode);
  return lines.map((line, i) => {
    const wbsCode = (line.wbsCode ?? '').trim();
    const costCode = (line.costCode ?? '').trim().toUpperCase();
    const element = elements.find((e) => e.code === wbsCode);
    if (!element) throw new ProjectSystemError(`line ${i + 1}`, `${projectCode} has no element '${wbsCode}'`);
    if (!element.active) throw new ProjectSystemError(`line ${i + 1}`, `${wbsCode} is deactivated`);
    if (!element.isPlanning) throw new ProjectSystemError(`line ${i + 1}`, `${wbsCode} is not a planning element — no budget is planned there (§5)`);
    const code = codes.find((c) => c.code === costCode);
    if (!code) throw new ProjectSystemError(`line ${i + 1}`, `there is no cost code '${costCode}'`);
    if (!code.active) throw new ProjectSystemError(`line ${i + 1}`, `cost code ${costCode} is deactivated`);
    return { wbsCode, costCode, amountIqd: money(line.amountIqd, `line ${i + 1}`), description: optionalText(line.description) };
  });
}

async function writeLines(tx: Tx, documentId: string, projectCode: string, lines: readonly BudgetLineInput[]): Promise<void> {
  await tx.delete(projectBudgetDocumentLine).where(eq(projectBudgetDocumentLine.documentId, documentId));
  await tx.insert(projectBudgetDocumentLine).values(
    lines.map((line, i) => ({
      documentId,
      projectCode,
      lineNo: i + 1,
      wbsCode: line.wbsCode,
      costCode: line.costCode,
      amountIqd: toDecimalString(line.amountIqd, MONEY),
      description: line.description ?? null,
    })),
  );
}

export async function createBudgetDocument(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: BudgetDocumentInput,
  options: { variationId?: string | null; createdBy?: string | null } = {},
): Promise<{ id: string; documentNo: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'create', PERMISSION_OBJECT, projectCode);
  if (row.status === 'closed') throw new ProjectSystemError('status', `${projectCode} is closed; its budget is history`);
  const kind = kindOf(input.kind);
  if (kind === 'original' && (await hasOriginal(tx, projectCode))) throw new ProjectSystemError('kind', `${projectCode} already has its original budget; what follows is a supplement, a return or a transfer`);
  const lines = await checkLines(tx, projectCode, input.lines);
  const total = budgetDocumentTotal(kind, lines);
  const raisedOn = day(input.raisedOn, 'raised_on') ?? businessToday();
  const description = requireText(input.description, 'description', 500);
  const branchCode = row.branchCode ?? ctx.branchCode;
  const { documentNo } = await allocateDocumentNumber(tx, BUDGET_SEQUENCE_KEY, { branchCode, year: Number(raisedOn.slice(0, 4)) }, ctx.principal.userId);
  const [created] = await tx
    .insert(projectBudgetDocument)
    .values({
      documentNo,
      projectCode,
      kind,
      raisedOn,
      description,
      variationId: options.variationId ?? null,
      totalIqd: toDecimalString(total, MONEY),
      createdBy: options.createdBy ?? ctx.principal.userId,
    })
    .returning({ id: projectBudgetDocument.id });
  await writeLines(tx, created!.id, projectCode, lines);
  await recordChange(tx, ctx, {
    action: 'project_budget.created',
    objectType: BUDGET_DOCUMENT_TYPE,
    objectId: documentNo,
    branchCode,
    after: { projectCode, kind, totalIqd: toDecimalString(total, MONEY), lines: lines.length, variationId: options.variationId ?? null },
  });
  return { id: created!.id, documentNo };
}

async function hasOriginal(tx: Tx, projectCode: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: projectBudgetDocument.id })
    .from(projectBudgetDocument)
    .where(and(eq(projectBudgetDocument.projectCode, projectCode), eq(projectBudgetDocument.kind, 'original'), inArray(projectBudgetDocument.status, ['draft', 'submitted', 'approved'])))
    .limit(1);
  return Boolean(row);
}

async function loadDocument(tx: Tx, documentNo: string) {
  const [row] = await tx.select().from(projectBudgetDocument).where(eq(projectBudgetDocument.documentNo, documentNo)).limit(1);
  if (!row) throw new AdminNotFoundError('project_budget', documentNo);
  return row;
}

/** A draft is corrected in place; anything further along is a new document. */
export async function updateBudgetDocument(tx: Tx, ctx: ActorContext, documentNo: string, input: Omit<BudgetDocumentInput, 'kind'>): Promise<void> {
  const doc = await loadDocument(tx, documentNo);
  const row = await load(tx, doc.projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, doc.projectCode);
  if (doc.status !== 'draft') throw new ProjectSystemError('status', `${documentNo} is ${doc.status}; only a draft is changed`);
  const lines = await checkLines(tx, doc.projectCode, input.lines);
  const total = budgetDocumentTotal(doc.kind as BudgetDocumentKind, lines);
  const description = requireText(input.description, 'description', 500);
  const raisedOn = day(input.raisedOn, 'raised_on') ?? doc.raisedOn;
  await tx.update(projectBudgetDocument).set({ description, raisedOn, totalIqd: toDecimalString(total, MONEY), updatedAt: new Date() }).where(eq(projectBudgetDocument.id, doc.id));
  await writeLines(tx, doc.id, doc.projectCode, lines);
  await recordChange(tx, ctx, {
    action: 'project_budget.updated',
    objectType: BUDGET_DOCUMENT_TYPE,
    objectId: documentNo,
    branchCode: row.branchCode,
    before: { description: doc.description, totalIqd: doc.totalIqd },
    after: { description, totalIqd: toDecimalString(total, MONEY), lines: lines.length },
  });
}

export async function submitBudgetDocument(tx: Tx, ctx: ActorContext, documentNo: string): Promise<void> {
  const doc = await loadDocument(tx, documentNo);
  const row = await load(tx, doc.projectCode);
  await permit(ctx, 'submit', PERMISSION_OBJECT, doc.projectCode);
  if (doc.status !== 'draft') throw new ProjectSystemError('status', `${documentNo} is ${doc.status}; only a draft is submitted`);
  await tx.update(projectBudgetDocument).set({ status: 'submitted', submittedBy: ctx.principal.userId, submittedAt: new Date(), updatedAt: new Date() }).where(eq(projectBudgetDocument.id, doc.id));
  await recordChange(tx, ctx, { action: 'project_budget.submitted', objectType: BUDGET_DOCUMENT_TYPE, objectId: documentNo, branchCode: row.branchCode, before: { status: 'draft' }, after: { status: 'submitted' } });
}

/**
 * PM4 — approval by somebody other than the raiser. The original writes
 * each cost code's `baseline_iqd` once; a supplement, a return and a
 * transfer move the current figure and leave the baseline. A return or a
 * transfer may not take more from an element than it has unassigned.
 */
export async function approveBudgetDocument(tx: Tx, ctx: ActorContext, documentNo: string): Promise<void> {
  const doc = await loadDocument(tx, documentNo);
  const row = await load(tx, doc.projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, doc.projectCode);
  if (doc.status !== 'submitted') throw new ProjectSystemError('status', `${documentNo} is ${doc.status}; a submitted document is approved`);
  // the super user approves alone, by direction 2026-10-03.
  if (doc.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) throw new ProjectSystemError('approver', `${documentNo} was raised by you; somebody else approves it (PM4)`);
  if (row.status === 'closed') throw new ProjectSystemError('status', `${doc.projectCode} is closed`);
  const lines = await tx.select().from(projectBudgetDocumentLine).where(eq(projectBudgetDocumentLine.documentId, doc.id)).orderBy(asc(projectBudgetDocumentLine.lineNo));
  const kind = doc.kind as BudgetDocumentKind;

  if (kind === 'return' || kind === 'transfer') {
    // Taking budget an element has already promised or spent would leave it
    // over its line the moment the document is approved.
    const profile = await profileOf(tx, row.toleranceProfileCode);
    for (const line of lines) {
      const amount = parseDecimal(line.amountIqd, MONEY);
      if (amount >= 0n) continue;
      const carrier = await carryingElement(tx, doc.projectCode, line.wbsCode);
      if (carrier.wbsCode !== line.wbsCode) continue;
      const after = availabilityDecision(carrier.budgetIqd + amount, carrier.assignedIqd, 0n, profile, carrier.raisedStopPercent);
      if (after.state === 'stop') {
        throw new ProjectSystemError(`line ${line.lineNo}`, `${line.wbsCode} has ${toDecimalString(carrier.budgetIqd - carrier.assignedIqd, MONEY)} unassigned; taking ${toDecimalString(-amount, MONEY)} leaves it over its stop line`);
      }
    }
  }

  if (kind === 'original') {
    const byCostCode = new Map<string, { total: bigint; wbsCodes: Set<string> }>();
    for (const line of lines) {
      const entry = byCostCode.get(line.costCode) ?? { total: 0n, wbsCodes: new Set<string>() };
      entry.total += parseDecimal(line.amountIqd, MONEY);
      entry.wbsCodes.add(line.wbsCode);
      byCostCode.set(line.costCode, entry);
    }
    const codes = await tx.select().from(projectCostCode);
    for (const [costCode, entry] of byCostCode) {
      const [existing] = await tx.select().from(projectBudgetLine).where(and(eq(projectBudgetLine.projectCode, doc.projectCode), eq(projectBudgetLine.costCode, costCode))).limit(1);
      const wbsCode = entry.wbsCodes.size === 1 ? [...entry.wbsCodes][0]! : null;
      if (existing) {
        if (parseDecimal(existing.baselineIqd, MONEY) !== 0n) throw new ProjectSystemError('baseline', `${costCode} already carries a baseline of ${existing.baselineIqd}; the baseline is written once (R2)`);
        await tx
          .update(projectBudgetLine)
          .set({ baselineIqd: toDecimalString(entry.total, MONEY), forecastIqd: toDecimalString(entry.total, MONEY), wbsCode: existing.wbsCode ?? wbsCode, updatedAt: new Date() })
          .where(eq(projectBudgetLine.id, existing.id));
      } else {
        const code = codes.find((c) => c.code === costCode);
        await tx.insert(projectBudgetLine).values({
          projectCode: doc.projectCode,
          costCode,
          description: code?.nameEn ?? costCode,
          wbsCode,
          accountId: code?.accountId ?? null,
          baselineIqd: toDecimalString(entry.total, MONEY),
          forecastIqd: toDecimalString(entry.total, MONEY),
        });
      }
    }
  }

  await tx.update(projectBudgetDocument).set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() }).where(eq(projectBudgetDocument.id, doc.id));
  await recordChange(tx, ctx, {
    action: 'project_budget.approved',
    objectType: BUDGET_DOCUMENT_TYPE,
    objectId: documentNo,
    branchCode: row.branchCode,
    before: { status: 'submitted' },
    after: { status: 'approved', kind, totalIqd: doc.totalIqd, lines: lines.length },
  });
}

export async function rejectBudgetDocument(tx: Tx, ctx: ActorContext, documentNo: string, reason: string): Promise<void> {
  const doc = await loadDocument(tx, documentNo);
  const row = await load(tx, doc.projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, doc.projectCode);
  if (doc.status !== 'submitted') throw new ProjectSystemError('status', `${documentNo} is ${doc.status}; a submitted document is rejected`);
  const why = requireText(reason, 'reason');
  await tx.update(projectBudgetDocument).set({ status: 'rejected', rejectedBy: ctx.principal.userId, rejectedAt: new Date(), rejectedReason: why, updatedAt: new Date() }).where(eq(projectBudgetDocument.id, doc.id));
  await recordChange(tx, ctx, { action: 'project_budget.rejected', objectType: BUDGET_DOCUMENT_TYPE, objectId: documentNo, branchCode: row.branchCode, before: { status: 'submitted' }, after: { status: 'rejected' }, reason: why });
}

export interface BudgetListFilter {
  readonly projectCode?: string | null;
  readonly status?: string | null;
  readonly kind?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

export async function budgetDocuments(tx: Tx, filter: BudgetListFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, filter.pageSize ?? PAGE_SIZE));
  const where = [
    filter.projectCode ? sql`d.project_code = ${filter.projectCode}` : null,
    filter.status ? sql`d.status = ${filter.status}` : null,
    filter.kind ? sql`d.kind = ${filter.kind}` : null,
    filter.search ? sql`(d.document_no ilike ${'%' + filter.search + '%'} or d.description ilike ${'%' + filter.search + '%'} or p.name ilike ${'%' + filter.search + '%'})` : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const [count] = (await tx.execute(sql`select count(*)::int as n from project_budget_document d join project p on p.code = d.project_code ${whereSql}`)).rows as { n: number }[];
  const rows = (
    await tx.execute(sql`
      select d.document_no, d.project_code, p.name as project_name, d.kind, d.status, d.raised_on::text, d.description, d.total_iqd::text,
             u.display_name as raised_by, a.display_name as approved_by, (select count(*) from project_budget_document_line l where l.document_id = d.id)::int as lines
        from project_budget_document d
        join project p on p.code = d.project_code
        join app_user u on u.id = d.created_by
        left join app_user a on a.id = d.approved_by
        ${whereSql}
       order by d.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}`)
  ).rows as {
    document_no: string;
    project_code: string;
    project_name: string;
    kind: string;
    status: string;
    raised_on: string;
    description: string;
    total_iqd: string;
    raised_by: string;
    approved_by: string | null;
    lines: number;
  }[];
  return {
    total: count?.n ?? 0,
    page,
    pageSize,
    rows: rows.map((r) => ({
      documentNo: r.document_no,
      projectCode: r.project_code,
      projectName: r.project_name,
      kind: r.kind as BudgetDocumentKind,
      status: r.status,
      raisedOn: r.raised_on,
      description: r.description,
      totalIqd: r.total_iqd,
      raisedBy: r.raised_by,
      approvedBy: r.approved_by,
      lines: r.lines,
    })),
  };
}

export async function budgetDocument(tx: Tx, ctx: ActorContext, documentNo: string) {
  const doc = await loadDocument(tx, documentNo);
  const row = await load(tx, doc.projectCode);
  await permit(ctx, 'view', PERMISSION_OBJECT, doc.projectCode);
  const lines = await tx
    .select({ line: projectBudgetDocumentLine, elementName: projectWbs.name, costName: projectCostCode.nameEn, costNameAr: projectCostCode.nameAr })
    .from(projectBudgetDocumentLine)
    .leftJoin(projectWbs, and(eq(projectWbs.projectCode, projectBudgetDocumentLine.projectCode), eq(projectWbs.code, projectBudgetDocumentLine.wbsCode)))
    .leftJoin(projectCostCode, eq(projectCostCode.code, projectBudgetDocumentLine.costCode))
    .where(eq(projectBudgetDocumentLine.documentId, doc.id))
    .orderBy(asc(projectBudgetDocumentLine.lineNo));
  const ids = [doc.createdBy, doc.submittedBy, doc.approvedBy, doc.rejectedBy].filter((id): id is string => Boolean(id));
  const people = ids.length ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, ids)) : [];
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  const variation = doc.variationId ? (await tx.select({ variationNo: projectVariation.variationNo }).from(projectVariation).where(eq(projectVariation.id, doc.variationId)).limit(1))[0] ?? null : null;
  return {
    document: doc,
    project: row,
    lines: lines.map((l) => ({ ...l.line, elementName: l.elementName, costName: l.costName, costNameAr: l.costNameAr })),
    people: { createdBy: nameOf(doc.createdBy), submittedBy: nameOf(doc.submittedBy), approvedBy: nameOf(doc.approvedBy), rejectedBy: nameOf(doc.rejectedBy) },
    variationNo: variation?.variationNo ?? null,
    budget: await budgetSummary(tx, doc.projectCode),
  };
}

/** The budget by element — original, supplements, returns, transfers, current — in tree order, with the assignment. */
export async function budgetSummary(tx: Tx, projectCode: string) {
  const elements = await tx
    .select({ code: projectWbs.code, parentCode: projectWbs.parentCode, level: projectWbs.level, name: projectWbs.name, raised: projectWbs.stopPercentRaised, isPlanning: projectWbs.isPlanning, active: projectWbs.active })
    .from(projectWbs)
    .where(eq(projectWbs.projectCode, projectCode));
  const budget = await budgetByElement(tx, projectCode);
  const { own: ownBudget, source } = await ownBudgetByElement(tx, projectCode);
  const commitments = await tx
    .select({ wbsCode: projectCommitment.wbsCode, amountIqd: projectCommitment.amountIqd, consumedIqd: projectCommitment.consumedIqd, releasedOn: projectCommitment.releasedOn })
    .from(projectCommitment)
    .where(eq(projectCommitment.projectCode, projectCode));
  const costs = await tx.select({ wbsCode: projectCost.wbsCode, amountIqd: projectCost.amountIqd }).from(projectCost).where(eq(projectCost.projectCode, projectCode));
  const root = elements.find((e) => e.level === 1)?.code ?? null;
  const assigned = new Map<string, bigint>();
  const addAssigned = (code: string | null, amount: bigint) => assigned.set(code ?? root ?? '', (assigned.get(code ?? root ?? '') ?? 0n) + amount);
  for (const c of commitments) if (!c.releasedOn) addAssigned(c.wbsCode, parseDecimal(c.amountIqd, MONEY) - parseDecimal(c.consumedIqd, MONEY));
  for (const k of costs) addAssigned(k.wbsCode, parseDecimal(k.amountIqd, MONEY));
  const own = new Map(elements.map((e) => [e.code, { budgetIqd: ownBudget.get(e.code) ?? 0n, committedIqd: assigned.get(e.code) ?? 0n, actualIqd: 0n }] as const));
  const totals = rollUp(elements, own);
  return treeOrder(
    elements.map((e) => {
      const b = budget.get(e.code);
      const sum = totals.get(e.code)!;
      return {
        wbsCode: e.code,
        parentCode: e.parentCode,
        level: e.level,
        name: e.name,
        isPlanning: e.isPlanning,
        active: e.active,
        originalIqd: toDecimalString(source === 'documents' ? (b?.originalIqd ?? 0n) : (ownBudget.get(e.code) ?? 0n) - (b?.currentIqd ?? 0n), MONEY),
        supplementsIqd: toDecimalString(b?.supplementsIqd ?? 0n, MONEY),
        returnsIqd: toDecimalString(b?.returnsIqd ?? 0n, MONEY),
        transfersIqd: toDecimalString(b?.transfersIqd ?? 0n, MONEY),
        currentIqd: toDecimalString(ownBudget.get(e.code) ?? 0n, MONEY),
        /** Own plus descendants. */
        rolledUpIqd: toDecimalString(sum.budgetIqd, MONEY),
        assignedIqd: toDecimalString(sum.committedIqd, MONEY),
        availableIqd: toDecimalString(sum.budgetIqd - sum.committedIqd, MONEY),
        stopPercentRaised: e.raised === null ? null : Number(e.raised),
      };
    }).map((r) => ({ ...r, code: r.wbsCode })),
  );
}

// ---------------------------------------------------------------------------
// The cost plan in versions (§7)
// ---------------------------------------------------------------------------

export async function planVersions(tx: Tx, projectCode: string) {
  return tx
    .select({ version: projectPlanVersion, createdByName: appUser.displayName })
    .from(projectPlanVersion)
    .leftJoin(appUser, eq(appUser.id, projectPlanVersion.createdBy))
    .where(eq(projectPlanVersion.projectCode, projectCode))
    .orderBy(desc(projectPlanVersion.version));
}

/** Version 0 the first time, n+1 after; the new one is current and may copy the last. */
export async function createPlanVersion(tx: Tx, ctx: ActorContext, projectCode: string, input: { name: string; note?: string | null; copyCurrent?: boolean }): Promise<{ id: string; version: number }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (row.status === 'closed' || row.status === 'closing') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; the plan is not re-planned`);
  const name = requireText(input.name, 'name');
  const existing = await tx.select({ id: projectPlanVersion.id, version: projectPlanVersion.version, isCurrent: projectPlanVersion.isCurrent }).from(projectPlanVersion).where(eq(projectPlanVersion.projectCode, projectCode));
  const version = existing.length === 0 ? 0 : Math.max(...existing.map((v) => v.version)) + 1;
  const current = existing.find((v) => v.isCurrent) ?? null;
  if (current) await tx.update(projectPlanVersion).set({ isCurrent: false }).where(eq(projectPlanVersion.id, current.id));
  const [created] = await tx
    .insert(projectPlanVersion)
    .values({ projectCode, version, name, note: optionalText(input.note), isCurrent: true, createdBy: ctx.principal.userId })
    .returning({ id: projectPlanVersion.id });
  if (input.copyCurrent && current) {
    await tx.execute(sql`
      insert into project_plan_line (project_code, version_id, wbs_code, cost_code, period, amount_iqd, updated_by)
      select project_code, ${created!.id}::uuid, wbs_code, cost_code, period, amount_iqd, ${ctx.principal.userId}::uuid
        from project_plan_line where version_id = ${current.id}`);
  }
  await recordChange(tx, ctx, {
    action: 'project_plan.version_created',
    objectType: PLAN_DOCUMENT_TYPE,
    objectId: `${projectCode}:${version}`,
    branchCode: row.branchCode,
    after: { version, name, copiedFrom: input.copyCurrent && current ? current.version : null },
  });
  return { id: created!.id, version };
}

async function currentVersion(tx: Tx, projectCode: string) {
  const [row] = await tx.select().from(projectPlanVersion).where(and(eq(projectPlanVersion.projectCode, projectCode), eq(projectPlanVersion.isCurrent, true))).limit(1);
  return row ?? null;
}

/** One cell of the plan: element × cost code × month. Only the current version is written. */
export async function setPlanLine(tx: Tx, ctx: ActorContext, projectCode: string, input: { wbsCode: string; costCode: string; period: string; amountIqd: string | bigint }): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const version = await currentVersion(tx, projectCode);
  if (!version) throw new ProjectSystemError('version', `${projectCode} has no plan version yet`);
  const [line] = await checkLines(tx, projectCode, [{ wbsCode: input.wbsCode, costCode: input.costCode, amountIqd: input.amountIqd === '' ? '0' : input.amountIqd }]);
  const period = day(input.period, 'period');
  if (!period) throw new ProjectSystemError('period', 'is required');
  const month = `${period.slice(0, 7)}-01`;
  const amount = money(input.amountIqd, 'amount');
  if (amount < 0n) throw new ProjectSystemError('amount', 'a plan amount is not negative');
  await tx.execute(sql`
    insert into project_plan_line (project_code, version_id, wbs_code, cost_code, period, amount_iqd, updated_by, updated_at)
    values (${projectCode}, ${version.id}::uuid, ${line!.wbsCode}, ${line!.costCode}, ${month}::date, ${toDecimalString(amount, MONEY)}, ${ctx.principal.userId}::uuid, now())
    on conflict (version_id, wbs_code, cost_code, period)
    do update set amount_iqd = excluded.amount_iqd, updated_by = excluded.updated_by, updated_at = now()`);
  await recordChange(tx, ctx, {
    action: 'project_plan.line_set',
    objectType: PLAN_DOCUMENT_TYPE,
    objectId: `${projectCode}:${version.version}`,
    branchCode: row.branchCode,
    after: { wbsCode: line!.wbsCode, costCode: line!.costCode, period: month, amountIqd: toDecimalString(amount, MONEY) },
  });
}

/** A total spread evenly over the months from `from` to `to` — the usual way a plan is typed. */
export async function spreadPlan(tx: Tx, ctx: ActorContext, projectCode: string, input: { wbsCode: string; costCode: string; from: string; to: string; totalIqd: string | bigint }): Promise<number> {
  const from = day(input.from, 'from');
  const to = day(input.to, 'to');
  if (!from || !to) throw new ProjectSystemError('period', 'the spread needs a first and a last month');
  const months = monthsBetween(from, to);
  const spread = spreadEvenly(money(input.totalIqd, 'total'), months);
  for (const [period, amountIqd] of spread) await setPlanLine(tx, ctx, projectCode, { wbsCode: input.wbsCode, costCode: input.costCode, period, amountIqd });
  return months.length;
}

export async function planLines(tx: Tx, projectCode: string, versionId?: string | null) {
  const version = versionId ? (await tx.select().from(projectPlanVersion).where(eq(projectPlanVersion.id, versionId)).limit(1))[0] ?? null : await currentVersion(tx, projectCode);
  if (!version) return { version: null, lines: [] as { wbsCode: string; costCode: string; period: string; amountIqd: string }[], months: [] as string[] };
  const lines = await tx
    .select({ wbsCode: projectPlanLine.wbsCode, costCode: projectPlanLine.costCode, period: projectPlanLine.period, amountIqd: projectPlanLine.amountIqd })
    .from(projectPlanLine)
    .where(eq(projectPlanLine.versionId, version.id))
    .orderBy(asc(projectPlanLine.wbsCode), asc(projectPlanLine.costCode), asc(projectPlanLine.period));
  const months = [...new Set(lines.map((l) => l.period))].sort();
  return { version, lines, months };
}

/** The plan by element (own plus descendants) for the current version — the record's register and BCWS's input. */
export async function planByElement(tx: Tx, projectCode: string) {
  const { version, lines } = await planLines(tx, projectCode);
  const elements = await tx.select({ code: projectWbs.code, parentCode: projectWbs.parentCode, level: projectWbs.level }).from(projectWbs).where(eq(projectWbs.projectCode, projectCode));
  const own = new Map<string, { budgetIqd: bigint; committedIqd: bigint; actualIqd: bigint }>();
  for (const l of lines) {
    const current = own.get(l.wbsCode) ?? { budgetIqd: 0n, committedIqd: 0n, actualIqd: 0n };
    current.budgetIqd += parseDecimal(l.amountIqd, MONEY);
    own.set(l.wbsCode, current);
  }
  const totals = rollUp(elements, own);
  return { version, planned: new Map([...totals].map(([code, t]) => [code, t.budgetIqd] as const)) };
}

// ---------------------------------------------------------------------------
// Change orders (§7) — Phase 11's variations with lines, raising their supplement
// ---------------------------------------------------------------------------

export interface ChangeOrderInput {
  readonly description: string;
  readonly scopeNote?: string | null;
  readonly raisedOn?: string | null;
  readonly contractDeltaIqd?: string | bigint | null;
  readonly scheduleDeltaDays?: string | number | null;
  readonly revisedEndsOn?: string | null;
  readonly supersedesNo?: string | null;
  readonly lines: readonly { readonly wbsCode: string; readonly costCode: string; readonly amountIqd: string | bigint; readonly description?: string | null }[];
}

export async function raiseChangeOrder(tx: Tx, ctx: ActorContext, projectCode: string, input: ChangeOrderInput): Promise<{ id: string; variationNo: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'create', PERMISSION_OBJECT, projectCode);
  if (!['active', 'on_hold'].includes(row.status)) throw new ProjectSystemError('status', `${projectCode} is ${row.status}; a change order needs a released project`);
  const lines = input.lines.length ? await checkLines(tx, projectCode, input.lines) : [];
  for (const line of lines) if (line.amountIqd === 0n) throw new ProjectSystemError('lines', 'a line of zero moves nothing');
  const budgetDelta = lines.reduce((sum, l) => sum + l.amountIqd, 0n);
  const contractDelta = money(input.contractDeltaIqd, 'contract_delta');
  const days = input.scheduleDeltaDays === null || input.scheduleDeltaDays === undefined || input.scheduleDeltaDays === '' ? 0 : Number(input.scheduleDeltaDays);
  if (!Number.isInteger(days)) throw new ProjectSystemError('schedule_delta_days', 'is a whole number of days');
  const revisedEndsOn = day(input.revisedEndsOn, 'revised_ends_on');
  if (row.typeCode !== 'CUSTOMER' && contractDelta !== 0n) throw new ProjectSystemError('contract_delta', `${projectCode} has no customer contract to change`);
  const raisedOn = day(input.raisedOn, 'raised_on') ?? businessToday();
  const branchCode = row.branchCode ?? ctx.branchCode;
  const { documentNo } = await allocateDocumentNumber(tx, VARIATION_SEQUENCE_KEY, { branchCode, year: Number(raisedOn.slice(0, 4)) }, ctx.principal.userId);
  let supersedesId: string | null = null;
  if (input.supersedesNo) {
    const [previous] = await tx.select({ id: projectVariation.id, projectCode: projectVariation.projectCode }).from(projectVariation).where(eq(projectVariation.variationNo, input.supersedesNo)).limit(1);
    if (!previous || previous.projectCode !== projectCode) throw new ProjectSystemError('supersedes', `${projectCode} has no change order ${input.supersedesNo}`);
    supersedesId = previous.id;
  }
  const { id } = await projects.raiseVariation(tx, ctx, projectCode, {
    variationNo: documentNo,
    raisedOn,
    description: requireText(input.description, 'description', 500),
    contractDeltaIqd: contractDelta,
    budgetDeltaIqd: budgetDelta,
    revisedEndsOn,
    supersedesId,
  });
  await tx.update(projectVariation).set({ scopeNote: optionalText(input.scopeNote, 2000), scheduleDeltaDays: days }).where(eq(projectVariation.id, id));
  if (lines.length) {
    await tx.insert(projectVariationLine).values(
      lines.map((line, i) => ({ variationId: id, projectCode, lineNo: i + 1, wbsCode: line.wbsCode, costCode: line.costCode, amountIqd: toDecimalString(line.amountIqd, MONEY), description: line.description ?? null })),
    );
  }
  await recordChange(tx, ctx, {
    action: 'project_variation.raised',
    objectType: VARIATION_DOCUMENT_TYPE,
    objectId: documentNo,
    branchCode,
    after: { projectCode, contractDeltaIqd: toDecimalString(contractDelta, MONEY), budgetDeltaIqd: toDecimalString(budgetDelta, MONEY), scheduleDeltaDays: days, revisedEndsOn, lines: lines.length },
  });
  return { id, variationNo: documentNo };
}

async function loadVariation(tx: Tx, variationNo: string) {
  const [row] = await tx.select().from(projectVariation).where(eq(projectVariation.variationNo, variationNo)).limit(1);
  if (!row) throw new AdminNotFoundError('project_variation', variationNo);
  return row;
}

/**
 * The commercial and the budget approval, each by somebody other than the
 * raiser. When both are in: the supplement (or return) the lines describe
 * is raised and approved in the same breath, the forecast finish moves by
 * the schedule effect, and the baseline stays where it was (R2).
 */
export async function approveChangeOrder(tx: Tx, ctx: ActorContext, variationNo: string, which: 'commercial' | 'budget'): Promise<{ approved: boolean; budgetDocumentNo: string | null }> {
  const variation = await loadVariation(tx, variationNo);
  const row = await load(tx, variation.projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, variation.projectCode);
  if (variation.status !== 'draft') throw new ProjectSystemError('status', `${variationNo} is ${variation.status}`);
  // the super user approves alone, by direction 2026-10-03.
  if (variation.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) throw new ProjectSystemError('approver', `${variationNo} was raised by you; somebody else approves it`);
  if ((which === 'commercial' && variation.commercialApprovedBy) || (which === 'budget' && variation.budgetApprovedBy)) {
    throw new ProjectSystemError('approver', `${variationNo} already carries its ${which} approval`);
  }
  const { approved } = await projects.approveVariation(tx, ctx, variation.id, which);
  let budgetDocumentNo: string | null = null;
  if (approved) {
    const lines = await tx.select().from(projectVariationLine).where(eq(projectVariationLine.variationId, variation.id)).orderBy(asc(projectVariationLine.lineNo));
    if (lines.length) {
      const total = lines.reduce((sum, l) => sum + parseDecimal(l.amountIqd, MONEY), 0n);
      const kind: BudgetDocumentKind = total >= 0n && lines.every((l) => parseDecimal(l.amountIqd, MONEY) > 0n) ? 'supplement' : total <= 0n && lines.every((l) => parseDecimal(l.amountIqd, MONEY) < 0n) ? 'return' : total === 0n ? 'transfer' : 'supplement';
      if (kind === 'supplement' && lines.some((l) => parseDecimal(l.amountIqd, MONEY) < 0n)) {
        throw new ProjectSystemError('lines', `${variationNo} both adds and takes budget without netting to zero; raise it as two change orders`);
      }
      const created = await createBudgetDocument(
        tx,
        ctx,
        variation.projectCode,
        {
          kind,
          raisedOn: businessToday(),
          description: `${variationNo}: ${variation.description}`,
          lines: lines.map((l) => ({ wbsCode: l.wbsCode, costCode: l.costCode, amountIqd: parseDecimal(l.amountIqd, MONEY), description: l.description })),
        },
        { variationId: variation.id, createdBy: variation.createdBy },
      );
      await submitBudgetDocument(tx, ctx, created.documentNo);
      await approveBudgetDocument(tx, ctx, created.documentNo);
      budgetDocumentNo = created.documentNo;
    }
    const forecastEnd = variation.revisedEndsOn ?? (variation.scheduleDeltaDays && row.forecastEndsOn ? shiftDays(row.forecastEndsOn, variation.scheduleDeltaDays) : null);
    if (forecastEnd) await tx.update(project).set({ forecastEndsOn: forecastEnd, updatedAt: new Date() }).where(eq(project.code, variation.projectCode));
    await recordChange(tx, ctx, {
      action: 'project_variation.approved',
      objectType: VARIATION_DOCUMENT_TYPE,
      objectId: variationNo,
      branchCode: row.branchCode,
      before: { forecastEndsOn: row.forecastEndsOn },
      after: { budgetDocumentNo, forecastEndsOn: forecastEnd ?? row.forecastEndsOn },
    });
  }
  return { approved, budgetDocumentNo };
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function rejectChangeOrder(tx: Tx, ctx: ActorContext, variationNo: string, reason: string): Promise<void> {
  const variation = await loadVariation(tx, variationNo);
  const row = await load(tx, variation.projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, variation.projectCode);
  if (variation.status !== 'draft') throw new ProjectSystemError('status', `${variationNo} is ${variation.status}`);
  const why = requireText(reason, 'reason');
  await tx.update(projectVariation).set({ status: 'rejected', rejectedBy: ctx.principal.userId, rejectedAt: new Date(), rejectedReason: why, updatedAt: new Date() }).where(eq(projectVariation.id, variation.id));
  await recordChange(tx, ctx, { action: 'project_variation.rejected', objectType: VARIATION_DOCUMENT_TYPE, objectId: variationNo, branchCode: row.branchCode, before: { status: 'draft' }, after: { status: 'rejected' }, reason: why });
}

export interface ChangeOrderFilter {
  readonly projectCode?: string | null;
  readonly status?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

export async function changeOrders(tx: Tx, filter: ChangeOrderFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, filter.pageSize ?? PAGE_SIZE));
  const where = [
    filter.projectCode ? sql`v.project_code = ${filter.projectCode}` : null,
    filter.status ? sql`v.status = ${filter.status}` : null,
    filter.search ? sql`(v.variation_no ilike ${'%' + filter.search + '%'} or v.description ilike ${'%' + filter.search + '%'} or p.name ilike ${'%' + filter.search + '%'})` : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const [count] = (await tx.execute(sql`select count(*)::int as n from project_variation v join project p on p.code = v.project_code ${whereSql}`)).rows as { n: number }[];
  const rows = (
    await tx.execute(sql`
      select v.variation_no, v.project_code, p.name as project_name, v.version, v.status, v.raised_on::text, v.description,
             v.contract_delta_iqd::text, v.budget_delta_iqd::text, v.schedule_delta_days, v.revised_ends_on::text,
             (v.commercial_approved_by is not null) as commercial_in, (v.budget_approved_by is not null) as budget_in,
             u.display_name as raised_by
        from project_variation v
        join project p on p.code = v.project_code
        join app_user u on u.id = v.created_by
        ${whereSql}
       order by v.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}`)
  ).rows as {
    variation_no: string;
    project_code: string;
    project_name: string;
    version: number;
    status: string;
    raised_on: string;
    description: string;
    contract_delta_iqd: string;
    budget_delta_iqd: string;
    schedule_delta_days: number;
    revised_ends_on: string | null;
    commercial_in: boolean;
    budget_in: boolean;
    raised_by: string;
  }[];
  return {
    total: count?.n ?? 0,
    page,
    pageSize,
    rows: rows.map((r) => ({
      variationNo: r.variation_no,
      projectCode: r.project_code,
      projectName: r.project_name,
      version: r.version,
      status: r.status,
      raisedOn: r.raised_on,
      description: r.description,
      contractDeltaIqd: r.contract_delta_iqd,
      budgetDeltaIqd: r.budget_delta_iqd,
      scheduleDeltaDays: r.schedule_delta_days,
      revisedEndsOn: r.revised_ends_on,
      commercialIn: r.commercial_in,
      budgetIn: r.budget_in,
      raisedBy: r.raised_by,
    })),
  };
}

export async function changeOrder(tx: Tx, ctx: ActorContext, variationNo: string) {
  const variation = await loadVariation(tx, variationNo);
  const row = await load(tx, variation.projectCode);
  await permit(ctx, 'view', PERMISSION_OBJECT, variation.projectCode);
  const lines = await tx
    .select({ line: projectVariationLine, elementName: projectWbs.name, costName: projectCostCode.nameEn, costNameAr: projectCostCode.nameAr })
    .from(projectVariationLine)
    .leftJoin(projectWbs, and(eq(projectWbs.projectCode, projectVariationLine.projectCode), eq(projectWbs.code, projectVariationLine.wbsCode)))
    .leftJoin(projectCostCode, eq(projectCostCode.code, projectVariationLine.costCode))
    .where(eq(projectVariationLine.variationId, variation.id))
    .orderBy(asc(projectVariationLine.lineNo));
  const ids = [variation.createdBy, variation.commercialApprovedBy, variation.budgetApprovedBy, variation.rejectedBy].filter((id): id is string => Boolean(id));
  const people = ids.length ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, ids)) : [];
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  const [budgetDoc] = await tx.select({ documentNo: projectBudgetDocument.documentNo }).from(projectBudgetDocument).where(eq(projectBudgetDocument.variationId, variation.id)).limit(1);
  const supersedes = variation.supersedesId ? (await tx.select({ variationNo: projectVariation.variationNo }).from(projectVariation).where(eq(projectVariation.id, variation.supersedesId)).limit(1))[0] ?? null : null;
  const versions = await tx
    .select({ variationNo: projectVariation.variationNo, version: projectVariation.version, status: projectVariation.status })
    .from(projectVariation)
    .where(and(eq(projectVariation.projectCode, variation.projectCode), sql`${projectVariation.variationNo} <> ${variationNo}`, sql`(${projectVariation.supersedesId} = ${variation.id} or ${projectVariation.id} = ${variation.supersedesId ?? null}::uuid)`))
    .orderBy(asc(projectVariation.version));
  return {
    variation,
    project: row,
    lines: lines.map((l) => ({ ...l.line, elementName: l.elementName, costName: l.costName, costNameAr: l.costNameAr })),
    people: { createdBy: nameOf(variation.createdBy), commercialBy: nameOf(variation.commercialApprovedBy), budgetBy: nameOf(variation.budgetApprovedBy), rejectedBy: nameOf(variation.rejectedBy) },
    budgetDocumentNo: budgetDoc?.documentNo ?? null,
    supersedesNo: supersedes?.variationNo ?? null,
    versions,
    position: await projects.position(tx, variation.projectCode),
  };
}

/** The project status a change order's screen needs. */
export type { ProjectStatus };
