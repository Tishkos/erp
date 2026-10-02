import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, Flash, Form, Grid, Hidden, Pill, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
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
import * as departments from '@/server/services/departments';
import * as pb from '@/server/services/project-budget';
import * as ps from '@/server/services/project-system';
import {
  addWbsElement,
  closeProject,
  holdProject,
  reopenProject,
  releaseProject,
  resumeProject,
  technicalCompleteProject,
  updateProject,
} from '../actions';
import { chipOf } from '../chip';

/**
 * One project — REQ-PM-001 §13. Copies the Purchase Invoice page: the
 * document window with the definition's fields, the status chip and the
 * transitions as its actions, the WBS tree as its lines; then the registers
 * Phase 11 keeps — budget by cost code, commitments, costs, certificates,
 * variations, balances — stacked underneath in the supplier-statement
 * manner; then the history.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/projects')) notFound();
  const [t, x, page, column, statusT, locale, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', ps.PERMISSION_OBJECT)) {
    return <Denied object={page('project_master')} />;
  }
  const actor = { principal, branchCode: context.scope.branchCode };

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await ps.record(tx, actor, code);
      const pickers = await ps.pickers(tx);
      const depts = (await departments.listAll(tx)).filter((d) => d.active);
      // PM-2 — the budget by element, its documents, the change orders and the plan.
      const elements = await pb.budgetSummary(tx, code);
      const documents = (await pb.budgetDocuments(tx, { projectCode: code, pageSize: 20 })).rows;
      const changes = (await pb.changeOrders(tx, { projectCode: code, pageSize: 20 })).rows;
      const plan = await pb.planByElement(tx, code);
      return { view, pickers, depts, elements, documents, changes, plan };
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { view, pickers, depts, elements, documents, changes, plan } = found;
  const row = view.project;
  const status = row.status;
  const kind = view.type?.kind ?? 'customer';

  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const typeLabel = view.type ? (locale === 'ar' && view.type.nameAr ? view.type.nameAr : view.type.nameEn) : row.typeCode;

  const mayEdit = can(principal, 'edit_draft', ps.PERMISSION_OBJECT) && status !== 'closed';
  const mayRelease = status === 'draft' && can(principal, 'approve', ps.PERMISSION_OBJECT) && row.createdBy !== principal.userId;
  const mayHold = status === 'active' && can(principal, 'submit', ps.PERMISSION_OBJECT);
  const mayResume = status === 'on_hold' && can(principal, 'submit', ps.PERMISSION_OBJECT);
  const mayComplete = status === 'active' && can(principal, 'approve', ps.PERMISSION_OBJECT);
  const mayReopen = status === 'closing' && !row.reopenedAt && can(principal, 'approve', ps.PERMISSION_OBJECT);
  const mayClose = status === 'closing' && can(principal, 'approve', ps.PERMISSION_OBJECT);
  const structureOpen = status === 'draft' || status === 'active' || status === 'on_hold';
  const total = view.tree.find((e) => e.level === 1);

  const fields: DocumentField[] = [
    { label: column('code'), value: <bdi dir="ltr">{row.code}</bdi> },
    { label: column('status'), value: x(`status_${status}`), status: chipOf(status) },
    { label: x('type'), value: <bdi dir="auto">{typeLabel}</bdi> },
    { label: x('customer'), value: <bdi dir="auto">{view.customer ? `${view.customer.name} (${view.customer.code})` : '—'}</bdi> },
    { label: x('manager'), value: <bdi dir="auto">{view.people.manager ?? '—'}</bdi> },
    { label: column('branch'), value: <bdi dir="ltr">{row.branchCode ?? '—'}</bdi> },
    { label: x('department'), value: <bdi dir="ltr">{row.departmentCode ?? '—'}</bdi> },
    { label: x('baseline_starts_on'), value: <bdi dir="ltr">{day(row.baselineStartsOn)}</bdi> },
    { label: x('baseline_ends_on'), value: <bdi dir="ltr">{day(row.baselineEndsOn)}</bdi> },
    { label: x('forecast_ends_on'), value: <bdi dir="ltr">{day(row.forecastEndsOn)}</bdi> },
    { label: x('contract_value'), value: <bdi dir="ltr">{money(row.contractValueIqd)}</bdi> },
    { label: x('baseline_budget'), value: <bdi dir="ltr">{money(row.baselineBudgetIqd)}</bdi> },
    { label: x('revised_budget'), value: <bdi dir="ltr">{money(toDecimalString(view.position.budgetIqd, 4n))}</bdi> },
    { label: x('tolerance_profile'), value: <bdi dir="auto">{view.profile ? (locale === 'ar' && view.profile.nameAr ? view.profile.nameAr : view.profile.nameEn) : row.toleranceProfileCode}</bdi> },
    { label: x('created_by'), value: <bdi dir="auto">{view.people.createdBy ?? '—'}</bdi> },
    { label: x('released_by'), value: <bdi dir="auto">{view.people.releasedBy ? `${view.people.releasedBy} · ${when(row.approvedAt)}` : t('none')}</bdi> },
    ...(row.heldAt ? [{ label: x('held'), value: <bdi dir="auto">{`${view.people.heldBy ?? '—'} · ${when(row.heldAt)} · ${row.heldReason ?? ''}`}</bdi> }] : []),
    ...(row.technicallyCompleteAt ? [{ label: x('technically_complete'), value: <bdi dir="auto">{`${view.people.technicallyCompleteBy ?? '—'} · ${when(row.technicallyCompleteAt)}`}</bdi> }] : []),
    ...(row.reopenedAt ? [{ label: x('reopened'), value: <bdi dir="auto">{`${view.people.reopenedBy ?? '—'} · ${when(row.reopenedAt)} · ${row.reopenedReason ?? ''}`}</bdi> }] : []),
    ...(row.closedAt ? [{ label: x('closed_by'), value: <bdi dir="auto">{`${view.people.closedBy ?? '—'} · ${when(row.closedAt)}`}</bdi> }] : []),
    ...(row.description ? [{ label: x('description'), value: <bdi dir="auto">{row.description}</bdi> }] : []),
  ];

  const reasonInput = (name: string, placeholder: string) => <input aria-label={t('reason')} name={name} placeholder={placeholder} required type="text" />;

  const parents = view.tree.filter((e) => e.active && e.level < 5);
  const addElementForm = (
    <Form action={addWbsElement}>
      <Hidden name="project_code" value={row.code} />
      <Grid>
        <Select defaultValue={total?.code ?? ''} label={x('parent')} name="parent_code" options={parents.map((e) => ({ value: e.code, label: `${e.code} · ${e.name}` }))} required />
        <Field hint={x('wbs_code_hint')} label={column('code')} name="code" />
        <Field label={column('name')} name="name" required wide />
        <Select defaultValue={row.managerUserId ?? ''} label={x('responsible')} name="responsible_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} />
        <Field label={x('planned_starts_on')} name="planned_starts_on" type="date" />
        <Field label={x('planned_ends_on')} name="planned_ends_on" type="date" />
      </Grid>
      <Field label={x('description')} name="description" wide />
      <Checkbox defaultChecked label={x('is_planning')} name="is_planning" />
      <Checkbox defaultChecked label={x('is_account_assignment')} name="is_account_assignment" />
      {kind === 'customer' ? <Checkbox label={x('is_billing')} name="is_billing" /> : null}
      <SubmitRow>
        <Submit label={t('save')} />
      </SubmitRow>
    </Form>
  );

  return (
    <AdminPage back={{ href: '/projects', label: t('back') }} title={`${row.code} · ${row.name}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_title', { code: row.code })}>
                <Form action={updateProject}>
                  <Hidden name="code" value={row.code} />
                  <Grid>
                    <Field defaultValue={row.name} label={column('name')} name="name" required wide />
                    <Select defaultValue={row.managerUserId ?? ''} label={x('manager')} name="manager_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} required />
                    <Select defaultValue={row.departmentCode ?? ''} emptyLabel="—" label={x('department')} name="department_code" options={depts.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))} />
                    <Select
                      defaultValue={row.toleranceProfileCode}
                      label={x('tolerance_profile')}
                      name="tolerance_profile_code"
                      options={pickers.profiles.map((p) => ({ value: p.code, label: locale === 'ar' && p.nameAr ? p.nameAr : p.nameEn }))}
                    />
                    <Field defaultValue={row.forecastStartsOn ?? ''} label={x('forecast_starts_on')} name="forecast_starts_on" type="date" />
                    <Field defaultValue={row.forecastEndsOn ?? ''} label={x('forecast_ends_on')} name="forecast_ends_on" type="date" />
                    {status === 'draft' ? (
                      <>
                        <Field defaultValue={row.baselineStartsOn ?? ''} label={x('baseline_starts_on')} name="baseline_starts_on" type="date" />
                        <Field defaultValue={row.baselineEndsOn ?? ''} label={x('baseline_ends_on')} name="baseline_ends_on" type="date" />
                        <Field defaultValue={row.baselineBudgetIqd} label={x('baseline_budget')} name="baseline_budget_iqd" />
                        <Field defaultValue={row.contractValueIqd} label={x('contract_value')} name="contract_value_iqd" />
                      </>
                    ) : null}
                  </Grid>
                  <Field defaultValue={row.description ?? ''} label={x('description')} name="description" wide />
                  {status !== 'draft' ? <p className={s.sapNote}>{x('baseline_fixed')}</p> : null}
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayRelease ? (
              <form action={releaseProject}>
                <Hidden name="code" value={row.code} />
                <Submit label={x('release')} variant="document" />
              </form>
            ) : null}
            {mayHold ? (
              <form action={holdProject}>
                <Hidden name="code" value={row.code} />
                {reasonInput('reason', x('hold_reason'))}
                <Submit label={x('hold')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayResume ? (
              <form action={resumeProject}>
                <Hidden name="code" value={row.code} />
                {reasonInput('reason', x('resume_reason'))}
                <Submit label={x('resume')} variant="document" />
              </form>
            ) : null}
            {mayComplete ? (
              <form action={technicalCompleteProject}>
                <Hidden name="code" value={row.code} />
                <Submit label={x('technical_complete')} variant="document" />
              </form>
            ) : null}
            {mayReopen ? (
              <form action={reopenProject}>
                <Hidden name="code" value={row.code} />
                {reasonInput('reason', x('reopen_reason'))}
                <Submit label={x('reopen')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayClose ? (
              <form action={closeProject}>
                <Hidden name="code" value={row.code} />
                {reasonInput('note', x('close_note'))}
                <Submit label={x('close')} variant="document" />
              </form>
            ) : null}
            {mayEdit && structureOpen && parents.length > 0 ? (
              <NewRecordDialog buttonLabel={x('add_child')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('add_element_title')}>
                {addElementForm}
              </NewRecordDialog>
            ) : null}
            <Link className="action" href={`/projects/wbs?project=${encodeURIComponent(row.code)}`}>
              {page('wbs')}
            </Link>
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('project_master')}
        fields={fields}
        id="project-document"
        linesCount={view.tree.length}
        linesTitle={x('structure')}
        number={row.code}
        totals={[
          { label: x('budget'), value: money(total?.budgetIqd ?? '0') },
          { label: x('committed'), value: money(total?.committedIqd ?? '0') },
          { label: x('actual'), value: money(total?.actualIqd ?? '0') },
          { label: x('available'), value: money(total?.availableIqd ?? '0') },
        ]}
      >
        <table aria-labelledby="project-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('code')}</th>
              <th scope="col">{column('name')}</th>
              <th scope="col">{x('responsible')}</th>
              <th scope="col">{x('planned_starts_on')}</th>
              <th scope="col">{x('planned_ends_on')}</th>
              <th scope="col">{x('indicators')}</th>
              <th className={s.sapNum} scope="col">
                {x('budget')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('committed')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('actual')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('available')}
              </th>
              <th scope="col">{x('availability')}</th>
            </tr>
          </thead>
          <tbody>
            {view.tree.map((element) => (
              <tr key={element.id}>
                <td>
                  <bdi dir="ltr">{`${'· '.repeat(Math.max(0, element.level - 1))}${element.code}`}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{element.name}</bdi>
                  {!element.active ? <span className="muted"> · {x('inactive')}</span> : null}
                </td>
                <td>
                  <bdi dir="auto">{element.responsibleName ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(element.plannedStartsOn)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(element.plannedEndsOn)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{[element.isPlanning ? x('ind_planning') : null, element.isAccountAssignment ? x('ind_account') : null, element.isBilling ? x('ind_billing') : null].filter(Boolean).join(' · ') || '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(element.budgetIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(element.committedIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(element.actualIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(element.availableIqd)}</bdi>
                </td>
                <td>
                  <Pill label={x(`availability_${element.availability}`)} on={element.availability === 'ok' ? true : element.availability === 'stop' ? false : null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-labelledby="project-elements-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="project-elements-title">
            <span>{x('budget_by_element')}</span>
            <span className={s.sapTitleMeta}>{plan.version ? x('plan_version_meta', { version: plan.version.version, name: plan.version.name }) : x('no_plan_yet')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-elements-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('element')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('planned')}
                  </th>
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
                  <th scope="col">{x('stop_line')}</th>
                </tr>
              </thead>
              <tbody>
                {elements.map((e) => (
                  <tr key={e.wbsCode}>
                    <td>
                      <bdi dir="ltr">{`${'· '.repeat(Math.max(0, e.level - 1))}${e.wbsCode}`}</bdi> <bdi dir="auto">{e.name}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(toDecimalString(plan.planned.get(e.wbsCode) ?? 0n, 4n))}</td>
                    <td className={s.sapNum}>{money(e.originalIqd)}</td>
                    <td className={s.sapNum}>{money(e.supplementsIqd)}</td>
                    <td className={s.sapNum}>{money(e.returnsIqd)}</td>
                    <td className={s.sapNum}>{money(e.transfersIqd)}</td>
                    <td className={s.sapNum}>{money(e.currentIqd)}</td>
                    <td className={s.sapNum}>{money(e.rolledUpIqd)}</td>
                    <td className={s.sapNum}>{money(e.assignedIqd)}</td>
                    <td className={s.sapNum}>{money(e.availableIqd)}</td>
                    <td>
                      <bdi dir="ltr">{e.stopPercentRaised === null ? (view.profile ? `${Number(view.profile.stopPercent)} %` : '—') : x('raised_to', { percent: e.stopPercentRaised })}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.sapNote}>
            <Link className={s.sapLink} href={`/projects/plan?project=${encodeURIComponent(row.code)}`}>
              {page('cost_plan')}
            </Link>
          </p>
        </div>
      </section>

      <section aria-labelledby="project-documents-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="project-documents-title">
            <span>{x('budget_documents')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: documents.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-documents-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th scope="col">{x('raised_by')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {documents.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {x('no_budgets')}
                    </td>
                  </tr>
                ) : null}
                {documents.map((d) => (
                  <tr key={d.documentNo}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/budgets/${encodeURIComponent(d.documentNo)}`}>
                        <bdi dir="ltr">{d.documentNo}</bdi>
                      </Link>
                    </td>
                    <td>{x(`kind_${d.kind}`)}</td>
                    <td>
                      <bdi dir="ltr">{day(d.raisedOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{d.description}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(d.totalIqd)}</td>
                    <td>
                      <bdi dir="auto">{d.raisedBy}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${d.status}`} data-status={d.status}>
                        {statusT(d.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayEdit && can(principal, 'create', ps.PERMISSION_OBJECT) ? (
            <p className={s.sapNote}>
              <Link className={s.sapLink} href={`/projects/budgets/new?project=${encodeURIComponent(row.code)}`}>
                {x('new_budget')}
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="project-changes-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="project-changes-title">
            <span>{x('change_orders')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: changes.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-changes-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('contract_delta')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('budget_delta')}
                  </th>
                  <th scope="col">{x('schedule_delta')}</th>
                  <th scope="col">{x('approvals')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {changes.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {x('no_change_orders')}
                    </td>
                  </tr>
                ) : null}
                {changes.map((c) => (
                  <tr key={c.variationNo}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/change-orders/${encodeURIComponent(c.variationNo)}`}>
                        <bdi dir="ltr">{c.variationNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(c.raisedOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{c.description}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(c.contractDeltaIqd)}</td>
                    <td className={s.sapNum}>{money(c.budgetDeltaIqd)}</td>
                    <td>
                      <bdi dir="ltr">{c.revisedEndsOn ? day(c.revisedEndsOn) : c.scheduleDeltaDays ? x('days', { count: c.scheduleDeltaDays }) : '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{[c.commercialIn ? x('approval_commercial') : null, c.budgetIn ? x('approval_budget') : null].filter(Boolean).join(' · ') || '—'}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${c.status}`} data-status={c.status}>
                        {statusT(c.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(status === 'active' || status === 'on_hold') && can(principal, 'create', ps.PERMISSION_OBJECT) ? (
            <p className={s.sapNote}>
              <Link className={s.sapLink} href={`/projects/change-orders/new?project=${encodeURIComponent(row.code)}`}>
                {x('new_change_order')}
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="project-budget-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="project-budget-title">
            <span>{x('budget_by_cost_code')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-budget-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('cost_code')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('baseline_budget')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('revisions')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('revised_budget')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('committed')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('actual')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('forecast')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('available')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.budget.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('no_budget_lines')}
                    </td>
                  </tr>
                ) : null}
                {view.budget.map((line) => (
                  <tr key={line.costCode}>
                    <td>
                      <bdi dir="ltr">{line.costCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{line.description}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(line.budgetIqd)}</td>
                    <td className={s.sapNum}>{money(line.revisionsIqd)}</td>
                    <td className={s.sapNum}>{money(line.revisedIqd)}</td>
                    <td className={s.sapNum}>{money(line.committedIqd)}</td>
                    <td className={s.sapNum}>{money(line.actualIqd)}</td>
                    <td className={s.sapNum}>{money(line.forecastIqd)}</td>
                    <td className={s.sapNum}>{money(line.availableIqd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="project-costs-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="project-costs-title">
            <span>{x('costs_and_commitments')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="project-costs-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{x('cost_code')}</th>
                  <th scope="col">{x('element')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.commitments.length === 0 && view.costs.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {x('no_costs')}
                    </td>
                  </tr>
                ) : null}
                {view.commitments.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <bdi dir="ltr">{day(c.committedOn)}</bdi>
                    </td>
                    <td>{c.releasedOn ? x('commitment_released') : x('commitment')}</td>
                    <td>
                      <bdi dir="ltr">{c.costCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{c.wbsCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{c.releasedOn ? `${day(c.releasedOn)} · ${c.releaseReason ?? ''}` : x('commitment_open', { consumed: money(c.consumedIqd) })}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(c.amountIqd)}</td>
                  </tr>
                ))}
                {view.costs.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <bdi dir="ltr">{day(k.incurredOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{k.kind}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{k.costCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{k.wbsCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{k.description}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(k.amountIqd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {kind === 'customer' ? (
        <section aria-labelledby="project-contract-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="project-contract-title">
              <span>{x('contract')}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="project-contract-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('billing_method')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('contract_value')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('revised_contract')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('retention_percent')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('retention_held')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('advance_recovery_percent')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('advance_outstanding')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('certificates')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('change_orders')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{x(`billing_${row.billingMethod}`)}</td>
                    <td className={s.sapNum}>{money(row.contractValueIqd)}</td>
                    <td className={s.sapNum}>{money(toDecimalString(view.position.contractValueIqd, 4n))}</td>
                    <td className={s.sapNum}>{row.retentionPercent}</td>
                    <td className={s.sapNum}>{money(view.retentionHeldIqd)}</td>
                    <td className={s.sapNum}>{row.advanceRecoveryPercent}</td>
                    <td className={s.sapNum}>{money(view.advanceOutstandingIqd)}</td>
                    <td className={s.sapNum}>{view.certificates.length}</td>
                    <td className={s.sapNum}>{view.variations.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <RecordHistory objectId={row.code} objectType={ps.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
