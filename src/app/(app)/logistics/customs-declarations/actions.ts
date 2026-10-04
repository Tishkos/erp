'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { parseDecimal } from '@/server/domain/money';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as declarations from '@/server/services/customs-declarations';
import * as payables from '@/server/services/payables';

/** Customs declarations — REQ-LOG-001 item 8. Every verb is the service's. */
const LIST = '/logistics/customs-declarations';
const record = (declarationNo: string) => `${LIST}/${encodeURIComponent(declarationNo)}`;

/** Amount as typed ("3,500.00") at the money scale; null when blank. */
function amountOf(value: string): bigint | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) throw new declarations.DeclarationRuleError(`"${value}" is not an amount.`);
  return parseDecimal(cleaned, 4n);
}

function figuresOf(formData: FormData) {
  return {
    currency: text(formData, 'currency') || null,
    declaredValue: amountOf(text(formData, 'declared_value')),
    declaredDuty: amountOf(text(formData, 'declared_duty')),
    declaredTaxes: amountOf(text(formData, 'declared_taxes')),
    declaredFees: amountOf(text(formData, 'declared_fees')),
    hsCode: text(formData, 'hs_code') || null,
  };
}

async function idOf(tx: Parameters<Parameters<typeof runAdminAndReturn>[0]>[0], formData: FormData) {
  return (await declarations.viewByNo(tx, text(formData, 'declaration_no'))).declaration.id;
}

export async function createDeclaration(formData: FormData): Promise<void> {
  const back = text(formData, 'back') || LIST;
  await runAdminAndReturn(
    async (tx, ctx) => {
      const payableNo = text(formData, 'payable_no');
      const payableId = payableNo ? (await payables.loadByNo(tx, payableNo)).id : text(formData, 'payable_id');
      return declarations.create(tx, ctx, {
        payableId,
        pdId: text(formData, 'pd_id') || null,
        declarationDate: text(formData, 'declaration_date') || null,
        customsRef: text(formData, 'customs_ref') || null,
        note: text(formData, 'note') || null,
        ...figuresOf(formData),
      });
    },
    (value) => {
      const created = value as { declarationNo?: string } | null | undefined;
      return created?.declarationNo ? record(created.declarationNo) : back;
    },
  );
}

export async function updateDeclaration(formData: FormData): Promise<void> {
  const declarationNo = text(formData, 'declaration_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      declarations.update(tx, ctx, await idOf(tx, formData), {
        pdId: text(formData, 'pd_id') || null,
        declarationDate: text(formData, 'declaration_date') || null,
        customsRef: text(formData, 'customs_ref') || null,
        note: text(formData, 'note') || null,
        ...figuresOf(formData),
      }),
    record(declarationNo),
  );
}

/** One step forward or out: the status is in the form, with its date, reference and reason. */
export async function moveDeclaration(formData: FormData): Promise<void> {
  const declarationNo = text(formData, 'declaration_no');
  await runAdminAndReturn(
    async (tx, ctx) =>
      declarations.move(tx, ctx, await idOf(tx, formData), {
        to: text(formData, 'to'),
        on: text(formData, 'on') || null,
        customsRef: text(formData, 'customs_ref') || null,
        reason: text(formData, 'reason') || null,
        note: text(formData, 'note') || null,
      }),
    record(declarationNo),
  );
}

/** The lodgement, the assessment notice — kept with the declaration. */
export async function attachToDeclaration(formData: FormData): Promise<void> {
  const declarationNo = text(formData, 'declaration_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${record(declarationNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const found = await declarations.viewByNo(tx, declarationNo);
    await attachments.upload(tx, ctx, {
      objectType: declarations.PERMISSION_OBJECT,
      objectId: found.declaration.id,
      fileName: upload.name,
      content,
    });
  }, record(declarationNo));
}
