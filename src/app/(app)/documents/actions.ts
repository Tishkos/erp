'use server';

import { redirect } from 'next/navigation';
import { flag, runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import { returnPath, refererPath } from '@/server/return-path';
import * as accounts from '@/server/services/cloud-accounts';
import * as files from '@/server/services/cloud-files';
import { CloudLinkError } from '@/server/domain/cloud-files';
import { findRecord, openRecord } from '@/server/services/cloud-link-targets';

/**
 * The Document Center's forms. Every one runs the service as the person
 * (their scope, their grants, their own cloud app password) and goes back to
 * the page it came from with `?saved=1` or the refusal's sentence in
 * `?error=`.
 */

const HOME = '/documents';

/** The page the form was on (its hidden `return_to`), else the referer, else the Document Center. */
async function back(form: FormData): Promise<string> {
  return returnPath(text(form, 'return_to') || null) ?? returnPath(await refererPath()) ?? HOME;
}

// ---- the person's own account ---------------------------------------------

export async function startLinkAction(form: FormData): Promise<void> {
  const to = await back(form);
  await runAdminAndReturn((tx, ctx) => accounts.beginLink(tx, ctx), to);
}

/** "Check now": has the person approved yet? A waiting answer is not an error. */
export async function checkLinkAction(form: FormData): Promise<void> {
  const to = await back(form);
  const outcome = await runAdmin((tx, ctx) => accounts.completeLink(tx, ctx));
  if (!outcome.ok) {
    // The attempt is over (the new app password was revoked again); start clean.
    await runAdmin((tx, ctx) => accounts.cancelLink(tx, ctx.principal.userId));
    redirect(withQuery(to, 'error', outcome.error!));
  }
  if (outcome.value === 'linked') redirect(withQuery(to, 'saved', '1'));
  redirect(withQuery(to, 'link', outcome.value!));
}

export async function cancelLinkAction(form: FormData): Promise<void> {
  const to = await back(form);
  await runAdminAndReturn((tx, ctx) => accounts.cancelLink(tx, ctx.principal.userId), to);
}

export async function unlinkAccountAction(form: FormData): Promise<void> {
  const to = await back(form);
  const outcome = await runAdmin((tx, ctx) => accounts.unlink(tx, ctx));
  if (!outcome.ok) redirect(withQuery(to, 'error', outcome.error!));
  // The stored password is gone either way; say so if the cloud could not be told.
  if (outcome.value === 'failed' || outcome.value === 'no_key') redirect(withQuery(to, 'link', 'revoke_failed'));
  redirect(withQuery(to, 'saved', '1'));
}

// ---- folders ----------------------------------------------------------------

export async function newFolderAction(form: FormData): Promise<void> {
  registerAllRecords();
  const to = await back(form);
  const parent = text(form, 'parent');
  const name = text(form, 'name');
  const share = flag(form, 'share');
  await runAdminAndReturn(async (tx, ctx) => {
    const { client, settings, account } = await accounts.connect(tx, ctx.principal.userId);
    const made = await accounts.withCloud(ctx, account, () => files.createFolder(tx, ctx, client, settings, { parent, name, shareWithMapped: share }));
    return made.entry.path;
  }, to);
}

// ---- links between files and records ---------------------------------------

/**
 * Document -> record. The record is named by its kind and either its id (from
 * a record's own "link a file" step) or the number a person typed.
 */
export async function linkFileAction(form: FormData): Promise<void> {
  registerAllRecords();
  const to = await back(form);
  const path = text(form, 'path');
  const objectType = text(form, 'object_type');
  const objectId = text(form, 'object_id');
  const number = text(form, 'object_number').trim();
  await runAdminAndReturn(async (tx, ctx) => {
    const { client, settings, account } = await accounts.connect(tx, ctx.principal.userId);
    // A number typed by hand is looked up as the person; one that is not there, or not theirs to open, is refused by `linkPath` in the same words.
    const id = number ? ((await findRecord(tx, ctx.principal, objectType, number))?.id ?? '') : objectId;
    return accounts.withCloud(ctx, account, () => files.linkPath(tx, ctx, client, settings, { path, objectType, objectId: id }));
  }, to);
}

export async function unlinkFileAction(form: FormData): Promise<void> {
  registerAllRecords();
  const to = await back(form);
  const linkId = text(form, 'link_id');
  const reason = text(form, 'reason');
  await runAdminAndReturn((tx, ctx) => files.unlinkFile(tx, ctx, linkId, reason), to);
}

/** "Create the record's folder": made under the record root, shared with the roles' groups, linked. */
export async function recordFolderAction(form: FormData): Promise<void> {
  registerAllRecords();
  const to = await back(form);
  const objectType = text(form, 'object_type');
  const objectId = text(form, 'object_id');
  await runAdminAndReturn(async (tx, ctx) => {
    const { client, settings, account } = await accounts.connect(tx, ctx.principal.userId);
    const record = await openRecord(tx, ctx.principal, objectType, objectId);
    if (!record) throw new CloudLinkError('You cannot add files to that record.');
    return accounts.withCloud(ctx, account, () => files.ensureRecordFolder(tx, ctx, client, settings, record));
  }, to);
}
