'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as asycuda from '@/server/services/asycuda-runs';
import * as attachments from '@/server/services/attachments';
import * as customs from '@/server/services/customs-pd';
import * as events from '@/server/services/payable-events';
import * as payables from '@/server/services/payables';

/** PD / ASYCUDA — REQ-AP-001 §16, §21.8. Every verb is the service's. */
const LIST = '/payables/pd';
const ASYCUDA = '/payables/pd/asycuda';
const asycudaRecord = (runNo: string) => `${ASYCUDA}/${encodeURIComponent(runNo)}`;
const record = (pdNo: string, year?: string | number | null) =>
  `${LIST}/${encodeURIComponent(pdNo)}${year ? `?year=${year}` : ''}`;

async function pdIdOf(tx: Parameters<Parameters<typeof runAdminAndReturn>[0]>[0], formData: FormData) {
  const year = Number(text(formData, 'year')) || null;
  return (await customs.viewByNo(tx, text(formData, 'pd_no'), year)).pd.id;
}

export async function registerPd(formData: FormData): Promise<void> {
  const back = text(formData, 'back') || LIST;
  await runAdminAndReturn(
    async (tx, ctx) => {
      const payableNo = text(formData, 'payable_no');
      const payableId = payableNo ? (await payables.loadByNo(tx, payableNo)).id : text(formData, 'payable_id');
      return customs.register(tx, ctx, {
        payableId,
        pdNo: text(formData, 'new_pd_no'),
        registrationDate: text(formData, 'registration_date'),
        expiryDate: text(formData, 'expiry_date'),
        bankCode: text(formData, 'bank_code') || null,
        statusCode: text(formData, 'status_code') || null,
        note: text(formData, 'note') || null,
      });
    },
    (value) => {
      const created = value as { pdNo?: string } | null | undefined;
      return created?.pdNo && back === LIST ? record(created.pdNo) : back;
    },
  );
}

export async function changePdStatus(formData: FormData): Promise<void> {
  const pdNo = text(formData, 'pd_no');
  const year = text(formData, 'year');
  await runAdminAndReturn(
    async (tx, ctx) =>
      customs.changeStatus(tx, ctx, await pdIdOf(tx, formData), {
        statusCode: text(formData, 'status_code'),
        effectiveDate: text(formData, 'effective_date'),
        note: text(formData, 'note') || null,
        source: text(formData, 'source') === 'asycuda_screenshot' ? 'asycuda_screenshot' : 'user',
      }),
    record(pdNo, year),
  );
}

export async function addPdNote(formData: FormData): Promise<void> {
  const pdNo = text(formData, 'pd_no');
  const year = text(formData, 'year');
  await runAdminAndReturn(
    async (tx, ctx) => customs.addNote(tx, ctx, await pdIdOf(tx, formData), text(formData, 'note')),
    record(pdNo, year),
  );
}

export async function reRegisterPd(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) =>
      customs.reRegister(tx, ctx, await pdIdOf(tx, formData), {
        pdNo: text(formData, 'new_pd_no'),
        registrationDate: text(formData, 'registration_date'),
        expiryDate: text(formData, 'expiry_date'),
        bankCode: text(formData, 'bank_code') || null,
        note: text(formData, 'note') || null,
      }),
    (value) => {
      const created = value as { pdNo?: string } | null | undefined;
      return created?.pdNo ? record(created.pdNo) : record(text(formData, 'pd_no'), text(formData, 'year'));
    },
  );
}

/** §24.3 — a PD from the sheet's holding list, named to its import. */
export async function linkPd(formData: FormData): Promise<void> {
  const pdNo = text(formData, 'pd_no');
  const year = text(formData, 'year');
  await runAdminAndReturn(
    async (tx, ctx) => customs.linkToImport(tx, ctx, await pdIdOf(tx, formData), text(formData, 'payable_id')),
    record(pdNo, year),
  );
}

/** The ASYCUDA list, applied — the difference was shown first on its own page. */
export async function applyAsycudaList(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    async (tx, ctx) => customs.asycudaApply(tx, ctx, text(formData, 'list')),
    (value) => {
      const result = value as { changed?: number } | null | undefined;
      return `${LIST}?applied=${result?.changed ?? 0}`;
    },
  );
}

/**
 * Reads the ASYCUDA report, and keeps the reading — §21.8.
 *
 * The file the officer exported, or the list they pasted, becomes one run:
 * the lines as read, the difference at that moment, and their name against
 * it. Nothing in the books moves here, which is the whole point of the step —
 * the run's id goes back in the address so the difference can be looked at,
 * left, and come back to.
 */
export async function readAsycudaList(formData: FormData): Promise<void> {
  const uploads = formData
    .getAll('files')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  const pasted = text(formData, 'list');

  if (uploads.length === 0 && pasted.trim() === '') {
    redirect(`${ASYCUDA}?error=asycuda_nothing_given`);
  }

  const files = await Promise.all(
    uploads.map(async (file) => ({ fileName: file.name, content: Buffer.from(await file.arrayBuffer()) })),
  );

  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(
    async (tx, ctx) => {
      const read = files.length > 0 ? asycuda.readFiles(files) : null;
      return asycuda.startRun(tx, ctx, {
        source: read ? 'file' : 'paste',
        fileNames: files.map((file) => file.fileName),
        text: read ? read.text : pasted,
        files,
      });
    },
    (value) => {
      const started = value as { runNo?: string } | null | undefined;
      return started?.runNo ? asycudaRecord(started.runNo) : `${ASYCUDA}?new=1`;
    },
  );
}

/** Applies a reading that was looked at first. */
export async function applyAsycudaRun(formData: FormData): Promise<void> {
  const id = text(formData, 'run');
  const runNo = text(formData, 'run_no');
  await runAdminAndReturn(
    async (tx, ctx) => asycuda.applyRun(tx, ctx, id),
    runNo ? asycudaRecord(runNo) : ASYCUDA,
  );
}

/** IMPROVEMENT-002 — more paperwork filed on an ASYCUDA reading (the screenshot, the officer's note). */
export async function attachToAsycudaRun(formData: FormData): Promise<void> {
  const runNo = text(formData, 'run_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${asycudaRecord(runNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const found = await asycuda.runByNo(tx, runNo);
    if (!found) throw new Error(`No ASYCUDA reading ${runNo}.`);
    await attachments.upload(tx, ctx, { objectType: asycuda.RUN_OBJECT, objectId: found.run.id, fileName: upload.name, content });
  }, asycudaRecord(runNo));
}

/** The ASYCUDA screenshot, the customs letter — kept with the PD. */
export async function attachToPd(formData: FormData): Promise<void> {
  const pdNo = text(formData, 'pd_no');
  const year = text(formData, 'year');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(pdNo, year)}${year ? '&' : '?'}error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const view = await customs.viewByNo(tx, pdNo, Number(year) || null);
    await attachments.upload(tx, ctx, {
      objectType: customs.PERMISSION_OBJECT,
      objectId: view.pd.id,
      fileName: upload.name,
      content,
    });
    if (view.pd.payableId) {
      await events.record(tx, {
        payableId: view.pd.payableId,
        eventCode: 'ATTACHMENT_ADDED',
        summary: `${upload.name} attached to PD ${view.pd.pdNo}`,
        sourceType: customs.PERMISSION_OBJECT,
        sourceId: view.pd.id,
        sourceNo: view.pd.pdNo,
        actorUserId: ctx.principal.userId,
      });
    }
  }, record(pdNo, year));
}
