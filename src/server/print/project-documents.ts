/**
 * The Project System's progress certificate as a document (2026-10-04) —
 * the client's invoice for work done (REQ-PM-001 §11, D-PM-11): the fields
 * its page shows, the retention and advance movements it made as its lines,
 * and gross, retention, advance recovered and net at its foot. One model for
 * the PDF, the workbook and the Word file, read through the reader's row
 * security. A draft carries the DRAFT watermark; a certificate is posted
 * when it is approved.
 */
import { formatBusinessDate, formatMoney } from '@/i18n/config';
import * as billing from '../services/project-billing';
import type { BuildContext, Built } from './documents';
import type { Row } from './model';

export async function projectCertificate(ctx: BuildContext, certificateNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let view: Awaited<ReturnType<typeof billing.certificate>>;
  try {
    view = await billing.certificate(tx, certificateNo);
  } catch {
    return null;
  }
  const cert = view.certificate;
  const x = (key: string) => m.admin(`projects.${key}`);
  const money = (value: string) => formatMoney(value, 'IQD', locale);
  const rows: Row[] = view.movements.map((movement) => ({
    cells: {
      kind: x(`balance_${movement.kind}`),
      date: movement.movedOn,
      description: movement.description,
      amount: movement.amountIqd,
    },
  }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.project_certificate'),
      number: cert.certificateNo,
      status: m.status(cert.status),
      posted: cert.status === 'posted',
      orientation: 'portrait',
      fields: [
        { label: x('certificate'), value: cert.certificateNo, ltr: true },
        { label: m.column('status'), value: m.status(cert.status) },
        { label: x('certificate_basis'), value: x(`basis_${cert.basis}`) },
        { label: x('project'), value: `${view.project.code} · ${view.project.name}` },
        {
          label: x('customer'),
          value: view.project.customerCode ? `${view.project.customerCode} · ${view.project.customerName ?? ''}` : '—',
        },
        { label: x('certified_on'), value: formatBusinessDate(cert.certifiedOn, locale), ltr: true },
        { label: x('percent_complete'), value: `${Number(cert.percentComplete)} %`, ltr: true },
        ...(view.planLine ? [{ label: x('billing_line'), value: `${view.planLine.lineNo} · ${view.planLine.description}` }] : []),
        { label: x('journal'), value: view.entryNo ?? '—', ltr: true },
        { label: x('raised_by'), value: view.people.createdBy ?? '—' },
        ...(cert.approvedAt ? [{ label: x('approved_by'), value: view.people.approvedBy ?? '—' }] : []),
      ],
      filters: [],
      tables: [
        {
          title: x('balance_movements'),
          columns: [
            { key: 'kind', label: x('balance_kind'), kind: 'text' },
            { key: 'date', label: m.column('date'), kind: 'date' },
            { key: 'description', label: m.column('description'), kind: 'text', weight: 2 },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
          ],
          rows,
          empty: x('no_balance_movements'),
        },
      ],
      summary: [
        { label: x('gross'), value: money(cert.grossIqd), ltr: true },
        { label: x('retention'), value: money(cert.retentionIqd), ltr: true },
        { label: x('advance_recovered'), value: money(cert.advanceRecoveredIqd), ltr: true },
        { label: x('net'), value: money(cert.netIqd), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: cert.certificateNo,
      sheetName: cert.certificateNo,
    },
    branchCode: cert.branchCode,
    objectId: cert.certificateNo,
  };
}
