'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as legacy from '@/server/services/legacy-import';

/**
 * The legacy books import — REQ-LEGACY-001. The service holds every rule:
 * dry run first, apply only a dry-run set, nothing deleted on a re-run.
 */
const PAGE = '/administration/legacy-import';

export async function runLegacyImport(formData: FormData): Promise<void> {
  const uploads = formData.getAll('files').filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (uploads.length === 0) redirect(`${PAGE}?error=attachment_missing`);
  const files = await Promise.all(uploads.map(async (file) => ({ fileName: file.name, content: Buffer.from(await file.arrayBuffer()) })));
  const mode = text(formData, 'mode') === 'apply' ? 'apply' : 'dry_run';
  const cutOverDate = text(formData, 'cut_over_date');
  await runAdminAndReturn(
    async (tx, ctx) =>
      mode === 'apply' ? legacy.apply(tx, ctx, { files, cutOverDate }) : legacy.dryRun(tx, ctx, { files, cutOverDate }),
    PAGE,
  );
}
