/**
 * Record registrations — Phase 01.12.
 *
 * Each document type says where its header comes from and what its related
 * documents are. Everything else on a record page — approvals, journals, the
 * audit timeline, which actions are enabled — is assembled by
 * `services/record.ts` and is the same for every type, which is §24's rule:
 * *"Duplicating these mechanisms inside each module will create inconsistent
 * controls and expensive maintenance."*
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { chartOfAccount } from '../db/schema';
import type { RecordHeader, RelatedDocument } from '../domain/record-view';
import type { DocumentStatus } from '../domain/statuses';
import { registerRecord } from '../services/record';
import { registerActionEffect } from '../services/document-actions';
import { registerAttachmentRuntime } from '../attachments-runtime';
import * as accounts from '../services/chart-of-accounts';

/**
 * Chart of Accounts — Phase 02's master, given a record page here.
 *
 * An account is a good first record for the framework because it exercises all
 * of it: it has a maker-checker route (§14.4), a status, a parent it derives
 * from, and no journals of its own — which proves the "this document has not
 * posted" case renders honestly rather than silently.
 */
async function loadAccountHeader(tx: Tx, documentId: string): Promise<RecordHeader | null> {
  // Addressed by code, not by id: the code is what an accountant knows, and it
  // is what the list links to.
  const [row] = await tx
    .select()
    .from(chartOfAccount)
    .where(eq(chartOfAccount.code, documentId))
    .limit(1);

  if (!row) return null;

  const parent = row.parentId
    ? (
        await tx
          .select({ code: chartOfAccount.code, name: chartOfAccount.name })
          .from(chartOfAccount)
          .where(eq(chartOfAccount.id, row.parentId))
          .limit(1)
      )[0]
    : undefined;

  return {
    documentType: 'chart_of_account',
    documentId: row.code,
    auditObjectId: row.id,
    documentNumber: row.code,
    status: row.approvalStatus as DocumentStatus,
    ownerUserId: row.createdBy,
    // The chart is company-wide, so an account belongs to no single branch
    // (§1.2). Stated as null rather than defaulted to the reader's branch,
    // which would suggest a restriction that does not exist.
    branchCode: null,
    departmentCode: null,
    documentDate: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    source: parent
      ? {
          documentType: 'chart_of_account',
          documentId: parent.code,
          documentNumber: parent.code,
          status: null,
          relation: 'parent',
        }
      : null,
  };
}

/** The accounts hanging directly beneath this one. */
async function loadAccountChildren(
  tx: Tx,
  documentId: string,
): Promise<readonly RelatedDocument[]> {
  const rows = await tx
    .select({
      code: chartOfAccount.code,
      status: chartOfAccount.approvalStatus,
    })
    .from(chartOfAccount)
    .where(
      sql`${chartOfAccount.parentId} = (select id from chart_of_account where code = ${documentId})`,
    )
    .orderBy(chartOfAccount.code);

  return rows.map((row) => ({
    documentType: 'chart_of_account',
    documentId: row.code,
    documentNumber: row.code,
    status: row.status as DocumentStatus,
    relation: 'child',
  }));
}

let registered = false;

export function registerAllRecords(): void {
  if (registered) return;
  registered = true;

  // §21 — where files go, what scans them, and who may read them back.
  registerAttachmentRuntime();

  registerRecord({
    documentType: 'chart_of_account',
    object: 'chart_of_account',
    loadHeader: loadAccountHeader,
    loadRelated: loadAccountChildren,
    // An account is edited on its own page — the name and description panel
    // beneath the record — so the framework's generic Edit, which has no
    // screen to open, is not offered.
    actionOverrides: async () => ({ edit: { available: false, reasonKey: 'action.disabled.not_editable' } }),
    // No `loadJournals`: an account is a master record, not a document that
    // posts. The record page says so in words rather than hiding the section.
  });

  // The effects reuse the Phase 02 service — the maker-checker rules live
  // there and are not restated here.
  registerActionEffect('chart_of_account', 'submit', async (tx, documentId, ctx) => {
    const [row] = await tx
      .select({ id: chartOfAccount.id })
      .from(chartOfAccount)
      .where(eq(chartOfAccount.code, documentId))
      .limit(1);
    await accounts.submitForApproval(tx, { principal: ctx.principal, branchCode: ctx.branchCode }, row!.id);
  });

  registerActionEffect('chart_of_account', 'approve', async (tx, documentId, ctx) => {
    const [row] = await tx
      .select({ id: chartOfAccount.id })
      .from(chartOfAccount)
      .where(eq(chartOfAccount.code, documentId))
      .limit(1);
    await accounts.approve(tx, { principal: ctx.principal, branchCode: ctx.branchCode }, row!.id);
  });

  registerActionEffect('chart_of_account', 'reject', async (tx, documentId, ctx) => {
    const [row] = await tx
      .select({ id: chartOfAccount.id })
      .from(chartOfAccount)
      .where(eq(chartOfAccount.code, documentId))
      .limit(1);
    await accounts.reject(tx, { principal: ctx.principal, branchCode: ctx.branchCode }, row!.id, ctx.reason ?? '');
  });
}
