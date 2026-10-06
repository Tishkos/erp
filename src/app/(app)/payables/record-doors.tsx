import { getTranslations } from 'next-intl/server';
import { Attachments, readAttachments, type AttachmentsRead } from '@/components/admin/attachments';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { ExportIcon } from '@/components/print/export-menu';
import type { Tx } from '@/server/db/client';
import { can, type Principal } from '@/server/domain/permissions';
import type { ReactNode } from 'react';
import type { ExportKey } from '@/server/print/access';
import * as recordNotes from '@/server/services/record-notes';
import { attachToPurchaseRecord } from './attach-action';

/**
 * The four doors of a purchase-side record — REQ-PAY-001 PAY3 (2026-10-04),
 * AGENTS.md › "Every record wears the same four doors": printer, paperclip,
 * notes, clock, in that order, in `DocumentWindow.titleActions`, from the
 * moment the draft exists.
 *
 * Written once so the order, the paperclip's action and the audit object
 * cannot drift between the nine purchase records. `object` and `recordId`
 * are what the record's history is kept under (the audit object and the
 * row's uuid); the notes door reads and writes `<object>.note_added` through
 * the shared `record-notes` service; the paperclip posts to the one
 * `attachToPurchaseRecord` action, which comes back to `returnTo`, this
 * page's own path.
 *
 *   const doors = await readDoors(tx, principal, { object, recordId });
 *   titleActions={<PurchaseDoors exportKey="purchase_order" exportId={order.orderNo} title={…}
 *                                object={…} recordId={…} doors={doors} returnTo={`/payables/purchase-orders/${…}`} />}
 */
export interface DoorsRead {
  readonly notes: readonly recordNotes.RecordNote[];
  readonly files: AttachmentsRead;
  readonly mayAttach: boolean;
}

/** The notes and the files, read in the page's own transaction. */
export async function readDoors(tx: Tx, principal: Principal, ref: { readonly object: string; readonly recordId: string }): Promise<DoorsRead> {
  const [notes, files] = await Promise.all([recordNotes.listNotes(tx, ref), readAttachments(tx, ref.object, ref.recordId)]);
  return { notes, files, mayAttach: can(principal, 'create', 'attachment') && can(principal, 'view', ref.object) };
}

export async function PurchaseDoors({
  exportKey,
  exportId,
  title,
  object,
  recordId,
  doors,
  returnTo,
  attach,
}: {
  readonly exportKey: ExportKey;
  /** The number the export route is addressed by. */
  readonly exportId: string;
  /** The print window's heading: the document and its number. */
  readonly title: string;
  /** The audit object the record's history is kept under. */
  readonly object: string;
  /** The row's uuid — the id its history, notes and files hang on. */
  readonly recordId: string;
  readonly doors: DoorsRead;
  /** This page's path (and query), where the paperclip's form returns. */
  readonly returnTo: string;
  /**
   * A record whose papers move it (the payment application, 2026-10-06) asks
   * what each paper is: its own action, fields and hidden values.
   */
  readonly attach?: {
    readonly action: (formData: FormData) => Promise<void>;
    readonly hidden: Readonly<Record<string, string>>;
    readonly formExtra: ReactNode;
  };
}) {
  const t = await getTranslations('admin');
  return (
    <>
      {/* Printer, paperclip, notes, clock — the printer first, as asked (2026-10-03). */}
      <ExportIcon exportKey={exportKey} id={exportId} title={title} />
      <AttachmentsButton closeLabel={t('close')} count={doors.files.rows.length} label={t('attachments.title')} title={t('attachments.title')}>
        <Attachments
          action={attach?.action ?? attachToPurchaseRecord}
          formExtra={attach?.formExtra}
          hidden={attach?.hidden ?? { object_type: object, object_id: recordId, return_to: returnTo }}
          mayAttach={doors.mayAttach}
          objectId={recordId}
          objectType={object}
          preloaded={doors.files}
        />
      </AttachmentsButton>
      <RecordNotesDoor notes={doors.notes} object={object} recordId={recordId} />
      <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
        <RecordHistory objectId={recordId} objectType={object} />
      </HistoryButton>
    </>
  );
}
