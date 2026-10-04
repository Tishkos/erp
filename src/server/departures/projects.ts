/**
 * Projects' answer to "where did the stock go?" — IMPROVEMENT-002.
 *
 * A unit issued to a project became the project's cost, so the landed cost of
 * it is project cost too: on the account and with the dimensions the issue's
 * own journal used for its `project_material_cost` line (D-PM-13 — the cost
 * code's account, or the mapping; the project, the warehouse, the project's
 * department and business line), and a `project_cost` row beside it, so the
 * element's actual and the line items carry it.
 *
 * The row is written directly, as a return's is, and not through
 * `projects.recordCost`: the material was issued while the budget allowed it,
 * and the cost of landing it is not new spending to hold against the stop
 * line.
 *
 * A project already **settled** is not reopened (one settlement per project,
 * D-PM-7). The share still goes to the receiver the issue posted to, flagged
 * `post_settlement` on its departure row, and a `project_settlement_supplement`
 * (0286) carries it on to where the settlement put the cost: for an asset
 * settlement a journal of its own through the settlement's event (Dr the
 * asset under construction / Cr the cost), for a result settlement nothing
 * more — the cost row is marked settled, so the project stays fully settled.
 * A closed accounting period refuses the supplement's journal as it refuses
 * any posting.
 *
 * Material that comes **back** after a lock (a return naming the issue line it
 * gives back) brings the share back from the project: the inventory layer
 * posts it (`returnLandedShare`), and here the negative cost row follows.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { toDecimalString } from '../domain/money';
import { settlementKindOf } from '../domain/project-close';
import { formatQuantity } from '../domain/uom';
import * as audit from '../services/audit';
import type { ActorContext } from '../services/chart-of-accounts';
import {
  DepartureError,
  journalLineOf,
  mappedAccount,
  type DepartedMovement,
  type DepartureDestination,
  type DepartureHandler,
  type ReturnedDeparture,
} from '../services/inventory-departures';
import * as posting from '../services/posting';

const rows = <T>(result: { rows: unknown[] }) => result.rows as T[];

/** The project_cost kind of a landed cost reaching material already issued (and, negative, coming back). */
export const LANDED_COST_KIND = 'landed_cost_adjustment';
/** The settlement document type, as `project-close.ts` names it; the supplement posts under the settlement's event. */
const SETTLEMENT_DOCUMENT_TYPE = 'project_settlement';

interface IssueRow {
  lineId: string | null;
  documentNo: string | null;
  projectCode: string;
  wbsCode: string | null;
  costCode: string | null;
  journalEntryId: string | null;
}

/** The Material Issue document line that moved this stock, or (Phase 11) the bare issue to the project. */
async function issueOf(tx: Tx, movement: DepartedMovement): Promise<IssueRow | null> {
  const [line] = rows<IssueRow>(
    await tx.execute(sql`
      select l.id as "lineId", d.document_no as "documentNo", d.project_code as "projectCode", d.wbs_code as "wbsCode",
             d.cost_code as "costCode", d.journal_entry_id as "journalEntryId"
        from project_material_issue_line l
        join project_material_issue d on d.id = l.issue_id
       where l.movement_id = ${movement.id}
       limit 1`),
  );
  if (line) return line;
  if (movement.sourceDocumentType !== 'project' || !movement.sourceDocumentId) return null;
  // An issue made before the document existed: the cost row Phase 11 wrote with it.
  const [cost] = rows<{ wbsCode: string | null; costCode: string }>(
    await tx.execute(sql`
      select k.wbs_code as "wbsCode", k.cost_code as "costCode"
        from project_cost k
       where k.project_code = ${movement.sourceDocumentId}
         and k.kind = 'material_issue'
         and k.incurred_on = ${movement.movementDate}::date
         and k.description = ${`${movement.itemCode} issued from ${movement.warehouseCode}`}
       order by k.created_at desc
       limit 1`),
  );
  return {
    lineId: null,
    documentNo: null,
    projectCode: movement.sourceDocumentId,
    wbsCode: cost?.wbsCode ?? null,
    costCode: cost?.costCode ?? null,
    journalEntryId: null,
  };
}

interface ProjectRow {
  kind: string;
  status: string;
  branchCode: string | null;
  departmentCode: string | null;
  businessLineCode: string | null;
}

interface SettlementRow {
  id: string;
  settlementNo: string;
  branchCode: string;
}

async function projectOf(tx: Tx, code: string): Promise<ProjectRow | null> {
  const [project] = rows<ProjectRow>(
    await tx.execute(sql`
      select t.kind::text as kind, p.status::text as status, p.branch_code as "branchCode",
             p.department_code as "departmentCode", p.business_line_code as "businessLineCode"
        from project p join project_type t on t.code = p.type_code where p.code = ${code}`),
  );
  return project ?? null;
}

async function settlementOf(tx: Tx, projectCode: string): Promise<SettlementRow | null> {
  const [settled] = rows<SettlementRow>(
    await tx.execute(sql`
      select id, settlement_no as "settlementNo", branch_code as "branchCode" from project_settlement
       where project_code = ${projectCode} and status = 'posted' limit 1`),
  );
  return settled ?? null;
}

/** The issue journal's cost line, else what that journal would have used (D-PM-13). */
async function receiverOf(
  tx: Tx,
  movement: DepartedMovement,
  issue: IssueRow & { costCode: string },
  project: ProjectRow,
  named: string,
): Promise<{ accountId: string; dimensions: Record<string, string | null> }> {
  const own = issue.journalEntryId ? await journalLineOf(tx, issue.journalEntryId, 'project_material_cost') : null;
  if (own) return { accountId: own.accountId, dimensions: { ...own.dimensions } };
  const [code] = rows<{ accountId: string | null }>(
    await tx.execute(sql`select account_id as "accountId" from project_cost_code where code = ${issue.costCode}`),
  );
  const accountId =
    code?.accountId ??
    (await mappedAccount(tx, 'projects.material_issue', 'project_material_cost', {
      branchCode: movement.branchCode,
      projectCode: issue.projectCode,
      warehouseCode: movement.warehouseCode,
    }));
  if (!accountId) {
    throw new DepartureError(
      `No account is mapped for 'project_material_cost' (Project material issue), and cost code ${issue.costCode} names ` +
        `none: the landed cost of ${named} has nowhere to go. Map it in Posting Mappings, then lock.`,
    );
  }
  return {
    accountId,
    dimensions: {
      branch: movement.branchCode,
      project: issue.projectCode,
      warehouse: movement.warehouseCode,
      ...(project.departmentCode ? { department: project.departmentCode } : {}),
      ...(project.businessLineCode ? { business_line: project.businessLineCode } : {}),
    },
  };
}

async function destination(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  const issue = await issueOf(tx, movement);
  const named = `${movement.itemCode} issued from ${movement.warehouseCode} on ${movement.movementDate}`;
  if (!issue) {
    throw new DepartureError(`${named} names no project, so the landed cost of it has no project to go to.`);
  }
  const project = await projectOf(tx, issue.projectCode);
  if (!project) throw new DepartureError(`${named} names project ${issue.projectCode}, which does not exist.`);
  const settlement = await settlementOf(tx, issue.projectCode);
  if (!settlement && project.status !== 'active') {
    throw new DepartureError(
      `${named} went to project ${issue.projectCode}, which is ${project.status.replace(/_/g, ' ')}; its cost can only ` +
        'grow while it is active. Re-activate it to take the landed cost of its material, then lock.',
    );
  }
  if (!issue.costCode) {
    throw new DepartureError(
      `${named} went to project ${issue.projectCode} without a Material Issue document, so its cost code cannot be told ` +
        'and the landed cost of it has no line of the project to go to.',
    );
  }
  const costCode = issue.costCode;
  const receiver = await receiverOf(tx, movement, { ...issue, costCode }, project, named);

  return {
    role: 'project_material_cost',
    accountId: receiver.accountId,
    dimensions: receiver.dimensions,
    postSettlement: settlement !== null,
    afterPosting: async (inner, ctx, posted) => {
      const amount = toDecimalString(posted.amountIqd, 4n);
      if (!settlement) {
        await inner.execute(sql`
          insert into project_cost
            (project_code, cost_code, wbs_code, kind, description, incurred_on, amount_iqd,
             journal_entry_id, source_type, source_id, created_by)
          values
            (${issue.projectCode}, ${costCode}, ${issue.wbsCode}, ${LANDED_COST_KIND},
             ${`Landed cost of ${formatQuantity(posted.quantity)} ${movement.itemCode} issued ${movement.movementDate}` +
               `${issue.documentNo ? ` (${issue.documentNo})` : ''} — ${posted.reference}`},
             ${posted.postedOn}::date, ${amount}::numeric, ${posted.journalEntryId}, 'landed_cost_lock', ${posted.lockId},
             ${ctx.principal.userId})`);
        await audit.record(inner, {
          actorUserId: ctx.principal.userId,
          action: 'project.cost_recorded',
          objectType: 'project',
          objectId: issue.projectCode,
          branchCode: movement.branchCode,
          after: { costCode, wbsCode: issue.wbsCode, kind: LANDED_COST_KIND, amountIqd: amount, lock: posted.reference, movementId: movement.id },
          outcome: 'success',
          requestId: ctx.requestId ?? null,
        });
        return;
      }

      // Settled: the project's cost rows are closed (the database refuses a
      // row on a project that is not active, and the project is not reopened),
      // so the supplement itself carries the amount, against the settlement,
      // the issue line and the departure.

      // The settlement's supplement: an asset settlement carries the cost on
      // to the asset under construction the way the settlement did (its
      // event, its roles); a result settlement leaves it where it is posted.
      let journalEntryId: string | null = null;
      if (settlementKindOf(project.kind) === 'asset') {
        const criteria = { branchCode: settlement.branchCode, projectCode: issue.projectCode };
        const result = await posting.post(inner, ctx, {
          eventType: 'projects.settlement',
          documentTypeCode: SETTLEMENT_DOCUMENT_TYPE,
          source: { module: 'projects', documentId: posted.departureId, event: 'supplement' },
          branchCode: settlement.branchCode,
          documentDate: posted.postedOn,
          postingDate: posted.postedOn,
          description: `Settlement ${settlement.settlementNo} supplement — landed cost ${posted.reference} on ${issue.projectCode}`,
          lines: [
            {
              role: 'project_auc',
              debit: amount,
              criteria,
              dimensions: {
                branch: settlement.branchCode,
                project: issue.projectCode,
                department: project.departmentCode ?? null,
                business_line: project.businessLineCode ?? null,
              },
            },
            {
              role: 'project_cost',
              accountId: receiver.accountId,
              credit: amount,
              criteria,
              dimensions: {
                branch: settlement.branchCode,
                project: issue.projectCode,
                department: receiver.dimensions.department ?? null,
                business_line: receiver.dimensions.business_line ?? null,
              },
            },
          ],
        });
        journalEntryId = result.journalEntryId;
      }
      const [supplement] = rows<{ id: string }>(
        await inner.execute(sql`
          insert into project_settlement_supplement
            (settlement_id, project_code, lock_id, departure_id, material_issue_line_id, amount_iqd,
             journal_entry_id, posted_on, created_by)
          values
            (${settlement.id}::uuid, ${issue.projectCode}, ${posted.lockId}::uuid, ${posted.departureId}::uuid,
             ${issue.lineId}::uuid, ${amount}::numeric, ${journalEntryId}::uuid,
             ${posted.postedOn}::date, ${ctx.principal.userId}::uuid)
          returning id`),
      );
      await audit.record(inner, {
        actorUserId: ctx.principal.userId,
        action: 'project_settlement.supplemented',
        objectType: SETTLEMENT_DOCUMENT_TYPE,
        objectId: settlement.settlementNo,
        branchCode: settlement.branchCode,
        after: {
          supplementId: supplement!.id,
          projectCode: issue.projectCode,
          lock: posted.reference,
          materialIssue: issue.documentNo,
          amountIqd: amount,
          journalEntryId,
        },
        outcome: 'success',
        requestId: ctx.requestId ?? null,
      });
    },
  };
}

/** Material issued before a lock came back after it: the share left the project with it. */
async function returned(tx: Tx, ctx: ActorContext, back: ReturnedDeparture): Promise<void> {
  const issue = await issueOf(tx, back.movement);
  if (!issue?.costCode) return;
  const amount = toDecimalString(-back.amountIqd, 4n);
  const [returnLine] = rows<{ documentNo: string | null }>(
    await tx.execute(sql`
      select d.document_no as "documentNo"
        from project_material_issue_line l join project_material_issue d on d.id = l.issue_id
       where l.movement_id = ${back.returnMovement.id} limit 1`),
  );
  await tx.execute(sql`
    insert into project_cost
      (project_code, cost_code, wbs_code, kind, description, incurred_on, amount_iqd,
       journal_entry_id, source_type, source_id, created_by)
    values
      (${issue.projectCode}, ${issue.costCode}, ${issue.wbsCode}, ${LANDED_COST_KIND},
       ${`Landed cost of ${formatQuantity(back.quantity)} ${back.movement.itemCode} returned to ${back.returnMovement.warehouseCode}` +
         `${returnLine?.documentNo ? ` (${returnLine.documentNo})` : ''}`},
       ${back.postedOn}::date, ${amount}::numeric, ${back.journalEntryId}, 'landed_cost_return', ${back.returnId}, ${ctx.principal.userId})`);
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.cost_recorded',
    objectType: 'project',
    objectId: issue.projectCode,
    branchCode: back.returnMovement.branchCode,
    after: { costCode: issue.costCode, wbsCode: issue.wbsCode, kind: LANDED_COST_KIND, amountIqd: amount, returnOf: back.departureId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

async function label(tx: Tx, movement: DepartedMovement): Promise<string | null> {
  const issue = await issueOf(tx, movement);
  if (!issue) return null;
  return issue.documentNo ? `Material Issue ${issue.documentNo} (project ${issue.projectCode})` : `the issue to project ${issue.projectCode}`;
}

export const PROJECT_DEPARTURES: Readonly<Record<string, DepartureHandler>> = Object.freeze({
  project_issue: { destination, returned, label },
});
