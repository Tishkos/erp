import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { Attachments, readAttachments } from '@/components/admin/attachments';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessDateOf } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as asycuda from '@/server/services/asycuda-runs';
import * as recordNotes from '@/server/services/record-notes';
import * as customs from '@/server/services/customs-pd';
import { applyAsycudaRun, attachToAsycudaRun, editAsycudaLines } from '../../actions';

/**
 * One ASYCUDA reading — IMPROVEMENT-002 (sponsor, 2026-10-03: "a new ASYCUDA
 * document, exactly like ASYCUDA, and add the attachment for it").
 *
 * The Purchase Invoice's window: the reading in boxes (its number, who read
 * it and when, the file, how many lines, what changes, applied by whom), and
 * its lines in the order ASYCUDA listed them — each line's own fields as they
 * were in the export, beside what was read from it, what the PD was then,
 * what it is now and what applying does. The export it was read from, the
 * history and the copy are the three doors in the title bar. Apply is the
 * action at the foot, once, by somebody who may import into the PDs.
 *
 * Until it is applied the lines are corrected in place (sponsor, 2026-10-04):
 * the PD number, the status ASYCUDA gives and the date are cells, a line can
 * be taken out from its status cell, and one more can be added at the foot —
 * the stock count's "count on the lines", saved as one form.
 */
export const dynamic = 'force-dynamic';

const OUTCOME_CHIP: Readonly<Record<asycuda.RunLine['outcome'], string>> = {
  change: 'approved',
  same: 'draft',
  not_found: 'rejected',
  ambiguous: 'rejected',
  final: 'cancelled',
  unreadable: 'rejected',
};

export default async function AsycudaReadingPage({
  params,
  searchParams,
}: {
  params: Promise<{ runNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/pd/asycuda')) notFound();
  const { runNo: raw } = await params;
  const runNo = decodeURIComponent(raw);
  const [t, admin, locale, context, outcome] = await Promise.all([
    getTranslations('admin.customs_pd'),
    getTranslations('admin'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'import', customs.PERMISSION_OBJECT)) {
    return <Denied object={t('asycuda')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const reading = await asycuda.runByNo(tx, runNo);
    if (!reading) return null;
    return {
      ...reading,
      lines: await asycuda.runLines(tx, reading.run),
      statuses: await customs.statuses(tx),
      files: await readAttachments(tx, asycuda.RUN_OBJECT, reading.run.id),
      notes: await recordNotes.listNotes(tx, { object: asycuda.RUN_OBJECT, recordId: reading.run.id }),
    };
  });
  if (!found) notFound();
  const { run, lines } = found;

  const ps = (code: string, name: string) => (locale !== 'en' && t.has(`ps.${code}`) ? t(`ps.${code}`) : name);
  const statusName = (code: string | null) => (code ? ps(code, found.statuses.find((row) => row.code === code)?.name ?? code) : '—');
  const day = (value: Date | null) => (value ? formatBusinessDate(businessDateOf(value), locale as Locale) : '—');
  const number = run.runNo ?? runNo;
  const applied = run.status === 'applied';
  const changes = lines.filter((line) => line.outcome === 'change').length;
  const editing = !applied;
  const choices = found.statuses
    .filter((row) => row.active !== false)
    .map((row) => (
      <option key={row.code} value={row.code}>
        {statusName(row.code)}
      </option>
    ));

  const fields: DocumentField[] = [
    { label: t('asycuda_no'), value: <bdi dir="ltr">{number}</bdi> },
    {
      label: t('status'),
      value: t(`asycuda_status_${run.status}`),
      status: applied ? 'approved' : 'draft',
    },
    { label: t('asycuda_read_at'), value: <bdi dir="ltr">{day(run.readAt)}</bdi> },
    { label: t('asycuda_read_by'), value: <bdi dir="auto">{found.readByName ?? '—'}</bdi> },
    {
      label: t('asycuda_from'),
      value: run.fileNames.length > 0 ? <bdi dir="auto">{run.fileNames.join(', ')}</bdi> : t('asycuda_pasted'),
      wide: true,
    },
    { label: t('asycuda_lines'), value: <bdi dir="ltr">{run.lineCount + run.unreadableCount}</bdi> },
    { label: t('asycuda_change_count'), value: <bdi dir="ltr">{run.changeCount}</bdi> },
    { label: t('unreadable'), value: <bdi dir="ltr">{run.unreadableCount}</bdi> },
    { label: t('asycuda_applied_at'), value: <bdi dir="ltr">{day(run.appliedAt)}</bdi> },
    { label: t('asycuda_applied_by'), value: <bdi dir="auto">{found.appliedByName ?? '—'}</bdi> },
  ];

  const cellLabel = (column: string, line: number | string) => `${column} ${line}`;
  const linesTable = (
    <table aria-labelledby="asycuda-document-lines-heading" className={s.sapTable}>
      <thead>
        <tr>
          <th scope="col">{t('line')}</th>
          <th scope="col">{t('asycuda_as_given')}</th>
          <th scope="col">{t('pd_no')}</th>
          <th scope="col">{t('asycuda_says')}</th>
          <th scope="col">{t('effective_date')}</th>
          <th scope="col">{t('import')}</th>
          <th scope="col">{t('asycuda_was')}</th>
          <th scope="col">{t('now')}</th>
          <th scope="col">{t('what_happens')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.length === 0 && !editing ? (
          <tr>
            <td className={s.sapEmptyRow} colSpan={9}>
              {t('asycuda_nothing')}
            </td>
          </tr>
        ) : null}
        {lines.map((line) => {
          const draft = asycuda.draftOf(line);
          return (
            <tr key={line.line}>
              <td>
                <bdi dir="ltr">{line.line}</bdi>
              </td>
              <td>
                <bdi dir="auto">{line.fields.join(' · ')}</bdi>
                {line.editedFrom !== null ? (
                  <div className="muted">
                    {line.editedFrom === '' ? (
                      t('asycuda_added_by_hand')
                    ) : (
                      <>
                        {t('asycuda_edited_from')}{' '}
                        <bdi dir="auto">
                          {line.editedFrom
                            .split(/\t|,|;|\s{2,}/)
                            .map((field) => field.trim())
                            .filter(Boolean)
                            .join(' · ')}
                        </bdi>
                      </>
                    )}
                  </div>
                ) : null}
              </td>
              <td>
                {editing ? (
                  <input
                    aria-label={cellLabel(t('pd_no'), line.line)}
                    className={s.sapCellField}
                    defaultValue={draft.pdNo}
                    dir="ltr"
                    name={`pd_${line.line}`}
                  />
                ) : line.pd ? (
                  <ProfileLink code={line.pd.pdNo} kind="pd" qualifier={{ year: line.pd.year }}>
                    {line.pd.pdNo}
                  </ProfileLink>
                ) : (
                  <bdi dir="ltr">{line.pdNo ?? '—'}</bdi>
                )}
              </td>
              <td>
                {editing ? (
                  <select
                    aria-label={cellLabel(t('asycuda_says'), line.line)}
                    className={s.sapCellField}
                    defaultValue={draft.statusCode}
                    name={`status_${line.line}`}
                  >
                    {line.outcome === 'unreadable' ? <option value="">—</option> : null}
                    {choices}
                    <option value={asycuda.DROP_LINE}>{t('asycuda_drop_line')}</option>
                  </select>
                ) : (
                  statusName(line.asycudaStatus)
                )}
              </td>
              <td>
                {editing ? (
                  <input
                    aria-label={cellLabel(t('effective_date'), line.line)}
                    className={s.sapCellField}
                    defaultValue={draft.effectiveDate}
                    name={`date_${line.line}`}
                    type="date"
                  />
                ) : (
                  <bdi dir="ltr">{line.outcome === 'unreadable' ? '—' : line.effectiveDate ? formatBusinessDate(line.effectiveDate, locale as Locale) : t('today')}</bdi>
                )}
              </td>
              <td>
                {line.payableNo ? (
                  <ProfileLink code={line.payableNo} kind="import">
                    {line.payableNo}
                  </ProfileLink>
                ) : (
                  '—'
                )}
              </td>
              <td>{statusName(line.wasStatus)}</td>
              <td>{statusName(line.pd?.statusCode ?? null)}</td>
              <td>
                <span className={`status status--${OUTCOME_CHIP[line.outcome]}`} data-status={OUTCOME_CHIP[line.outcome]}>
                  {line.outcome === 'unreadable' ? t('unreadable') : applied && line.outcome === 'change' ? t('outcome_changed') : t(`outcome_${line.outcome}`)}
                </span>
                {line.why ? (
                  <div className="muted">
                    <bdi dir="auto">{line.why}</bdi>
                  </div>
                ) : null}
              </td>
            </tr>
          );
        })}
        {editing ? (
          <tr>
            <td>{t('asycuda_new_line')}</td>
            <td>—</td>
            <td>
              <input aria-label={cellLabel(t('pd_no'), t('asycuda_new_line'))} className={s.sapCellField} dir="ltr" name="pd_new" />
            </td>
            <td>
              <select aria-label={cellLabel(t('asycuda_says'), t('asycuda_new_line'))} className={s.sapCellField} defaultValue="" name="status_new">
                <option value="">—</option>
                {choices}
              </select>
            </td>
            <td>
              <input aria-label={cellLabel(t('effective_date'), t('asycuda_new_line'))} className={s.sapCellField} name="date_new" type="date" />
            </td>
            <td colSpan={4} />
          </tr>
        ) : null}
      </tbody>
    </table>
  );

  return (
    <AdminPage
      back={{ href: '/payables/pd/asycuda', label: t('asycuda') }}
      tabs={<SectionTabs route="/payables/pd/asycuda" />}
      title={`${t('asycuda_document')} ${number}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the four doors in the standing order (2026-10-04). */}
            <ExportIcon exportKey="asycuda_reading" id={number} title={`${t('asycuda_document')} ${number}`} />
            <AttachmentsButton closeLabel={admin('close')} count={found.files.rows.length} label={admin('attachments.title')} title={admin('attachments.title')}>
              <Attachments
                action={attachToAsycudaRun}
                hidden={{ run_no: number }}
                mayAttach={can(principal, 'create', 'attachment')}
                objectId={run.id}
                objectType={asycuda.RUN_OBJECT}
                preloaded={found.files}
              />
            </AttachmentsButton>
            <RecordNotesDoor notes={found.notes} object={asycuda.RUN_OBJECT} recordId={run.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={run.id} objectType={asycuda.RUN_OBJECT} />
            </HistoryButton>
          </>
        }
        actions={
          <>
            {!applied && changes > 0 ? (
              <form action={applyAsycudaRun}>
                <Hidden name="run" value={run.id} />
                <Hidden name="run_no" value={number} />
                <Submit label={t('asycuda_apply', { count: changes })} variant="document" />
              </form>
            ) : null}
            <Link className="action" href="/payables/pd">
              {t('asycuda_to_pds')}
            </Link>
          </>
        }
        documentType={t('asycuda_document')}
        fields={fields}
        id="asycuda-document"
        linesCount={lines.length}
        linesTitle={t('asycuda_lines_title')}
        number={number}
        totals={[
          { label: t('asycuda_change_count'), value: String(changes) },
          { label: t('unreadable'), value: String(run.unreadableCount) },
        ]}
      >
        {editing ? (
          <form action={editAsycudaLines}>
            <Hidden name="run" value={run.id} />
            <Hidden name="run_no" value={number} />
            <Hidden name="sha" value={run.textSha256} />
            {linesTable}
            <div className={s.sapFootActions}>
              <span className="muted">{t('asycuda_edit_hint')}</span>
              <Submit label={t('asycuda_save_lines')} variant="document" />
            </div>
          </form>
        ) : (
          linesTable
        )}
      </DocumentWindow>
    </AdminPage>
  );
}
