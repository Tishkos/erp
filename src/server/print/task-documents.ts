/**
 * The Task Center's print model — platform phase, Agent 3.
 *
 * `task` — one task: who asked whom, for when, in which section and about
 * which record, what it says, and where it stands on its road (every moment
 * the database stamped). It is built from `tasks.byNo`, so a copy shows what
 * the reader's own screen shows and nothing more: a task the reader cannot
 * open is not found, and the export route answers as for any other missing
 * document. "Posted" for the watermark means the task has left the draft.
 */
import { formatBusinessDate, formatTimestamp } from '@/i18n/config';
import * as tasks from '../services/tasks';
import type { BuildContext, Built } from './documents';
import type { Column, Fact, Row } from './model';

export async function task(ctx: BuildContext, taskNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const detail = await tasks.byNo(tx, { principal: ctx.principal }, taskNo);
  if (!detail) return null;
  const { row } = detail;
  const x = (key: string) => m.admin(`tasks.${key}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const moment = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale) : null);
  const statusLabel = x(`status_${row.status}`);

  const fields: Fact[] = [
    { label: m.column('reference'), value: row.taskNo, ltr: true },
    { label: m.column('status'), value: statusLabel },
    { label: x('title_field'), value: row.title },
    { label: x('priority'), value: x(`priority_${row.priority}`) },
    { label: x('section'), value: detail.departmentName },
    { label: x('assignee'), value: detail.assignee?.name ?? '—' },
    { label: x('assigned_by'), value: detail.assignedBy?.name ?? '—' },
    { label: x('created_by'), value: detail.createdBy.name },
    { label: x('due'), value: day(row.dueDate), ltr: true },
    { label: x('progress'), value: `${detail.progress}%`, ltr: true },
  ];
  if (detail.related) fields.push({ label: x('related'), value: `${detail.related.label}`, ltr: true });
  if (row.tags.length > 0) fields.push({ label: x('tags'), value: row.tags.join(', ') });
  if (detail.watchers.length > 0) fields.push({ label: x('watchers'), value: detail.watchers.map((w) => w.name).join(', ') });
  if (row.statusNote) fields.push({ label: x('latest_note'), value: row.statusNote });

  const descriptionColumns: Column[] = [{ key: 'text', label: x('description'), kind: 'text' }];
  const descriptionRows: Row[] = (row.description ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ cells: { text: p } }));

  const stamps: [string, Date | null][] = [
    ['created', row.createdAt],
    ['assigned', row.assignedAt],
    ['accepted', row.acceptedAt],
    ['started', row.startedAt],
    ['blocked', row.blockedAt],
    ['submitted', row.submittedAt],
    ['completed', row.completedAt],
    ['cancelled', row.cancelledAt],
  ];
  const timelineColumns: Column[] = [
    { key: 'step', label: x('timeline_step'), kind: 'text' },
    { key: 'at', label: x('timeline_at'), kind: 'text' },
  ];
  const timelineRows: Row[] = stamps
    .map(([step, at]) => ({ step, at: moment(at) }))
    .filter((s): s is { step: string; at: string } => s.at !== null)
    .map((s) => ({ cells: { step: x(`timeline_${s.step}`), at: s.at } }));

  return {
    model: {
      kind: 'document',
      title: m.print('titles.task'),
      number: row.taskNo,
      status: statusLabel,
      posted: row.status !== 'draft',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        { title: x('description'), columns: descriptionColumns, rows: descriptionRows, empty: '—' },
        { title: x('timeline'), columns: timelineColumns, rows: timelineRows, empty: '—' },
      ],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: row.taskNo,
      sheetName: row.taskNo,
    },
    branchCode: row.branchCode,
    objectId: row.taskNo,
  };
}
