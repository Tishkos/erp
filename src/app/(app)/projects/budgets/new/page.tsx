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
import { createBudgetDocument } from '../actions';

/**
 * Raising a budget document — REQ-PM-001 §7. Copies the Sales Return's new
 * page: the project is named first, and everything else is read from it —
 * the planning elements as the rows and the cost codes as the columns, one
 * amount per cell. An original adds, a supplement adds, a return takes
 * (typed as a positive figure, taken as a negative one), a transfer gives
 * from one element and receives on another.
 */
export const dynamic = 'force-dynamic';

const KINDS = ['original', 'supplement', 'return', 'transfer'] as const;

export default async function NewBudgetPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/budgets')) notFound();
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
    return <Denied object={page('project_budgets')} />;
  }
  const typedProject = typeof params.project === 'string' ? params.project : '';
  const kind = typeof params.kind === 'string' && (KINDS as readonly string[]).includes(params.kind) ? params.kind : 'original';
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);

  const { projects, picked, summary, codes, hasOriginal } = await withCurrentUser(async (tx) => {
    const all = (await ps.list(tx, { pageSize: 100 })).rows.filter((p) => p.status !== 'closed');
    const picked = pickOne(all, typedProject, (p) => p.code, (p) => [p.code, p.name, p.customerName]);
    return {
      projects: all,
      picked,
      summary: picked ? await pb.budgetSummary(tx, picked.code) : [],
      codes: (await ps.costCodes(tx)).filter((c) => c.active),
      hasOriginal: picked ? await pb.hasBudgetDocuments(tx, picked.code, 'original') : false,
    };
  });
  const pick = pickOutcome(projects, typedProject, (p) => p.code, (p) => [p.code, p.name, p.customerName]);
  const suggestions = matching(projects, typedProject, (p) => [p.code, p.name, p.customerName]);
  const today = businessToday();
  const rows = summary.filter((e) => e.isPlanning && e.active);
  const costName = (c: (typeof codes)[number]) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);

  return (
    <AdminPage back={{ href: '/projects/budgets', label: t('back') }} trail={[{ href: '/', label: t('dashboard_label') }]} tabs={<SectionTabs route="/projects/budgets" />} subtitle={x('new_budget_subtitle')} title={x('new_budget')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {projects.length === 0 ? (
        <p className={s.sectionHint}>{x('no_projects')}</p>
      ) : (
        <>
          <form className={s.pickRow} method="get">
            <div className={s.field}>
              <span className={s.label}>{x('project')}</span>
              <span className={s.fieldWithAction}>
                <input className={s.input} defaultValue={typedProject} list="budget-projects" name="project" placeholder={x('project_hint')} required />
                <Submit label={t('choose')} tone="secondary" variant="document" />
              </span>
              <datalist id="budget-projects">
                {suggestions.map((p) => (
                  <option key={p.code} value={p.code}>
                    {`${p.name}${p.customerName ? ` · ${p.customerName}` : ''}`}
                  </option>
                ))}
              </datalist>
              <span className={s.hint}>{pick === 'ambiguous' ? x('project_ambiguous') : pick === 'none' ? x('project_unknown') : x('pick_project')}</span>
            </div>
            <label className={s.field}>
              <span className={s.label}>{x('kind')}</span>
              <select className={s.select} defaultValue={kind} name="kind">
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {x(`kind_${value}`)}
                  </option>
                ))}
              </select>
              <span className={s.hint}>{x(`kind_${kind}_hint`)}</span>
            </label>
          </form>

          {!picked ? null : kind === 'original' && hasOriginal ? (
            <p className={s.sapNote}>{x('has_original', { code: picked.code })}</p>
          ) : (
            <Form action={createBudgetDocument}>
              <Hidden name="project_code" value={picked.code} />
              <Hidden name="kind" value={kind} />
              <Grid>
                <ReadOnlyField label={column('code')} value={<bdi dir="ltr">{picked.code}</bdi>} />
                <ReadOnlyField label={column('name')} value={<bdi dir="auto">{picked.name}</bdi>} />
                <ReadOnlyField label={x('kind')} value={x(`kind_${kind}`)} />
                <Field defaultValue={today} label={column('date')} name="raised_on" required requiredLabel={t('required_hint')} type="date" />
                <Field label={column('description')} name="description" required requiredLabel={t('required_hint')} wide />
              </Grid>

              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{x('element')}</th>
                      <th className={s.sapNum} scope="col">
                        {x('current_budget')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('available')}
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
                        <td className={s.sapEmptyRow} colSpan={3 + codes.length}>
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
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(element.availableIqd)}</bdi>
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
              <p className={s.sapNote}>{x(`kind_${kind}_lines`)}</p>

              {rows.length > 0 ? (
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              ) : null}
            </Form>
          )}
        </>
      )}
    </AdminPage>
  );
}
