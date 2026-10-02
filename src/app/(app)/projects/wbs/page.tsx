import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, FilterRow, Flash, Form, Grid, Hidden, Pill, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ps from '@/server/services/project-system';
import { addWbsElement, setWbsElementActive, updateWbsElement } from '../actions';
import { chipOf } from '../chip';

/**
 * WBS — REQ-PM-001 §13. Copies the Payables workbench: one window, a filter
 * row naming the project, the tree as the register with the five amounts
 * rolled up, and the element dialogs beside each row.
 */
export const dynamic = 'force-dynamic';

export default async function WbsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/wbs')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', ps.PERMISSION_OBJECT)) {
    return <Denied object={page('wbs')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const actor = { principal, branchCode: context.scope.branchCode };

  const { choices, view, pickers } = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = asked || choices.find((c) => c.status !== 'closed')?.code || choices[0]?.code || '';
    try {
      return { choices, view: code ? await ps.record(tx, actor, code) : null, pickers: await ps.pickers(tx) };
    } catch (error) {
      if (isNotFoundError(error)) return { choices, view: null, pickers: await ps.pickers(tx) };
      throw error;
    }
  });
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const mayEdit = Boolean(view) && can(principal, 'edit_draft', ps.PERMISSION_OBJECT) && ['draft', 'active', 'on_hold'].includes(view!.project.status);
  const kind = view?.type?.kind ?? 'customer';

  const elementForm = (action: (form: FormData) => Promise<void>, element: NonNullable<typeof view>['tree'][number] | null, parents: NonNullable<typeof view>['tree']) =>
    view ? (
      <Form action={action}>
        <Hidden name="project_code" value={view.project.code} />
        <Hidden name="back" value="wbs" />
        {element ? <Hidden name="wbs_code" value={element.code} /> : null}
        <Grid>
          {element ? null : (
            <Select defaultValue={parents.find((e) => e.level === 1)?.code ?? ''} label={x('parent')} name="parent_code" options={parents.map((e) => ({ value: e.code, label: `${e.code} · ${e.name}` }))} required />
          )}
          {element ? null : <Field hint={x('wbs_code_hint')} label={column('code')} name="code" />}
          <Field defaultValue={element?.name ?? ''} label={column('name')} name="name" required wide />
          <Select defaultValue={element?.responsibleUserId ?? view.project.managerUserId ?? ''} label={x('responsible')} name="responsible_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} />
          <Field defaultValue={element?.plannedStartsOn ?? ''} label={x('planned_starts_on')} name="planned_starts_on" type="date" />
          <Field defaultValue={element?.plannedEndsOn ?? ''} label={x('planned_ends_on')} name="planned_ends_on" type="date" />
        </Grid>
        <Field defaultValue={element?.description ?? ''} label={x('description')} name="description" wide />
        <Checkbox defaultChecked={element ? element.isPlanning : true} label={x('is_planning')} name="is_planning" />
        <Checkbox defaultChecked={element ? element.isAccountAssignment : true} label={x('is_account_assignment')} name="is_account_assignment" />
        {kind === 'customer' ? <Checkbox defaultChecked={element ? element.isBilling : false} label={x('is_billing')} name="is_billing" /> : null}
        <SubmitRow>
          <Submit label={t('save')} />
        </SubmitRow>
      </Form>
    ) : null;

  const parents = view ? view.tree.filter((e) => e.active && e.level < 5) : [];

  return (
    <AdminPage
      actions={
        mayEdit && parents.length > 0 ? (
          <NewRecordDialog buttonLabel={x('add_child')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('add_element_title')}>
            {elementForm(addWbsElement, null, parents)}
          </NewRecordDialog>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/wbs" />}
      subtitle={x('wbs_subtitle')}
      title={page('wbs')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="wbs-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wbs-title">
            <span>{view ? `${view.project.code} · ${view.project.name}` : page('wbs')}</span>
            {view ? <span className={s.sapTitleMeta}>{t('rows_shown', { count: view.tree.length })}</span> : null}
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view?.project.code ?? ''} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} required />
              <SubmitRow>
                <Submit label={x('open')} />
              </SubmitRow>
            </FilterRow>
          </form>

          {view ? (
            <>
              <p className={s.sapNote}>
                <span className={`status status--${chipOf(view.project.status)} ${s.sapRegisterStatus}`} data-status={chipOf(view.project.status)}>
                  {x(`status_${view.project.status}`)}
                </span>{' '}
                <Link className={s.sapLink} href={`/projects/${encodeURIComponent(view.project.code)}`}>
                  {x('open_record')}
                </Link>
              </p>
              <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
                <table aria-labelledby="wbs-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
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
                      <th scope="col">{t('active')}</th>
                      {mayEdit ? <th scope="col">{t('actions')}</th> : null}
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
                        <td className={s.sapNum}>{money(element.budgetIqd)}</td>
                        <td className={s.sapNum}>{money(element.committedIqd)}</td>
                        <td className={s.sapNum}>{money(element.actualIqd)}</td>
                        <td className={s.sapNum}>{money(element.availableIqd)}</td>
                        <td>
                          <Pill label={x(`availability_${element.availability}`)} on={element.availability === 'ok' ? true : element.availability === 'stop' ? false : null} />
                        </td>
                        <td>
                          <Pill label={element.active ? t('active') : x('inactive')} on={element.active} />
                        </td>
                        {mayEdit ? (
                          <td>
                            <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_element', { code: element.code })}>
                              {elementForm(updateWbsElement, element, [])}
                              {element.level > 1 ? (
                                <Form action={setWbsElementActive}>
                                  <Hidden name="project_code" value={view.project.code} />
                                  <Hidden name="back" value="wbs" />
                                  <Hidden name="wbs_code" value={element.code} />
                                  <Hidden name="active" value={element.active ? '0' : '1'} />
                                  <p className={s.sapNote}>{element.active ? x('deactivate_note') : x('activate_note')}</p>
                                  {element.active ? <Field label={t('reason')} name="reason" required wide /> : null}
                                  <SubmitRow>
                                    <Submit label={element.active ? t('deactivate') : x('activate')} tone="secondary" />
                                  </SubmitRow>
                                </Form>
                              ) : null}
                            </NewRecordDialog>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className={s.sapNote}>{x('no_projects')}</p>
          )}
        </div>
      </section>
    </AdminPage>
  );
}
