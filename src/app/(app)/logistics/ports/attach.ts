'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as ports from '@/server/services/ports';

const record = (code: string) => `/logistics/ports/${encodeURIComponent(code)}`;

/** The port's papers — the tariff sheet, the agent's letter — kept with the port, by its code. */
export async function attachToPort(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${record(code)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const found = await ports.viewByCode(tx, code);
    await attachments.upload(tx, ctx, { objectType: ports.PERMISSION_OBJECT, objectId: found.port.code, fileName: upload.name, content });
  }, record(code));
}
