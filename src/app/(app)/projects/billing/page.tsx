import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { toDecimalString } from '@/server/domain/money';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as billing from '@/server/services/project-billing';
import * as psch from '@/server/services/project-schedule';
import * as ps from '@/server/services/project-system';
import { chipOf } from '../chip';
import { addBillingLine, cancelBillingLine, certifyProgress, raiseCertificate, runRecognition } from './actions';

/**
 * Billing — REQ-PM-001 §11, §13. Copies the Progress workspace: one window
 * with the customer project and the period end as filters and the billing
 * plan as its register; then the certificates, the contract's balances and
 * the period's revenue recognition stacked underneath.
 */
export const dynamic = 'force-dynamic';

const LINE_CHIP: Record<string, string> = {
  planned: 'draft',
  due: 'open',
  billed: 'posted',
  cancelled: 'cancelled',
};

/** The last day of the month before today's — the period month-end is about. */
function lastMonthEnd(today: string): string {
  const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export default async function BillingPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/billing')) notFound();
  const [t, x, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', billing.PERMISSION_OBJECT)) {
    return <Denied object={page('project_billing')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const today = businessToday();
  const periodEnd = typeof params.period_end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.period_end) ? params.period_end : lastMonthEnd(today);
  const actor = { principal, branchCode: context.scope.branchCode };

  const data = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows.filter((c) => c.kind === 'customer');
    const policy = await billing.policy(tx);
    const code = asked || choices.find((c) => c.status === 'active')?.code || choices[0]?.code || '';
    const empty = {
      choices,
      policy,
      view: null,
      lines: [],
      certificates: [],
      balances: null,
      figures: null,
      history: [],
      milestones: [],
    };
    if (!code) return empty;
    try {
      const view = await ps.record(tx, actor, code);
      if (view.type?.kind !== 'customer') return empty;
      const plan = await psch.activities(tx, code);
      return {
        choices,
        policy,
        view,
        lines: await billing.planLines(tx, code),
        certificates: (await billing.certificates(tx, { projectCode: code })).rows,
        balances: await billing.balances(tx, code),
        figures: view.project.status === 'draft' ? null : await billing.recognitionFigures(tx, code, periodEnd),
        history: await billing.recognitionHistory(tx, code),
        milestones: plan.activities.filter((a) => a.kind === 'milestone' && a.milestoneUsage === 'billing' && a.status !== 'cancelled'),
      };
    } catch (error) {
      if (isNotFoundError(error)) return empty;
      throw error;
    }
  });
  const { choices, policy, view, lines, certificates, balances, figures, history, milestones } = data;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const iqd = (value: bigint) => money(toDecimalString(value, 4n));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const open = Boolean(view) && view!.project.status !== 'closed';
  const mayEdit = open && can(principal, 'edit_draft', billing.PERMISSION_OBJECT);
  const mayRaise = Boolean(view) && view!.project.status === 'active' && can(principal, 'create', billing.PERMISSION_OBJECT);
  const mayPost = can(principal, 'post', billing.PERMISSION_OBJECT);
  const ran = history.some((h) => h.periodEnd === periodEnd);
  const keep = (
    <>
      <Hidden name="project_code" value={view?.project.code ?? ''} />
      <Hidden name="period_end" value={periodEnd} />
    </>
  );

  return (
    <AdminPage
      actions={
        mayEdit && view ? (
          <>
            <NewRecordDialog buttonLabel={x('add_billing_line')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('add_billing_line_title')}>
              <Form action={addBillingLine}>
                {keep}
                <Grid>
                  <Select
                    label={x('element')}
                    name="wbs_code"
                    options={view.tree
                      .filter((e) => e.active && e.isBilling)
                      .map((e) => ({
                        value: e.code,
                        label: `${e.code} · ${e.name}`,
                      }))}
                    required
                  />
                  <Field label={column('description')} name="description" required wide />
                  <Select
                    label={x('due_trigger')}
                    name="due_trigger"
                    options={[
                      { value: 'milestone', label: x('due_on_milestone') },
                      { value: 'date', label: x('due_on_date') },
                    ]}
                    required
                  />
                  <Select
                    emptyLabel="—"
                    label={x('billing_milestone_activity')}
                    name="activity_code"
                    options={milestones.map((m) => ({
                      value: m.code,
                      label: `${m.code} · ${m.name}`,
                    }))}
                  />
                  <Field label={x('due_on')} name="due_on" type="date" />
                  <Select
                    label={x('billing_basis')}
                    name="basis"
                    options={[
                      { value: 'percent', label: x('basis_percent') },
                      { value: 'amount', label: x('basis_amount') },
                    ]}
                    required
                  />
                  <Field hint={x('billing_value_hint')} label={x('billing_value')} name="value" required />
                </Grid>
                <p className={s.sapNote}>{x('billing_line_note')}</p>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
            {mayRaise ? (
              <NewRecordDialog buttonLabel={x('certify_progress')} closeLabel={t('close')} title={x('certify_progress_title')}>
                <Form action={certifyProgress}>
                  {keep}
                  <Grid>
                    <Field defaultValue={today} label={x('certified_on')} name="certified_on" required type="date" />
                    <Field hint={x('certify_percent_hint')} label={x('percent_complete')} name="percent_complete" required />
                  </Grid>
                  <p className={s.sapNote}>{x('certify_progress_note')}</p>
                  <SubmitRow>
                    <Submit label={x('raise_certificate')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/billing" />}
      subtitle={x('billing_subtitle')}
      title={page('project_billing')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="billing-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="billing-title">
            <span>{view ? `${view.project.code} · ${view.project.name}` : page('project_billing')}</span>
            <span className={s.sapTitleMeta}>{x('billing_plan')}</span>
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
              <Field defaultValue={periodEnd} label={x('period_end')} name="period_end" type="date" />
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
                {view.customer ? (
                  <>
                    {' · '}
                    <bdi dir="ltr">{view.customer.code}</bdi> <bdi dir="auto">{view.customer.name}</bdi>
                  </>
                ) : null}
              </p>
              <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
                <table aria-labelledby="billing-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">{x('element')}</th>
                      <th scope="col">{column('description')}</th>
                      <th scope="col">{x('due_trigger')}</th>
                      <th scope="col">{x('billing_basis')}</th>
                      <th className={s.sapNum} scope="col">
                        {x('gross')}
                      </th>
                      <th scope="col">{x('due_since')}</th>
                      <th scope="col">{column('status')}</th>
                      <th scope="col">{x('certificate')}</th>
                      {mayEdit || mayRaise ? <th scope="col">{t('actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={mayEdit || mayRaise ? 10 : 9}>
                          {x('no_billing_lines')}
                        </td>
                      </tr>
                    ) : null}
                    {lines.map((l) => (
                      <tr key={l.lineNo}>
                        <td>{l.lineNo}</td>
                        <td>
                          <bdi dir="ltr">{l.wbsCode}</bdi> <bdi dir="auto">{l.elementName ?? ''}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{l.description}</bdi>
                        </td>
                        <td>
                          {l.dueTrigger === 'milestone' ? (
                            <>
                              <bdi dir="ltr">{l.activityCode}</bdi> <bdi dir="auto">{l.activityName ?? ''}</bdi>
                            </>
                          ) : (
                            <bdi dir="ltr">{day(l.dueOn)}</bdi>
                          )}
                        </td>
                        <td>{l.basis === 'percent' ? `${Number(l.percentOfContract)} %` : x('basis_amount')}</td>
                        <td className={s.sapNum}>{money(l.grossIqd)}</td>
                        <td>
                          <bdi dir="ltr">{day(l.dueSince)}</bdi>
                        </td>
                        <td>
                          <span className={`status status--${LINE_CHIP[l.state]} ${s.sapRegisterStatus}`} data-status={LINE_CHIP[l.state]}>
                            {x(`line_${l.state}`)}
                          </span>
                        </td>
                        <td>
                          {l.certificateNo ? (
                            <Link className={s.sapLink} href={`/projects/billing/${encodeURIComponent(l.certificateNo)}`}>
                              <bdi dir="ltr">{l.certificateNo}</bdi>
                            </Link>
                          ) : (
                            '—'
                          )}
                        </td>
                        {mayEdit || mayRaise ? (
                          <td>
                            {l.state === 'due' && mayRaise ? (
                              <Form action={raiseCertificate}>
                                {keep}
                                <Hidden name="line_no" value={String(l.lineNo)} />
                                <input aria-label={x('certified_on')} defaultValue={today} name="certified_on" required type="date" />
                                <Submit label={x('raise_certificate')} small tone="secondary" />
                              </Form>
                            ) : null}
                            {(l.state === 'planned' || l.state === 'due') && mayEdit ? (
                              <Form action={cancelBillingLine}>
                                {keep}
                                <Hidden name="line_no" value={String(l.lineNo)} />
                                <input aria-label={t('reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                                <Submit label={x('cancel_line')} small tone="secondary" />
                              </Form>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className={s.sapNote}>{x('no_customer_projects')}</p>
          )}
        </div>
      </section>

      {view ? (
        <section aria-labelledby="billing-certificates-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="billing-certificates-title">
              <span>{x('certificates')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: certificates.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="billing-certificates-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('certificate')}</th>
                    <th scope="col">{x('certified_on')}</th>
                    <th scope="col">{x('certificate_basis')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('percent_complete')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('gross')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('retention')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('advance_recovered')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('net')}
                    </th>
                    <th scope="col">{column('status')}</th>
                    <th scope="col">{x('journal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {certificates.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={10}>
                        {x('no_certificates')}
                      </td>
                    </tr>
                  ) : null}
                  {certificates.map((c) => (
                    <tr key={c.certificateNo}>
                      <td>
                        <Link className={s.sapLink} href={`/projects/billing/${encodeURIComponent(c.certificateNo)}`}>
                          <bdi dir="ltr">{c.certificateNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(c.certifiedOn)}</bdi>
                      </td>
                      <td>{x(`basis_${c.basis}`)}</td>
                      <td className={s.sapNum}>{`${Number(c.percentComplete)} %`}</td>
                      <td className={s.sapNum}>{money(c.grossIqd)}</td>
                      <td className={s.sapNum}>{money(c.retentionIqd)}</td>
                      <td className={s.sapNum}>{money(c.advanceRecoveredIqd)}</td>
                      <td className={s.sapNum}>{money(c.netIqd)}</td>
                      <td>
                        <span className={`status status--${c.status} ${s.sapRegisterStatus}`} data-status={c.status}>
                          {status(c.status)}
                        </span>
                      </td>
                      <td>
                        <bdi dir="ltr">{c.entryNo ?? '—'}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {view && balances ? (
        <section aria-labelledby="billing-balances-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="billing-balances-title">
              <span>{x('contract_balances')}</span>
              <span className={s.sapTitleMeta}>{x('balances_note')}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="billing-balances-title" className={s.sapTable}>
                <thead>
                  <tr>
                    {(['contract_value_revised', 'certified_total', 'billed_total', 'retention_held', 'advance_outstanding'] as const).map((key) => (
                      <th className={s.sapNum} key={key} scope="col">
                        {x(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {[balances.contractIqd, balances.certifiedIqd, balances.billedIqd, balances.retentionHeldIqd, balances.advanceOutstandingIqd].map((value, index) => (
                      <td className={s.sapNum} key={index}>
                        {money(value)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {view ? (
        <section aria-labelledby="billing-recognition-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="billing-recognition-title">
              <span>{x('revenue_recognition')}</span>
              <span className={s.sapTitleMeta}>{x('to_period_end', { day: day(periodEnd) })}</span>
            </h2>
            <p className={s.sapNote}>
              {policy.ratified
                ? x('recognition_ratified', {
                    by: policy.ratifiedByName ?? '—',
                    note: policy.ratifiedNote ?? '',
                  })
                : x('recognition_not_ratified')}
            </p>
            {figures?.onerous ? <p className={s.sapNote}>{x('recognition_onerous')}</p> : null}
            {figures ? (
              <div className={s.sapTableWrap}>
                <table aria-labelledby="billing-recognition-title" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th className={s.sapNum} scope="col">
                        {x('contract_value_revised')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('acwp')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('eac')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('percent_by_cost')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('recognised_to_date')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('billed_to_date')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {figures.adjustmentIqd >= 0n ? x('adjustment_to_wip') : x('adjustment_to_deferred')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className={s.sapNum}>{iqd(figures.contractIqd)}</td>
                      <td className={s.sapNum}>{iqd(figures.actualIqd)}</td>
                      <td className={s.sapNum}>{iqd(figures.eacIqd)}</td>
                      <td className={s.sapNum}>{`${Number(toDecimalString(figures.percent, 4n))} %`}</td>
                      <td className={s.sapNum}>{iqd(figures.recognisedIqd)}</td>
                      <td className={s.sapNum}>{iqd(figures.billedIqd)}</td>
                      <td className={s.sapNum}>{iqd(figures.adjustmentIqd < 0n ? -figures.adjustmentIqd : figures.adjustmentIqd)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={s.sapNote}>{x('recognition_after_release')}</p>
            )}
            {figures && policy.ratified && mayPost && !ran && ['active', 'on_hold', 'closing'].includes(view.project.status) ? (
              <Form action={runRecognition}>
                {keep}
                <SubmitRow>
                  <Submit label={x('run_recognition')} />
                </SubmitRow>
              </Form>
            ) : null}
            <div className={s.sapTableWrap}>
              <table aria-label={x('recognition_history')} className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('period_end')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('percent_by_cost')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('recognised_to_date')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('billed_to_date')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('adjustment')}
                    </th>
                    <th scope="col">{x('journal')}</th>
                    <th scope="col">{x('reversed_on')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {x('no_recognition')}
                      </td>
                    </tr>
                  ) : null}
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <bdi dir="ltr">{day(h.periodEnd)}</bdi>
                      </td>
                      <td className={s.sapNum}>{`${Number(h.percentComplete)} %`}</td>
                      <td className={s.sapNum}>{money(h.recognisedIqd)}</td>
                      <td className={s.sapNum}>{money(h.billedIqd)}</td>
                      <td className={s.sapNum}>{money(h.adjustmentIqd)}</td>
                      <td>
                        <bdi dir="ltr">{h.entryNo ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{h.reversedOn ? `${day(h.reversedOn)} · ${h.reversalEntryNo ?? ''}` : '—'}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
