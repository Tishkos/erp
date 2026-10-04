import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { readAttachments } from '@/components/admin/attachments';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, formatQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { SEVERITY_TONE, STATUS_TONE } from '@/server/domain/exceptions';
import { registerAllRecords } from '@/server/records';
import { requireContext, withCurrentUser } from '@/server/session';
import * as recordNotes from '@/server/services/record-notes';
import * as exceptions from '@/server/services/exceptions';
import { acknowledgeException } from '../actions';

/**
 * One exception — platform phase, Agent 7. Copies the Task page: the document
 * window with its header fields and status chips; its lines the evidence — the
 * rows the check found, each with what is wrong with it; the verbs at its
 * foot, only the ones this person may take now (acknowledge, with the note it
 * requires) and the direct way to the place where it is dealt with; the four
 * doors in the title bar; the road it has walked as a register underneath.
 *
 * Nothing on this page repairs anything: it says what is wrong, where, since
 * when, and who is on it. It clears by itself when the cause is gone.
 */
export const dynamic = 'force-dynamic';

/** The kind of profile the party of a finding opens, by the domain it was found in. */
const PARTY_KIND = { receivables: 'customer', payables: 'supplier', logistics: 'supplier' } as const;

export default async function ExceptionPage({ params, searchParams }: { params: Promise<{ exceptionNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/exceptions')) notFound();
  registerAllRecords();
  const [t, x, page, column, locale, context, outcome, { exceptionNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.exceptions'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const exceptionNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', exceptions.PERMISSION_OBJECT)) return <Denied object={page('exceptions')} />;

  // Row security decides what exists for the reader; the service asks the one question SQL cannot: may they open the affected record.
  const found = await withCurrentUser(async (tx) => {
    const detail = await exceptions.byNo(tx, principal, exceptionNo, { locale: locale as Locale });
    if (!detail) return null;
    return {
      detail,
      notes: await recordNotes.listNotes(tx, { object: exceptions.PERMISSION_OBJECT, recordId: detail.no }),
      files: await readAttachments(tx, exceptions.PERMISSION_OBJECT, detail.id),
    };
  });
  if (!found) notFound();
  const { detail, notes, files } = found;

  const loc = locale as Locale;
  const moment = (value: string | null) => (value ? formatTimestamp(value, loc) : '—');
  const link = (href: string | null, label: string) =>
    href && href.startsWith('/') ? (
      <Link className={s.sapLink} href={href}>
        <bdi dir="auto">{label}</bdi>
      </Link>
    ) : (
      <bdi dir="auto">{label}</bdi>
    );
  const partyKind = detail.partyCode ? PARTY_KIND[detail.domain as keyof typeof PARTY_KIND] : undefined;

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{detail.no}</bdi> },
    { label: column('status'), value: x(`status_${detail.status}`), status: STATUS_TONE[detail.status] },
    { label: x('severity'), value: x(`severity_${detail.severity}`), status: SEVERITY_TONE[detail.severity] },
    { label: x('domain'), value: x(`domain_${detail.domain}`) },
    { label: x('col_exception'), value: <bdi dir="auto">{detail.title}</bdi>, wide: true },
    { label: x('what_is_wrong'), value: <bdi dir="auto">{detail.explanation}</bdi>, wide: true },
    { label: x('affected_record'), value: link(detail.recordHref, detail.recordLabel) },
    ...(detail.partyCode
      ? [
          {
            label: x('party'),
            value: partyKind ? <ProfileLink code={detail.partyCode} kind={partyKind} name={detail.partyName} /> : <bdi dir="ltr">{detail.partyCode}</bdi>,
          },
        ]
      : []),
    { label: x('owner'), value: <bdi dir="auto">{detail.ownerName ?? '—'}</bdi> },
    ...(detail.branchCode ? [{ label: x('branch'), value: <bdi dir="ltr">{detail.branchCode}</bdi> }] : []),
    { label: x('col_first'), value: <bdi dir="ltr">{moment(detail.firstDetectedAt)}</bdi> },
    { label: x('col_last'), value: <bdi dir="ltr">{moment(detail.lastSeenAt)}</bdi> },
    { label: x('occurrence'), value: <bdi dir="ltr">{detail.occurrence}</bdi> },
    ...(detail.acknowledgedAt
      ? [
          { label: x('acknowledged_by'), value: <bdi dir="auto">{detail.acknowledgedByName ?? '—'}</bdi> },
          { label: x('acknowledged_on'), value: <bdi dir="ltr">{moment(detail.acknowledgedAt)}</bdi> },
          ...(detail.acknowledgementNote ? [{ label: x('acknowledgement_note'), value: <bdi dir="auto">{detail.acknowledgementNote}</bdi>, wide: true }] : []),
        ]
      : []),
    ...(detail.resolvedAt ? [{ label: x('resolved_on'), value: <bdi dir="ltr">{moment(detail.resolvedAt)}</bdi> }] : []),
  ];

  return (
    <AdminPage back={{ href: '/exceptions', label: t('back') }} title={`${detail.no} · ${detail.title}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {detail.status === 'acknowledged' ? <p className={s.sapNote}>{x('acknowledged_note')}</p> : null}
      {detail.status === 'resolved' ? <p className={s.sapNote}>{x('resolved_note')}</p> : null}

      <DocumentWindow
        actions={
          <>
            {detail.mayAcknowledge ? (
              <form action={acknowledgeException}>
                <input name="exception_no" type="hidden" value={detail.no} />
                <input aria-label={x('ack_note')} maxLength={1000} name="note" placeholder={x('ack_note')} required type="text" />
                <Submit label={x('acknowledge')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {detail.status !== 'resolved' && detail.actionHref.startsWith('/') ? (
              <Link className="action action--primary" href={detail.actionHref}>
                {detail.actionLabel}
              </Link>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the four doors every record wears. */}
            <ExportIcon exportKey="exception" id={detail.no} title={`${x('document_type')} ${detail.no}`} />
            <RecordAttachmentsDoor files={files} mayAttach={detail.status !== 'resolved'} object={exceptions.PERMISSION_OBJECT} recordId={detail.id} />
            <RecordNotesDoor notes={notes} object={exceptions.PERMISSION_OBJECT} recordId={detail.no} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={detail.no} objectType={exceptions.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={x('document_type')}
        fields={fields}
        id="exception-document"
        linesCount={detail.evidence.length}
        linesTitle={x('evidence_title')}
        number={detail.no}
      >
        <table aria-labelledby="exception-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('ev_ref')}</th>
              <th scope="col">{x('ev_date')}</th>
              <th className={s.sapNum} scope="col">
                {x('ev_amount')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('ev_quantity')}
              </th>
              <th scope="col">{x('ev_note')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.evidence.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {x('evidence_none')}
                </td>
              </tr>
            ) : null}
            {detail.evidence.map((e, index) => (
              <tr key={`${e.ref}-${index}`}>
                <td>{link(e.href, e.ref)}</td>
                <td>
                  <bdi dir="ltr">{e.date ? formatBusinessDate(e.date, loc) : '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{e.amount ? formatMoney(e.amount, 'IQD', loc) : '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{e.quantity ? formatQuantity(e.quantity, loc) : '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{e.noteText || '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-labelledby="exception-road-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="exception-road-title">
            <span>{x('history_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: detail.history.length })}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="exception-road-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('hist_event')}</th>
                  <th scope="col">{x('hist_when')}</th>
                  <th scope="col">{x('hist_who')}</th>
                  <th scope="col">{x('severity')}</th>
                  <th scope="col">{x('hist_note')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.history.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {x('history_none')}
                    </td>
                  </tr>
                ) : null}
                {detail.history.map((h, index) => (
                  <tr key={`${h.occurredAt}-${index}`}>
                    <td>{x(`event_${h.event}`)}</td>
                    <td>
                      <bdi dir="ltr">{moment(h.occurredAt)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{h.actorName ?? x('hist_system')}</bdi>
                    </td>
                    <td>{x(`severity_${h.toSeverity}`)}</td>
                    <td>
                      <bdi dir="auto">{h.note ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
