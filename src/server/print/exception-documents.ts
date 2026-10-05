/**
 * The Exception Center's print model — platform phase, Agent 7.
 *
 * `exception` — one exception: what is wrong in words, the record it is
 * about, the rows the check found, and the road it has walked (detected,
 * acknowledged, cleared, found again). It is built from `exceptions.byNo`, so
 * a copy shows what the reader's own screen shows and nothing more: an
 * exception the reader cannot open is not found, and the export route
 * answers as for any other missing document. "Posted" for the watermark
 * means the exception has been dealt with: cleared once the cause was gone.
 */
import { formatTimestamp } from '@/i18n/config';
import * as exceptions from '../services/exceptions';
import type { BuildContext, Built } from './documents';
import type { Column, Fact, Row } from './model';

export async function exception(ctx: BuildContext, exceptionNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await exceptions.byNo(tx, ctx.principal, exceptionNo, { locale });
  if (!detail) return null;
  const x = (key: string, values?: Record<string, string | number>) => m.admin(`exceptions.${key}`, values);
  const moment = (iso: string | null) => (iso ? formatTimestamp(iso, locale) : '—');
  const statusLabel = x(`status_${detail.status}`);

  const fields: Fact[] = [
    { label: m.column('reference'), value: detail.no, ltr: true },
    { label: m.column('status'), value: statusLabel },
    { label: x('severity'), value: x(`severity_${detail.severity}`) },
    { label: x('domain'), value: x(`domain_${detail.domain}`) },
    { label: x('what_is_wrong'), value: detail.title },
    { label: x('affected_record'), value: detail.recordLabel, ltr: true },
    { label: x('owner'), value: detail.ownerName ?? '—' },
    { label: x('col_first'), value: moment(detail.firstDetectedAt), ltr: true },
    { label: x('col_last'), value: moment(detail.lastSeenAt), ltr: true },
    { label: x('occurrence'), value: String(detail.occurrence), ltr: true },
  ];
  if (detail.partyCode) fields.push({ label: x('party'), value: detail.partyCode, ltr: true });
  if (detail.branchCode) fields.push({ label: x('branch'), value: detail.branchCode, ltr: true });
  if (detail.acknowledgedAt) {
    fields.push({ label: x('acknowledged_by'), value: detail.acknowledgedByName ?? '—' });
    fields.push({ label: x('acknowledged_on'), value: moment(detail.acknowledgedAt), ltr: true });
    if (detail.acknowledgementNote) fields.push({ label: x('acknowledgement_note'), value: detail.acknowledgementNote });
  }
  if (detail.resolvedAt) fields.push({ label: x('resolved_on'), value: moment(detail.resolvedAt), ltr: true });

  const explanationColumns: Column[] = [{ key: 'text', label: x('what_is_wrong'), kind: 'text' }];
  const explanationRows: Row[] = detail.explanation
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ cells: { text: p } }));
  explanationRows.push({ cells: { text: `${x('what_to_do')}: ${detail.actionLabel}` } });

  const evidenceColumns: Column[] = [
    { key: 'ref', label: x('ev_ref'), kind: 'code', weight: 2 },
    { key: 'date', label: x('ev_date'), kind: 'date' },
    { key: 'amount', label: x('ev_amount'), kind: 'money' },
    { key: 'quantity', label: x('ev_quantity'), kind: 'quantity' },
    { key: 'note', label: x('ev_note'), kind: 'text', weight: 4 },
  ];
  const evidenceRows: Row[] = detail.evidence.map((e) => ({
    cells: { ref: e.ref, date: e.date, amount: e.amount, quantity: e.quantity, note: e.noteText || null },
    counts: false,
  }));

  const historyColumns: Column[] = [
    { key: 'event', label: x('hist_event'), kind: 'text', weight: 3 },
    { key: 'when', label: x('hist_when'), kind: 'text', weight: 2 },
    { key: 'who', label: x('hist_who'), kind: 'text', weight: 2 },
    { key: 'note', label: x('hist_note'), kind: 'text', weight: 4 },
  ];
  const historyRows: Row[] = detail.history.map((h) => ({
    cells: { event: x(`event_${h.event}`), when: moment(h.occurredAt), who: h.actorName ?? x('hist_system'), note: h.note },
    counts: false,
  }));

  return {
    model: {
      kind: 'document',
      title: m.print('titles.exception'),
      number: detail.no,
      status: statusLabel,
      posted: detail.status === 'resolved',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        { title: x('what_is_wrong'), columns: explanationColumns, rows: explanationRows, empty: '—' },
        { title: x('evidence_title'), columns: evidenceColumns, rows: evidenceRows, empty: x('evidence_none') },
        { title: x('history_title'), columns: historyColumns, rows: historyRows, empty: x('history_none') },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: detail.no,
      sheetName: detail.no,
    },
    branchCode: detail.branchCode ?? ctx.branchCode,
    objectId: detail.no,
  };
}
