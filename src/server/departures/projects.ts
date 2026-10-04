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
 * line. A settled project is refused for now — its cost already went where
 * the settlement put it, and the supplement that follows it there arrives in
 * the next release.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { toDecimalString } from '../domain/money';
import { formatQuantity } from '../domain/uom';
import * as audit from '../services/audit';
import {
  DepartureError,
  journalLineOf,
  mappedAccount,
  type DepartedMovement,
  type DepartureDestination,
  type DepartureHandler,
} from '../services/inventory-departures';

const rows = <T>(result: { rows: unknown[] }) => result.rows as T[];

/** The project_cost kind of a landed cost reaching material already issued. */
export const LANDED_COST_KIND = 'landed_cost_adjustment';

interface IssueRow {
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
      select d.document_no as "documentNo", d.project_code as "projectCode", d.wbs_code as "wbsCode",
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
    documentNo: null,
    projectCode: movement.sourceDocumentId,
    wbsCode: cost?.wbsCode ?? null,
    costCode: cost?.costCode ?? null,
    journalEntryId: null,
  };
}

async function destination(tx: Tx, movement: DepartedMovement): Promise<DepartureDestination> {
  const issue = await issueOf(tx, movement);
  const named = `${movement.itemCode} issued from ${movement.warehouseCode} on ${movement.movementDate}`;
  if (!issue) {
    throw new DepartureError(`${named} names no project, so the landed cost of it has no project to go to.`);
  }
  const [settled] = rows<{ settlementNo: string }>(
    await tx.execute(sql`
      select settlement_no as "settlementNo" from project_settlement
       where project_code = ${issue.projectCode} and status = 'posted' limit 1`),
  );
  if (settled) {
    throw new DepartureError(
      `${named} went to project ${issue.projectCode}, which is settled (${settled.settlementNo}). The landed cost of ` +
        'material on a settled project follows the settlement — a post-settlement adjustment arrives in the next release, ' +
        'so the lock is refused for now.',
    );
  }
  const [project] = rows<{ status: string; departmentCode: string | null; businessLineCode: string | null }>(
    await tx.execute(sql`
      select status::text as status, department_code as "departmentCode", business_line_code as "businessLineCode"
        from project where code = ${issue.projectCode}`),
  );
  if (!project) throw new DepartureError(`${named} names project ${issue.projectCode}, which does not exist.`);
  if (project.status !== 'active') {
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

  // The issue's own journal line, else what that journal would have used.
  let found = issue.journalEntryId ? await journalLineOf(tx, issue.journalEntryId, 'project_material_cost') : null;
  if (!found) {
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
    found = {
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

  const costCode = issue.costCode;
  return {
    role: 'project_material_cost',
    accountId: found.accountId,
    dimensions: found.dimensions,
    afterPosting: async (inner, ctx, posted) => {
      const amount = toDecimalString(posted.amountIqd, 4n);
      await inner.execute(sql`
        insert into project_cost
          (project_code, cost_code, wbs_code, kind, description, incurred_on, amount_iqd,
           journal_entry_id, source_type, source_id, created_by)
        values
          (${issue.projectCode}, ${costCode}, ${issue.wbsCode}, ${LANDED_COST_KIND},
           ${`Landed cost of ${formatQuantity(posted.quantity)} ${movement.itemCode} issued ${movement.movementDate}` +
             `${issue.documentNo ? ` (${issue.documentNo})` : ''} — ${posted.reference}`},
           ${posted.postedOn}::date, ${amount}::numeric, ${posted.journalEntryId}, 'landed_cost_lock', ${posted.lockId}, ${ctx.principal.userId})`);
      await audit.record(inner, {
        actorUserId: ctx.principal.userId,
        action: 'project.cost_recorded',
        objectType: 'project',
        objectId: issue.projectCode,
        branchCode: movement.branchCode,
        after: {
          costCode,
          wbsCode: issue.wbsCode,
          kind: LANDED_COST_KIND,
          amountIqd: amount,
          lock: posted.reference,
          movementId: movement.id,
        },
        outcome: 'success',
        requestId: ctx.requestId ?? null,
      });
    },
  };
}

async function label(tx: Tx, movement: DepartedMovement): Promise<string | null> {
  const issue = await issueOf(tx, movement);
  if (!issue) return null;
  return issue.documentNo ? `Material Issue ${issue.documentNo} (project ${issue.projectCode})` : `the issue to project ${issue.projectCode}`;
}

export const PROJECT_DEPARTURES: Readonly<Record<string, DepartureHandler>> = Object.freeze({
  project_issue: { destination, label },
});
