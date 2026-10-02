import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, ReadOnlyField, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { matching, pickOne, pickOutcome } from '@domain/pick';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as pb from '@/server/services/project-budget';
import * as ps from '@/server/services/project-system';
import { raiseChangeOrder } from '../actions';

/**
 * Raising a change order — REQ-PM-001 §7. Copies the Sales Return's new
 * page: the project first, then what the change does — its scope, the
 * contract value it moves (a customer project), the schedule it moves, and
 * the budget it moves element by element in the same grid the budget
 * documents use. Approved twice by other people, it raises its supplement.
 */
export const dynamic = 'force-dynamic';

export default async function NewChangeOrderPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/change-orders')) notFound();
  const [t, x, page, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  if (!can(context.principal, 'create', pb.PERMISSION_OBJECT)) {
    return <Denied object={page('change_orders')} />;
  }
  const typedProject = typeof params.project === 'string' ? params.project : '';
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);

  const { projects, picked, summary, codes, previous } = await withCurrentUser(async (tx) => {
    const all = (await ps.list(tx, { pageSize: 100 })).rows.filter((p) => p.status === 'active' || p.status === 'on_hold');
    const picked = pickOne(all, typedProject, (p) => p.code, (p) => [p.code, p.name, p.customerName]);
    return {
      projects: all,
      picked,
      summary: picked ? await pb.budgetSummary(tx, picked.code) : [],
      codes: (await ps.costCodes(tx)).filter((c) => c.active),
      previous: picked ? (await pb.changeOrders(tx, { projectCode: picked.code, pageSize: 100 })).rows.filter((v) => v.status === 'approved') : [],
    };
  });
  const pick = pickOutcome(projects, typedProject, (p) => p.code, (p) => [p.code, p.name, p.customerName]);
  const suggestions = matching(projects, typedProject, (p) => [p.code, p.name, p.customerName]);
  const today = businessToday();
  const rows = summary.filter((e) => e.isPlanning && e.active);
  const costName = (c: (typeof codes)[number]) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);

  return (
    <AdminPage back={{ href: '/projects/change-orders', label: t('back') }} trail={[{ href: '/', label: t('dashboard_label') }]} tabs={<SectionTabs route="/projects/change-orders" />} subtitle={x('new_change_order_subtitle')} title={x('new_change_order')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {projects.length === 0 ? (
        <p className={s.sectionHint}>{x('no_released_projects')}</p>
      ) : (
        <>
          <form className={s.pickRow} method="get">
            <div className={s.field}>
              <span className={s.label}>{x('project')}</span>
              <span className={s.fieldWithAction}>
                <input className={s.input} defaultValue={typedProject} list="co-projects" name="project" placeholder={x('project_hint')} required />
                <Submit label={t('choose')} tone="secondary" variant="document" />
              </span>
              <datalist id="co-projects">
                {suggestions.map((p) => (
                  <option key={p.code} value={p.code}>
                    {`${p.name}${p.customerName ? ` · ${p.customerName}` : ''}`}
                  </option>
                ))}
              </datalist>
              <span className={s.hint}>{pick === 'ambiguous' ? x('project_ambiguous') : pick === 'none' ? x('project_unknown') : x('pick_project')}</span>
            </div>
          </form>

          {!picked ? null : (
            <Form action={raiseChangeOrder}>
              <Hidden name="project_code" value={picked.code} />
              <Grid>
                <ReadOnlyField label={column('code')} value={<bdi dir="ltr">{picked.code}</bdi>} />
                <ReadOnlyField label={column('name')} value={<bdi dir="auto">{picked.name}</bdi>} />
                <Field defaultValue={today} label={column('date')} name="raised_on" required requiredLabel={t('required_hint')} type="date" />
                <Field label={column('description')} name="description" required requiredLabel={t('required_hint')} wide />
                {picked.kind === 'customer' ? <Field hint={x('contract_delta_hint')} label={x('contract_delta')} name="contract_delta_iqd" /> : null}
                <Field hint={x('schedule_delta_hint')} label={x('schedule_delta_days')} name="schedule_delta_days" />
                <Field hint={x('revised_ends_on_hint')} label={x('revised_ends_on')} name="revised_ends_on" type="date" />
                {previous.length > 0 ? (
                  <label className={s.field}>
                    <span className={s.label}>{x('supersedes')}</span>
                    <select className={s.select} name="supersedes_no">
                      <option value="" />
                      {previous.map((v) => (
                        <option key={v.variationNo} value={v.variationNo}>
                          {`${v.variationNo} · ${v.description}`}
                        </option>
                      ))}
                    </select>
                    <span className={s.hint}>{x('supersedes_hint')}</span>
                  </label>
                ) : null}
              </Grid>
              <Field hint={x('scope_note_hint')} label={x('scope_note')} name="scope_note" wide />

              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
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
                    {rows.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={2 + codes.length}>
                          {x('no_planning_elements')}
                        </td>
                      </tr>
                    ) : null}
                    {rows.map((element, row) => (
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
                            <input aria-label={`${costName(c)} ${element.wbsCode}`} className={s.sapCellField} inputMode="decimal" name={`amount_${row}_${c.code}`} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={s.sapNote}>{x('change_order_lines_note')}</p>

              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          )}
        </>
      )}
    </AdminPage>
  );
}
