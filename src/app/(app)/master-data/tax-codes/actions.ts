'use server';

import { redirect } from 'next/navigation';
import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as taxCodes from '@/server/services/tax-codes';

/** Tax Codes — REQ-ACC-001 Part D-5. Every verb is `tax-codes.ts`'s. */
const LIST = '/master-data/tax-codes';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

const common = (formData: FormData) => ({
  name: text(formData, 'name'),
  direction: text(formData, 'direction') as taxCodes.TaxDirection,
  isRecoverable: text(formData, 'recoverable') === 'yes',
  accountId: text(formData, 'account_id'),
});

export async function createTaxCode(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      taxCodes.create(tx, ctx, {
        ...common(formData),
        ratePercent: text(formData, 'rate'),
        effectiveFrom: text(formData, 'effective_from'),
      }),
    (value) => {
      const made = value as { code?: string } | null | undefined;
      return made?.code ? record(made.code) : `${LIST}?tax=new`;
    },
  );
}

export async function updateTaxCode(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn((tx, ctx) => taxCodes.update(tx, ctx, code, common(formData)), record(code));
}

export async function addTaxRate(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => taxCodes.addRate(tx, ctx, code, { ratePercent: text(formData, 'rate'), effectiveFrom: text(formData, 'effective_from') }),
    record(code),
  );
}

export async function setTaxCodeActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => taxCodes.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}

/** The tax authority's letter, the rate notice — paperwork on the code itself. */
export async function attachToTaxCode(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(code)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    await taxCodes.get(tx, code);
    return attachments.upload(tx, ctx, { objectType: taxCodes.PERMISSION_OBJECT, objectId: code, fileName: upload.name, content });
  }, record(code));
}
