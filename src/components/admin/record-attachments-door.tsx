import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { attachToRecordAction } from '@/server/record-attach-action';
import { requireContext, withCurrentUser } from '@/server/session';
import { can } from '@domain/permissions';
import { Attachments, readAttachments, type AttachmentsRead } from './attachments';
import { loadCloudSection } from './record-cloud-files';
import { AttachmentsButton } from './icon-dialog';
import { ReturnToField } from './return-to-field';

/**
 * The paperclip — the second of the four doors in a record's title bar
 * (printer, paperclip, notes, clock), the same on every record (2026-10-04).
 *
 * It is the purchase invoice's paperclip made once: the clip with how many
 * files there are, and behind it the list of what is filed, by whom and when,
 * with the picker to add one. Files are kept by `services/attachments` against
 * the record (`object`, `recordId`: the audit object type and the id the
 * record's files are kept under — its uuid, or its number where the record is
 * addressed by number), and read back only past the record's own
 * parent-access check in `attachments-runtime.ts`.
 *
 * A module wires it with one line in `DocumentWindow.titleActions`:
 *
 *   <RecordAttachmentsDoor files={files} mayAttach={…} object="employee_advance" recordId={row.id} />
 *
 * where `files` is `readAttachments(tx, object, recordId)` read in the page's
 * own transaction (leave it out and the door reads them itself) and
 * `mayAttach` is the record's own rule — a draft, a live request — which the
 * door narrows to whoever may `create` an `attachment`. The upload posts to
 * the one shared `attachToRecordAction` and returns to the page it was opened
 * on, query included.
 */
export async function RecordAttachmentsDoor({
  object,
  recordId,
  files,
  mayAttach = true,
}: {
  readonly object: string;
  readonly recordId: string;
  readonly files?: AttachmentsRead;
  readonly mayAttach?: boolean;
}) {
  const [t, context] = await Promise.all([getTranslations('admin'), requireContext()]);
  const read = files ?? (await withCurrentUser((tx) => readAttachments(tx, object, recordId)));
  // QS Cloud Files linked to the record count on the same paperclip (nothing, while the integration is off).
  const cloud = await loadCloudSection(context, object, recordId);
  return (
    <AttachmentsButton closeLabel={t('close')} count={read.rows.length + (cloud?.links.length ?? 0)} label={t('attachments.title')} title={t('attachments.title')}>
      <Attachments
        cloud={cloud}
        action={attachToRecordAction}
        formExtra={
          <Suspense fallback={null}>
            <ReturnToField />
          </Suspense>
        }
        hidden={{ object, record_id: recordId }}
        mayAttach={mayAttach && can(context.principal, 'create', 'attachment')}
        objectId={recordId}
        objectType={object}
        preloaded={read}
      />
    </AttachmentsButton>
  );
}
