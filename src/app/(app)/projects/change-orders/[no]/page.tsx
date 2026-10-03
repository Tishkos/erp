import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { toDecimalString } from '@/server/domain/money';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as pb from '@/server/services/project-budget';
import { approveChangeOrder, rejectChangeOrder } from '../actions';

/**
 * One change order — REQ-PM-001 §13. Copies the Purchase Invoice page: the
 * document window with the change's fields, the status chip, the two
 * approvals as its actions, the budget it moves as its lines; then the
 * project's position (baseline beside revised, R2) and the versions,
 * stacked underneath; then the history.
 */
export const dynamic = 'force-dynamic';

export default async function ChangeOrderPage({ params, searchParams }: { params: Promise<{ no: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/projects/change-orders')) notFound();
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
  const variationNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', pb.PERMISSION_OBJECT)) {
    return <Denied object={page('change_orders')} />;
  }
  const actor = { principal, branchCode: context.scope.branchCode };

  const view = await withCurrentUser(async (tx) => {
    try {
      return await pb.changeOrder(tx, actor, variationNo);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!view) notFound();
  const v = view.variation;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const when = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const costName = (en: string | null, ar: string | null) => (locale === 'ar' && ar ? ar : (en ?? ''));

  // Not a super user's: the service exempts them, and the button
  // should not hide what the service would allow (2026-10-04).
  const isRaiser = v.createdBy === principal.userId && !principal.isSuperUser;
  const mayApprove = v.status === 'draft' && can(principal, 'approve', pb.PERMISSION_OBJECT) && !isRaiser;

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{v.variationNo}</bdi> },
    { label: column('status'), value: status(v.status), status: v.status },
    {
      label: x('project'),
      value: (
        <Link className={s.sapLink} href={`/projects/${encodeURIComponent(v.projectCode)}`}>
          <bdi dir="ltr">{v.projectCode}</bdi>
        </Link>
      ),
    },
    { label: column('name'), value: <bdi dir="auto">{view.project.name}</bdi> },
    { label: column('date'), value: <bdi dir="ltr">{day(v.raisedOn)}</bdi> },
    { label: x('version'), value: <bdi dir="ltr">{`v${v.version}${view.supersedesNo ? ` · ${x('supersedes')} ${view.supersedesNo}` : ''}`}</bdi> },
    { label: x('contract_delta'), value: <bdi dir="ltr">{money(v.contractDeltaIqd)}</bdi> },
    { label: x('budget_delta'), value: <bdi dir="ltr">{money(v.budgetDeltaIqd)}</bdi> },
    { label: x('schedule_delta'), value: <bdi dir="ltr">{v.revisedEndsOn ? day(v.revisedEndsOn) : v.scheduleDeltaDays ? x('days', { count: v.scheduleDeltaDays }) : '—'}</bdi> },
    { label: x('raised_by'), value: <bdi dir="auto">{view.people.createdBy ?? '—'}</bdi> },
    { label: x('approval_commercial'), value: <bdi dir="auto">{v.commercialApprovedAt ? `${view.people.commercialBy ?? '—'} · ${when(v.commercialApprovedAt)}` : t('none')}</bdi> },
    { label: x('approval_budget'), value: <bdi dir="auto">{v.budgetApprovedAt ? `${view.people.budgetBy ?? '—'} · ${when(v.budgetApprovedAt)}` : t('none')}</bdi> },
    ...(v.rejectedAt ? [{ label: x('rejected_by'), value: <bdi dir="auto">{`${view.people.rejectedBy ?? '—'} · ${when(v.rejectedAt)} · ${v.rejectedReason ?? ''}`}</bdi> }] : []),
    ...(view.budgetDocumentNo
      ? [
          {
            label: x('budget_document'),
            value: (
              <Link className={s.sapLink} href={`/projects/budgets/${encodeURIComponent(view.budgetDocumentNo)}`}>
                <bdi dir="ltr">{view.budgetDocumentNo}</bdi>
              </Link>
            ),
          },
        ]
      : []),
    { label: column('description'), value: <bdi dir="auto">{v.description}</bdi> },
    ...(v.scopeNote ? [{ label: x('scope_note'), value: <bdi dir="auto">{v.scopeNote}</bdi> }] : []),
  ];

  return (
    <AdminPage back={{ href: '/projects/change-orders', label: t('back') }} title={v.variationNo} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove && !v.commercialApprovedBy ? (
              <form action={approveChangeOrder}>
                <Hidden name="variation_no" value={v.variationNo} />
                <Hidden name="which" value="commercial" />
                <Submit label={x('approve_commercial')} variant="document" />
              </form>
            ) : null}
            {mayApprove && !v.budgetApprovedBy ? (
              <form action={approveChangeOrder}>
                <Hidden name="variation_no" value={v.variationNo} />
                <Hidden name="which" value="budget" />
                <Submit label={x('approve_budget')} variant="document" />
              </form>
            ) : null}
            {mayApprove ? (
              <form action={rejectChangeOrder}>
                <Hidden name="variation_no" value={v.variationNo} />
                <input aria-label={t('reason')} name="reason" placeholder={x('reject_reason')} required type="text" />
                <Submit label={action('reject')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {v.status === 'draft' && isRaiser ? <p className={s.sapNote}>{x('four_eyes_note')}</p> : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('change_order')}
        fields={fields}
        id="change-order"
        linesCount={view.lines.length}
        linesTitle={x('budget_moved')}
        number={v.variationNo}
        totals={[{ label: x('budget_delta'), value: money(v.budgetDeltaIqd) }]}
      >
        <table aria-labelledby="change-order-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{x('element')}</th>
              <th scope="col">{x('cost_code')}</th>
              <th scope="col">{column('description')}</th>
              <th className={s.sapNum} scope="col">
                {column('amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {x('no_budget_moved')}
                </td>
              </tr>
            ) : null}
            {view.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td>
                  <bdi dir="ltr">{line.wbsCode}</bdi> <bdi dir="auto">{line.elementName ?? ''}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.costCode}</bdi> <bdi dir="auto">{costName(line.costName, line.costNameAr)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.amountIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-labelledby="co-position-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="co-position-title">
            <span>{x('position')}</span>
            <span className={s.sapTitleMeta}>{x('position_note')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="co-position-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('figure')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('baseline')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('revised')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{x('contract_value')}</td>
                  <td className={s.sapNum}>{money(toDecimalString(view.position.contractValueIqd, 4n))}</td>
                  <td className={s.sapNum}>{money(toDecimalString(view.position.revisedContractValueIqd, 4n))}</td>
                </tr>
                <tr>
                  <td>{x('budget')}</td>
                  <td className={s.sapNum}>{money(toDecimalString(view.position.budgetIqd, 4n))}</td>
                  <td className={s.sapNum}>{money(toDecimalString(view.position.revisedBudgetIqd, 4n))}</td>
                </tr>
                <tr>
                  <td>{x('baseline_ends_on')}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{day(view.position.endsOn || null)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{day(view.project.forecastEndsOn)}</bdi>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {view.versions.length > 0 ? (
        <section aria-labelledby="co-versions-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="co-versions-title">
              <span>{x('versions')}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="co-versions-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('document_no')}</th>
                    <th scope="col">{x('version')}</th>
                    <th scope="col">{column('status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.versions.map((row) => (
                    <tr key={row.variationNo}>
                      <td>
                        <Link className={s.sapLink} href={`/projects/change-orders/${encodeURIComponent(row.variationNo)}`}>
                          <bdi dir="ltr">{row.variationNo}</bdi>
                        </Link>
                      </td>
                      <td>v{row.version}</td>
                      <td>
                        <span className={`status status--${row.status}`} data-status={row.status}>
                          {status(row.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <RecordHistory objectId={v.variationNo} objectType={pb.VARIATION_DOCUMENT_TYPE} />
    </AdminPage>
  );
}
