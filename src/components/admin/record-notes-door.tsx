import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { BUSINESS_TIME_ZONE } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import { addRecordNoteAction } from '@/server/record-notes-action';
import * as recordNotes from '@/server/services/record-notes';
import { NotesButton } from './icon-dialog';
import { ReturnToField } from './return-to-field';
import { Field, Form, Submit, SubmitRow, admin as s } from './index';

/**
 * The Notes door — the third of the four in a record's title bar (printer,
 * paperclip, notes, clock), the same on every record (2026-10-04).
 *
 * It is the purchase invoice's notes door made once: the speech mark with
 * how many notes there are, and behind it the table of who said what and
 * when, newest first, with the box to add one. Notes are kept by
 * `services/record-notes` as `<object>.note_added` audit events, so a note
 * is dated, signed and never edited.
 *
 * A module wires it with one line in `DocumentWindow.titleActions`:
 *
 *   <RecordNotesDoor notes={notes} object="ar_invoice" recordId={invoice.id} />
 *
 * where `object` and `recordId` are the ones the record's `RecordHistory` is
 * given, and `notes` is `recordNotes.listNotes(tx, { object, recordId })`
 * read in the page's own transaction (leave it out and the door reads them
 * itself). The box to add one shows to whoever `mayAddNote` allows; pass
 * `mayAdd` when the page already knows.
 */
export async function RecordNotesDoor({
  object,
  recordId,
  notes,
  mayAdd,
}: {
  readonly object: string;
  readonly recordId: string;
  readonly notes?: readonly recordNotes.RecordNote[];
  readonly mayAdd?: boolean;
}) {
  const [t, x] = await Promise.all([getTranslations('admin'), getTranslations('admin.record_notes')]);
  const rows = notes ?? (await withCurrentUser((tx) => recordNotes.listNotes(tx, { object, recordId })));
  const writable = mayAdd ?? recordNotes.mayAddNote((await requireContext()).principal, object);

  return (
    <NotesButton closeLabel={t('close')} count={rows.length} label={x('notes')} title={x('notes')}>
      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('note_when')}</th>
              <th scope="col">{x('note_who')}</th>
              <th scope="col">{x('note')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={3}>
                  {x('no_notes')}
                </td>
              </tr>
            ) : null}
            {rows.map((note) => (
              <tr key={note.id}>
                <td>
                  <bdi dir="ltr">{minuteOf(note.createdAt)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{note.author ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{note.body}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {writable ? (
        <Form action={addRecordNoteAction}>
          <input name="object" type="hidden" value={object} />
          <input name="record_id" type="hidden" value={recordId} />
          <Suspense fallback={null}>
            <ReturnToField />
          </Suspense>
          <Field
            hint={x('note_hint')}
            id="record-note"
            label={x('add_note')}
            maxLength={recordNotes.NOTE_MAX_LENGTH}
            name="note"
            required
            wide
          />
          <SubmitRow>
            <Submit label={x('add_note')} small tone="secondary" />
          </SubmitRow>
        </Form>
      ) : null}
    </NotesButton>
  );
}

const minuteFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY-MM-DD HH:mm` where the books are kept — the purchase invoice door's format. */
function minuteOf(iso: string): string {
  const parts = minuteFormat.formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}
