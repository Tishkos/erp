'use server';

import { flag, runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { redirect } from 'next/navigation';
import { normaliseBaseUrl } from '@/server/domain/cloud-files';
import { permit } from '@/server/services/administration';
import { serverStatus } from '@/server/services/cloud-client';
import * as settings from '@/server/services/cloud-settings';

const LIST = '/administration/cloud-files';

export async function saveSettingsAction(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.save(tx, ctx, {
        enabled: flag(form, 'enabled'),
        baseUrl: text(form, 'address'),
        rootPath: text(form, 'root_path') || '/',
        recordRoot: text(form, 'record_root') || '/Qimah',
      }),
    LIST,
  );
}

/**
 * "Test the address": asks `status.php` of whatever is typed (saved or not)
 * and reports what the installation says about itself. Nothing is saved, and
 * no one's account is touched.
 */
export async function testConnectionAction(form: FormData): Promise<void> {
  // The same permission as the screen's changes: it makes the server call out to an address a person typed.
  const allowed = await runAdmin(async (_tx, ctx) => {
    await permit(ctx, 'configure', settings.PERMISSION_OBJECT, null);
  });
  if (!allowed.ok) redirect(withQuery(LIST, 'error', allowed.error!));

  let answer: Array<[string, string]>;
  try {
    const status = await serverStatus(normaliseBaseUrl(text(form, 'address')));
    answer = status.maintenance
      ? [['test', 'maintenance']]
      : !status.installed
        ? [['test', 'not_installed']]
        : [['test', 'ok'], ['version', status.version ?? '']];
  } catch (error) {
    answer = [['test', 'failed'], ['reason', error instanceof Error ? error.message : 'failed']];
  }
  redirect(answer.reduce((path, [key, value]) => withQuery(path, key, value), LIST));
}

export async function saveMappingAction(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      settings.saveMapping(tx, ctx, {
        roleCode: text(form, 'role_code'),
        groupName: text(form, 'group_name'),
        canWrite: flag(form, 'can_write'),
        canShare: flag(form, 'can_share'),
      }),
    LIST,
  );
}

export async function deactivateMappingAction(form: FormData): Promise<void> {
  const roleCode = text(form, 'role_code');
  const reason = text(form, 'reason');
  await runAdminAndReturn((tx, ctx) => settings.deactivateMapping(tx, ctx, roleCode, reason), LIST);
}
