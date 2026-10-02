import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatQuantity as formatLocaleQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as pe from '@/server/services/project-execution';
import { cancelMaterialIssue, postMaterialIssue } from '../actions';

/**
 * One material issue — REQ-PM-001 §9. Copies the Purchase Invoice page: the
 * document window with its fields, the status chip, Post and Cancel as its
 * actions, the lines with the cost each one became; then the history.
 */
export const dynamic = 'force-dynamic';

export default async function MaterialIssuePage({ params, searchParams }: { params: Promise<{ no: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/projects/material-issues')) notFound();
  const [t, x, page, column, status, action, locale, context, outcome, { no: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('action'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const documentNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', pe.PERMISSION_OBJECT)) {
    return <Denied object={page('material_issues')} />;
  }
  const actor = { principal, branchCode: context.scope.branchCode };
  const view = await withCurrentUser(async (tx) => {
    try {
      return await pe.issue(tx, actor, documentNo);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!view) notFound();
  const doc = view.document;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const when = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const mayPost = doc.status === 'draft' && can(principal, 'post', pe.PERMISSION_OBJECT);
  const mayCancel = doc.status === 'draft' && can(principal, 'edit_draft', pe.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{doc.documentNo}</bdi> },
    { label: column('status'), value: status(doc.status), status: doc.status },
    { label: x('kind'), value: doc.kind === 'issue' ? x('kind_issue') : x('kind_return_stock') },
    {
      label: x('project'),
      value: (
        <Link className={s.sapLink} href={`/projects/${encodeURIComponent(doc.projectCode)}`}>
          <bdi dir="ltr">{doc.projectCode}</bdi>
        </Link>
      ),
    },
    { label: column('name'), value: <bdi dir="auto">{view.project.name}</bdi> },
    { label: x('element'), value: <bdi dir="auto">{`${doc.wbsCode}${view.elementName ? ` · ${view.elementName}` : ''}`}</bdi> },
    { label: x('cost_code'), value: <bdi dir="ltr">{doc.costCode}</bdi> },
    { label: column('warehouse'), value: <bdi dir="ltr">{doc.warehouseCode}</bdi> },
    { label: column('date'), value: <bdi dir="ltr">{formatBusinessDate(doc.movementDate, locale as Locale)}</bdi> },
    { label: x('cost'), value: <bdi dir="ltr">{money(doc.totalCostIqd)}</bdi> },
    { label: x('raised_by'), value: <bdi dir="auto">{view.people.createdBy ?? '—'}</bdi> },
    ...(doc.postedAt ? [{ label: x('posted_by'), value: <bdi dir="auto">{`${view.people.postedBy ?? '—'} · ${when(doc.postedAt)}`}</bdi> }] : []),
    ...(doc.cancelledAt ? [{ label: x('cancelled_by'), value: <bdi dir="auto">{`${view.people.cancelledBy ?? '—'} · ${when(doc.cancelledAt)} · ${doc.cancelReason ?? ''}`}</bdi> }] : []),
    ...(doc.description ? [{ label: column('description'), value: <bdi dir="auto">{doc.description}</bdi> }] : []),
  ];

  return (
    <AdminPage back={{ href: '/projects/material-issues', label: t('back') }} title={doc.documentNo} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayPost ? (
              <form action={postMaterialIssue}>
                <Hidden name="document_no" value={doc.documentNo} />
                <Submit label={action('post')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelMaterialIssue}>
                <Hidden name="document_no" value={doc.documentNo} />
                <input aria-label={t('reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                <Submit label={action('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('material_issue')}
        fields={fields}
        id="material-issue"
        linesCount={view.lines.length}
        linesTitle={x('lines')}
        number={doc.documentNo}
        totals={[{ label: x('cost'), value: money(doc.totalCostIqd) }]}
      >
        <table aria-labelledby="material-issue-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th scope="col">{column('batch_number')}</th>
              <th scope="col">{column('serial_number')}</th>
              <th className={s.sapNum} scope="col">
                {x('unit_cost')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('cost')}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td>
                  <bdi dir="ltr">{line.itemCode}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.itemName ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{formatLocaleQuantity(line.quantity, locale as Locale)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.batchNumber ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.serialNumber ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{line.unitCostIqd ? money(line.unitCostIqd) : doc.status === 'posted' ? x('at_layer_cost') : '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{doc.status === 'posted' ? money(line.costIqd) : '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={doc.documentNo} objectType={pe.ISSUE_DOCUMENT_TYPE} />
    </AdminPage>
  );
}
