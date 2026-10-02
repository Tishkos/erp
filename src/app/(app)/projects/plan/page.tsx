import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, FilterRow, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { parseDecimal, toDecimalString } from '@/server/domain/money';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as pb from '@/server/services/project-budget';
import * as ps from '@/server/services/project-system';
import { chipOf } from '../chip';
import { createPlanVersion, setPlanLine, spreadPlan } from './actions';

/**
 * Cost Plan — REQ-PM-001 §7. Copies the WBS workspace: one window, a filter
 * row naming the project and the version, and the plan as the register —
 * one row per element and cost code, one column per month, the total at
 * the end. A plan is typed as a spread over months or one month at a time;
 * a re-plan is a new version that may start from the current one.
 */
export const dynamic = 'force-dynamic';

export default async function PlanPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/plan')) notFound();
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
  if (!can(principal, 'view', pb.PERMISSION_OBJECT)) {
    return <Denied object={page('cost_plan')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const askedVersion = typeof params.version === 'string' ? params.version : '';
  const actor = { principal, branchCode: context.scope.branchCode };

  const data = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = asked || choices.find((c) => c.status !== 'closed')?.code || choices[0]?.code || '';
    if (!code) return { choices, view: null, versions: [], plan: null, codes: [] };
    try {
      const view = await ps.record(tx, actor, code);
      const versions = await pb.planVersions(tx, code);
      const picked = askedVersion ? (versions.find((v) => v.version.id === askedVersion) ?? null) : null;
      const plan = await pb.planLines(tx, code, picked?.version.id ?? null);
      const codes = (await ps.costCodes(tx)).filter((c) => c.active);
      return { choices, view, versions, plan, codes };
    } catch (error) {
      if (isNotFoundError(error)) return { choices, view: null, versions: [], plan: null, codes: [] };
      throw error;
    }
  });
  const { choices, view, versions, plan, codes } = data;
  const money = (value: string | bigint) => formatMoney(typeof value === 'bigint' ? toDecimalString(value, 4n) : value, 'IQD', locale as Locale);
  const mayPlan = Boolean(view) && can(principal, 'edit_draft', pb.PERMISSION_OBJECT) && ['draft', 'active', 'on_hold'].includes(view!.project.status);
  const current = versions.find((v) => v.version.isCurrent) ?? null;
  const shown = plan?.version ?? null;
  const editable = mayPlan && shown !== null && current !== null && shown.id === current.version.id;
  const planningElements = view ? view.tree.filter((e) => e.isPlanning && e.active) : [];
  const costName = (c: { nameEn: string; nameAr: string | null }) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);
  const monthLabel = (month: string) =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${month}T00:00:00Z`));

  // The register: one row per element and cost code, in tree order.
  const rows = view
    ? view.tree.flatMap((element) =>
        [...new Set((plan?.lines ?? []).filter((l) => l.wbsCode === element.code).map((l) => l.costCode))].map((costCode) => {
          const cells = new Map((plan?.lines ?? []).filter((l) => l.wbsCode === element.code && l.costCode === costCode).map((l) => [l.period, l.amountIqd]));
          const total = [...cells.values()].reduce((sum, v) => sum + parseDecimal(v, 4n), 0n);
          return { element, costCode, cells, total };
        }),
      )
    : [];
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0n);
  const monthTotals = (plan?.months ?? []).map((m) => rows.reduce((sum, r) => sum + parseDecimal(r.cells.get(m) ?? '0', 4n), 0n));

  const lineFields = (
    <>
      <Select
        label={x('element')}
        name="wbs_code"
        options={planningElements.map((e) => ({
          value: e.code,
          label: `${e.code} · ${e.name}`,
        }))}
        required
      />
      <Select
        label={x('cost_code')}
        name="cost_code"
        options={codes.map((c) => ({
          value: c.code,
          label: `${c.code} · ${costName(c)}`,
        }))}
        required
      />
    </>
  );

  return (
    <AdminPage
      actions={
        mayPlan && view ? (
          <>
            <NewRecordDialog buttonLabel={x('new_version')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('new_version_title')}>
              <Form action={createPlanVersion}>
                <Hidden name="project_code" value={view.project.code} />
                <Grid>
                  <Field defaultValue={current ? '' : x('original_plan')} label={column('name')} name="name" required wide />
                </Grid>
                <Field label={x('note')} name="note" wide />
                {current ? (
                  <Checkbox
                    defaultChecked
                    label={x('copy_current', {
                      version: current.version.version,
                    })}
                    name="copy_current"
                    value="1"
                  />
                ) : null}
                <p className={s.sapNote}>{x('version_note')}</p>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
            {editable ? (
              <>
                <NewRecordDialog buttonLabel={x('spread')} closeLabel={t('close')} title={x('spread_title')}>
                  <Form action={spreadPlan}>
                    <Hidden name="project_code" value={view.project.code} />
                    <Grid>
                      {lineFields}
                      <Field defaultValue={view.project.forecastStartsOn ?? view.project.baselineStartsOn ?? ''} label={x('from_month')} name="from" required type="date" />
                      <Field defaultValue={view.project.forecastEndsOn ?? view.project.baselineEndsOn ?? ''} label={x('to_month')} name="to" required type="date" />
                      <Field label={x('total')} name="total_iqd" required />
                    </Grid>
                    <p className={s.sapNote}>{x('spread_note')}</p>
                    <SubmitRow>
                      <Submit label={t('save')} />
                    </SubmitRow>
                  </Form>
                </NewRecordDialog>
                <NewRecordDialog buttonLabel={x('set_month')} closeLabel={t('close')} title={x('set_month_title')}>
                  <Form action={setPlanLine}>
                    <Hidden name="project_code" value={view.project.code} />
                    <Grid>
                      {lineFields}
                      <Field label={x('month')} name="period" required type="date" />
                      <Field label={column('amount')} name="amount_iqd" required />
                    </Grid>
                    <p className={s.sapNote}>{x('set_month_note')}</p>
                    <SubmitRow>
                      <Submit label={t('save')} />
                    </SubmitRow>
                  </Form>
                </NewRecordDialog>
              </>
            ) : null}
          </>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/plan" />}
      subtitle={x('plan_subtitle')}
      title={page('cost_plan')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="plan-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="plan-title">
            <span>{view ? `${view.project.code} · ${view.project.name}` : page('cost_plan')}</span>
            {shown ? <span className={s.sapTitleMeta}>{x('version_n', { version: shown.version, name: shown.name })}</span> : null}
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view?.project.code ?? ''}
                label={x('project')}
                name="project"
                options={choices.map((c) => ({
                  value: c.code,
                  label: `${c.code} · ${c.name}`,
                }))}
                required
              />
              {versions.length > 0 ? (
                <Select
                  defaultValue={shown?.id ?? ''}
                  label={x('version')}
                  name="version"
                  options={versions.map((v) => ({
                    value: v.version.id,
                    label: `v${v.version.version} · ${v.version.name}${v.version.isCurrent ? ` · ${x('current')}` : ''}`,
                  }))}
                />
              ) : null}
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
                {shown && !shown.isCurrent ? ` · ${x('older_version')}` : null}
              </p>
              {shown === null ? (
                <p className={s.sapNote}>{x('no_plan_yet')}</p>
              ) : (
                <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
                  <table aria-labelledby="plan-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                    <thead>
                      <tr>
                        <th scope="col">{x('element')}</th>
                        <th scope="col">{x('cost_code')}</th>
                        {(plan?.months ?? []).map((m) => (
                          <th className={s.sapNum} key={m} scope="col">
                            {monthLabel(m)}
                          </th>
                        ))}
                        <th className={s.sapNum} scope="col">
                          {x('total')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td className={s.sapEmptyRow} colSpan={3 + (plan?.months.length ?? 0)}>
                            {x('no_plan_lines')}
                          </td>
                        </tr>
                      ) : null}
                      {rows.map((row) => (
                        <tr key={`${row.element.code}|${row.costCode}`}>
                          <td>
                            <bdi dir="ltr">{`${'· '.repeat(Math.max(0, row.element.level - 1))}${row.element.code}`}</bdi> <bdi dir="auto">{row.element.name}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">{row.costCode}</bdi>
                          </td>
                          {(plan?.months ?? []).map((m) => (
                            <td className={s.sapNum} key={m}>
                              {row.cells.has(m) ? money(row.cells.get(m)!) : '—'}
                            </td>
                          ))}
                          <td className={s.sapNum}>{money(row.total)}</td>
                        </tr>
                      ))}
                      {rows.length > 0 ? (
                        <tr>
                          <td colSpan={2}>{x('total')}</td>
                          {monthTotals.map((v, i) => (
                            <td className={s.sapNum} key={plan?.months[i]}>
                              {money(v)}
                            </td>
                          ))}
                          <td className={s.sapNum}>{money(grandTotal)}</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className={s.sapNote}>{x('no_projects')}</p>
          )}
        </div>
      </section>
    </AdminPage>
  );
}
