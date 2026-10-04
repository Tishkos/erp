'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import { parseDecimal } from '@/server/domain/money';
import * as attachments from '@/server/services/attachments';
import * as treasury from '@/server/services/treasury';

/**
 * Internal Transfers — REQ-ACC-001 Part D-2. Every verb is `treasury.ts`'s;
 * these read the form and say where to come back to.
 */
const LIST = '/treasury/transfers';
const record = (no: string) => `${LIST}/${encodeURIComponent(no)}`;

/** An amount as typed ("3,500.00") at the money scale; null when blank. */
function amountOf(value: string): bigint | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) throw new Error(`"${value}" is not an amount.`);
  return parseDecimal(cleaned, 4n);
}

export async function createTransferAction(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => {
      const received = amountOf(text(formData, 'received_amount'));
      return treasury.createTransfer(tx, ctx, {
        fromAccountId: text(formData, 'from_account_id'),
        toAccountId: text(formData, 'to_account_id'),
        transferDate: text(formData, 'transfer_date'),
        amountIqd: amountOf(text(formData, 'amount')) ?? 0n,
        ...(received !== null ? { receivedAmount: received } : {}),
        fxRate: text(formData, 'fx_rate').replace(/[,\s]/g, '') || null,
        bankReference: text(formData, 'bank_reference').trim() || null,
        note: text(formData, 'note').trim() || null,
        // The one-time id the form minted: a second submit answers with the
        // transfer the first one made.
        documentId: text(formData, 'document_id') || null,
      });
    },
    (value) => {
      const made = value as { transferNo?: string } | null | undefined;
      return made?.transferNo ? record(made.transferNo) : `${LIST}?transfer=new`;
    },
  );
}

async function idOf(formData: FormData) {
  return { id: text(formData, 'id'), no: text(formData, 'transfer_no') };
}

/** Approved by somebody other than whoever raised it (the Super User alone excepted). */
export async function approveTransferAction(formData: FormData): Promise<void> {
  const { id, no } = await idOf(formData);
  await runAdminAndReturn((tx, ctx) => treasury.approveTransferAsChecker(tx, ctx, id), record(no));
}

export async function postTransferAction(formData: FormData): Promise<void> {
  const { id, no } = await idOf(formData);
  await runAdminAndReturn((tx, ctx) => treasury.postTransfer(tx, ctx, id), record(no));
}

/** A posted transfer is never edited: its journal is mirrored, with the reason. */
export async function reverseTransferAction(formData: FormData): Promise<void> {
  const { id, no } = await idOf(formData);
  await runAdminAndReturn(
    (tx, ctx) => treasury.reverseTransfer(tx, ctx, id, { reason: text(formData, 'reason') }),
    record(no),
  );
}

/**
 * The bank's advice, the signed voucher — paperwork on the transfer itself
 * (object `bank_transfer`). The attachment rules are registered lazily, so a
 * cold process is told about them before it is handed the first file.
 */
export async function attachToTransfer(formData: FormData): Promise<void> {
  const no = text(formData, 'transfer_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${record(no)}?error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const transfer = await treasury.transferByNo(tx, ctx, no);
    return attachments.upload(tx, ctx, {
      objectType: treasury.TRANSFER_OBJECT_TYPE,
      objectId: transfer.id,
      fileName: upload.name,
      content,
    });
  }, record(no));
}
