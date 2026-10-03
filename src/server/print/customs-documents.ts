/**
 * The ASYCUDA reading as a document — IMPROVEMENT-002 (sponsor, 2026-10-03:
 * "a new ASYCUDA document … attachment and print and audit icon as other
 * pages"). The reading's boxes and its lines in the order ASYCUDA listed
 * them: each line's own fields, what was read from it, what the PD was then
 * and is now, and what applying does. One model for the PDF, the workbook
 * and the Word file, read through the reader's own row security.
 */
import { formatBusinessDate } from '@/i18n/config';
import en from '../../../messages/en.json';
import { businessDateOf } from '../domain/business-date';
import * as asycuda from '../services/asycuda-runs';
import * as customs from '../services/customs-pd';
import type { BuildContext, Built } from './documents';

const TRANSLATED = new Set(Object.keys(en.admin.customs_pd.ps));

export async function asycudaReading(ctx: BuildContext, runNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await asycuda.runByNo(tx, runNo);
  if (!found) return null;
  const { run } = found;
  const lines = await asycuda.runLines(tx, run);
  const statuses = await customs.statuses(tx);
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`customs_pd.${key}`, values);
  const statusName = (code: string | null) => {
    if (!code) return '—';
    if (locale !== 'en' && TRANSLATED.has(code)) return t(`ps.${code}`);
    return statuses.find((row) => row.code === code)?.name ?? code;
  };
  const day = (value: Date | null) => (value ? formatBusinessDate(businessDateOf(value), locale) : '—');
  const applied = run.status === 'applied';
  const number = run.runNo ?? runNo;
  const outcome = (line: asycuda.RunLine) =>
    line.outcome === 'unreadable' ? t('unreadable') : applied && line.outcome === 'change' ? t('outcome_changed') : t(`outcome_${line.outcome}`);

  return {
    model: {
      kind: 'document',
      title: m.print('titles.asycuda_reading'),
      number,
      status: t(`asycuda_status_${run.status}`),
      posted: true,
      orientation: 'landscape',
      fields: [
        { label: t('asycuda_no'), value: number, ltr: true },
        { label: t('asycuda_read_at'), value: day(run.readAt), ltr: true },
        { label: t('asycuda_read_by'), value: found.readByName ?? '—' },
        { label: t('asycuda_from'), value: run.fileNames.length > 0 ? run.fileNames.join(', ') : t('asycuda_pasted') },
        { label: t('asycuda_lines'), value: String(run.lineCount + run.unreadableCount), ltr: true },
        { label: t('asycuda_change_count'), value: String(run.changeCount), ltr: true },
        { label: t('unreadable'), value: String(run.unreadableCount), ltr: true },
        { label: t('asycuda_applied_at'), value: day(run.appliedAt), ltr: true },
        { label: t('asycuda_applied_by'), value: found.appliedByName ?? '—' },
      ],
      filters: [],
      tables: [
        {
          title: t('asycuda_lines_title'),
          columns: [
            { key: 'line', label: t('line'), kind: 'code' },
            { key: 'given', label: t('asycuda_as_given'), kind: 'text', weight: 2 },
            { key: 'pd', label: t('pd_no'), kind: 'code' },
            { key: 'says', label: t('asycuda_says'), kind: 'text' },
            { key: 'date', label: t('effective_date'), kind: 'text' },
            { key: 'import', label: t('import'), kind: 'code' },
            { key: 'was', label: t('asycuda_was'), kind: 'text' },
            { key: 'now', label: t('now'), kind: 'text' },
            { key: 'outcome', label: t('what_happens'), kind: 'text', weight: 1.5 },
          ],
          rows: lines.map((line) => ({
            cells: {
              line: String(line.line),
              given: line.fields.join(' · '),
              pd: line.pd?.pdNo ?? line.pdNo ?? '—',
              says: statusName(line.asycudaStatus),
              date: line.outcome === 'unreadable' ? '—' : line.effectiveDate ? formatBusinessDate(line.effectiveDate, locale) : t('today'),
              import: line.payableNo ?? '—',
              was: statusName(line.wasStatus),
              now: statusName(line.pd?.statusCode ?? null),
              outcome: line.why ? `${outcome(line)} — ${line.why}` : outcome(line),
            },
          })),
          empty: t('asycuda_nothing'),
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: number,
      sheetName: number,
    },
    // A reading is the company's, not a branch's: the reader's letterhead.
    branchCode: ctx.branchCode,
    objectId: run.id,
  };
}
