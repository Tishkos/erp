import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Submit, SubmitRow, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as pb from '@/server/services/project-budget';
import * as ps from '@/server/services/project-system';
import { approveBudgetDocument, rejectBudgetDocument, submitBudgetDocument, updateBudgetDocument } from '../actions';

/**
 * One budget document — REQ-PM-001 §13. Copies the Purchase Invoice page:
 * the document window with its fields, the status chip, the transitions as
 * its actions and the lines; a draft's lines are typed in the grid as a
 * draft invoice's are; then the budget by element the approved documents
 * add up to, stacked underneath; then the history.
 */
export const dynamic = 'force-dynamic';

export default async function BudgetDocumentPage({ params, searchParams }: { params: Promise<{ no: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/projects/budgets')) notFound();
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
  if (!can(principal, 'view', pb.PERMISSION_OBJECT)) {
    return <Denied object={page('project_budgets')} />;
  }
  const actor = { principal, branchCode: context.scope.branchCode };

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await pb.budgetDocument(tx, actor, documentNo);
      const codes = (await ps.costCodes(tx)).filter((c) => c.active);
      return { view, codes };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { view, codes } = found;
  const doc = view.document;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const when = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const costName = (c: { nameEn: string; nameAr: string | null }) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);

  // Not a super user's: the service exempts them, and the button
  // should not hide what the service would allow (2026-10-04).
  const isRaiser = doc.createdBy === principal.userId && !principal.isSuperUser;
  const maySubmit = doc.status === 'draft' && can(principal, 'submit', pb.PERMISSION_OBJECT);
  const mayEdit = doc.status === 'draft' && can(principal, 'edit_draft', pb.PERMISSION_OBJECT);
  const mayDecide = doc.status === 'submitted' && can(principal, 'approve', pb.PERMISSION_OBJECT) && !isRaiser;

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{doc.documentNo}</bdi> },
    { label: column('status'), value: status(doc.status), status: doc.status },
    { label: x('kind'), value: x(`kind_${doc.kind}`) },
    {
      label: x('project'),
      value: (
        <Link className={s.sapLink} href={`/projects/${encodeURIComponent(doc.projectCode)}`}>
          <bdi dir="ltr">{doc.projectCode}</bdi>
        </Link>
      ),
    },
    { label: column('name'), value: <bdi dir="auto">{view.project.name}</bdi> },
    { label: column('date'), value: <bdi dir="ltr">{formatBusinessDate(doc.raisedOn, locale as Locale)}</bdi> },
    { label: column('amount'), value: <bdi dir="ltr">{money(doc.totalIqd)}</bdi> },
    { label: x('raised_by'), value: <bdi dir="auto">{view.people.createdBy ?? '—'}</bdi> },
    ...(doc.submittedAt ? [{ label: x('submitted_by'), value: <bdi dir="auto">{`${view.people.submittedBy ?? '—'} · ${when(doc.submittedAt)}`}</bdi> }] : []),
    ...(doc.approvedAt ? [{ label: x('approved_by'), value: <bdi dir="auto">{`${view.people.approvedBy ?? '—'} · ${when(doc.approvedAt)}`}</bdi> }] : []),
    ...(doc.rejectedAt ? [{ label: x('rejected_by'), value: <bdi dir="auto">{`${view.people.rejectedBy ?? '—'} · ${when(doc.rejectedAt)} · ${doc.rejectedReason ?? ''}`}</bdi> }] : []),
    ...(view.variationNo
      ? [
          {
            label: x('change_order'),
            value: (
              <Link className={s.sapLink} href={`/projects/change-orders/${encodeURIComponent(view.variationNo)}`}>
                <bdi dir="ltr">{view.variationNo}</bdi>
              </Link>
            ),
          },
        ]
      : []),
    { label: column('description'), value: <bdi dir="auto">{doc.description}</bdi> },
  ];

  // A draft's grid: the planning elements as rows, the cost codes as columns, the typed cells prefilled.
  const draftRows = view.budget.filter((e) => e.isPlanning && e.active);
  const cell = (wbsCode: string, costCode: string) => {
    const line = view.lines.find((l) => l.wbsCode === wbsCode && l.costCode === costCode);
    if (!line) return '';
    const amount = Number(line.amountIqd);
    return String(doc.kind === 'return' ? Math.abs(amount) : amount);
  };

  return (
    <AdminPage back={{ href: '/projects/budgets', label: t('back') }} title={doc.documentNo} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {maySubmit ? (
              <form action={submitBudgetDocument}>
                <Hidden name="document_no" value={doc.documentNo} />
                <Submit label={action('submit')} variant="document" />
              </form>
            ) : null}
            {mayDecide ? (
              <>
                <form action={approveBudgetDocument}>
                  <Hidden name="document_no" value={doc.documentNo} />
                  <Submit label={action('approve')} variant="document" />
                </form>
                <form action={rejectBudgetDocument}>
                  <Hidden name="document_no" value={doc.documentNo} />
                  <input aria-label={t('reason')} name="reason" placeholder={x('reject_reason')} required type="text" />
                  <Submit label={action('reject')} tone="secondary" variant="document" />
                </form>
              </>
            ) : null}
            {doc.status === 'submitted' && isRaiser ? <p className={s.sapNote}>{x('four_eyes_note')}</p> : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('budget_document')}
        fields={fields}
        id="budget-document"
        linesCount={mayEdit ? undefined : view.lines.length}
        linesTitle={x('lines')}
        number={doc.documentNo}
        totals={[{ label: column('amount'), value: money(doc.totalIqd) }]}
      >
        {mayEdit ? (
          <Form action={updateBudgetDocument}>
            <Hidden name="document_no" value={doc.documentNo} />
            <Hidden name="kind" value={doc.kind} />
            <Grid>
              <Field defaultValue={doc.raisedOn} label={column('date')} name="raised_on" required type="date" />
              <Field defaultValue={doc.description} label={column('description')} name="description" required wide />
            </Grid>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="budget-document-lines-heading" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('element')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('current_budget')}
                    </th>
                    {codes.map((c) => (
                      <th className={s.sapNum} key={c.code} scope="col">
                        {costName(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draftRows.map((element, row) => (
                    <tr key={element.wbsCode}>
                      <td>
                        <input name={`wbs_${row}`} type="hidden" value={element.wbsCode} />
                        <bdi dir="ltr">{`${'· '.repeat(Math.max(0, element.level - 1))}${element.wbsCode}`}</bdi> <bdi dir="auto">{element.name}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(element.currentIqd)}</bdi>
                      </td>
                      {codes.map((c) => (
                        <td className={s.sapNum} key={c.code}>
                          <input aria-label={`${costName(c)} ${element.wbsCode}`} className={s.sapCellField} defaultValue={cell(element.wbsCode, c.code)} inputMode="decimal" name={`amount_${row}_${c.code}`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.sapNote}>{x(`kind_${doc.kind}_lines`)}</p>
            <SubmitRow>
              <Submit label={t('save')} />
            </SubmitRow>
          </Form>
        ) : (
          <table aria-labelledby="budget-document-lines-heading" className={s.sapTable}>
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
              {view.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.lineNo}</td>
                  <td>
                    <bdi dir="ltr">{line.wbsCode}</bdi> <bdi dir="auto">{line.elementName ?? ''}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{line.costCode}</bdi> <bdi dir="auto">{line.costName ? costName({ nameEn: line.costName, nameAr: line.costNameAr ?? null }) : ''}</bdi>
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
        )}
      </DocumentWindow>

      <section aria-labelledby="budget-by-element-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="budget-by-element-title">
            <span>{x('budget_by_element')}</span>
            <span className={s.sapTitleMeta}>{x('approved_documents_only')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="budget-by-element-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('element')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('kind_original')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('supplements')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('returns')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('transfers')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('current_budget')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('rolled_up')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('assigned')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('available')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.budget.map((e) => (
                  <tr key={e.wbsCode}>
                    <td>
                      <bdi dir="ltr">{`${'· '.repeat(Math.max(0, e.level - 1))}${e.wbsCode}`}</bdi> <bdi dir="auto">{e.name}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(e.originalIqd)}</td>
                    <td className={s.sapNum}>{money(e.supplementsIqd)}</td>
                    <td className={s.sapNum}>{money(e.returnsIqd)}</td>
                    <td className={s.sapNum}>{money(e.transfersIqd)}</td>
                    <td className={s.sapNum}>{money(e.currentIqd)}</td>
                    <td className={s.sapNum}>{money(e.rolledUpIqd)}</td>
                    <td className={s.sapNum}>{money(e.assignedIqd)}</td>
                    <td className={s.sapNum}>{money(e.availableIqd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <RecordHistory objectId={doc.documentNo} objectType={pb.BUDGET_DOCUMENT_TYPE} />
    </AdminPage>
  );
}
