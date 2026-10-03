'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as migration from '@/server/services/payables-migration';

/**
 * The sheet import — REQ-AP-001 §24.3. The service holds every rule: dry run
 * first, apply only a dry-run file, sign-off by a second accountant.
 */
const PAGE = '/administration/payables-migration';

export async function runMigration(formData: FormData): Promise<void> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${PAGE}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  const mode = text(formData, 'mode') === 'apply' ? 'apply' : 'dry_run';
  await runAdminAndReturn(
    async (tx, ctx) =>
      mode === 'apply'
        ? migration.apply(tx, ctx, { fileName: upload.name, content })
        : migration.dryRun(tx, ctx, { fileName: upload.name, content }),
    PAGE,
  );
}

export async function signOffMigration(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => migration.signOff(tx, ctx, text(formData, 'run_id'), text(formData, 'note') || null),
    PAGE,
  );
}
