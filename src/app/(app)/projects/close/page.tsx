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
import * as closing from '@/server/services/project-close';
import * as ps from '@/server/services/project-system';
import { chipOf } from '../chip';
import { cancelSettlement, closeProject, draftSettlement, postSettlement, technicallyComplete } from './actions';

/**
 * Close — REQ-PM-001 §12, §13. Copies the Progress workspace: one window
 * with the project as its filter and the close checklist as its register
 * (Phase 11's five blockers and PM-6's five); the settlement — what it would
 * move today and the documents — stacked underneath. Technical completion,
 * the settlement draft and the close are the header's actions.
 */
export const dynamic = 'force-dynamic';

export default async function ClosePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/close')) notFound();
  const [t, x, page, column, status, action, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('action'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', closing.PERMISSION_OBJECT)) {
    return <Denied object={page('project_close')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const today = businessToday();
  const actor = { principal, branchCode: context.scope.branchCode };

  const data = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = asked || choices.find((c) => c.status === 'closing')?.code || choices.find((c) => c.status === 'active')?.code || choices[0]?.code || '';
    const empty = { choices, view: null, checks: [], figures: null, settlements: [] };
    if (!code) return empty;
    try {
      const view = await ps.record(tx, actor, code);
      return {
        choices,
        view,
        checks: await closing.closeChecks(tx, code),
        figures: view.project.status === 'closing' ? await closing.settlementFigures(tx, code, today) : null,
        settlements: await closing.settlements(tx, code),
      };
    } catch (error) {
      if (isNotFoundError(error)) return empty;
      throw error;
    }
  });
  const { choices, view, checks, figures, settlements } = data;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const iqd = (value: bigint) => money(toDecimalString(value, 4n));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const status_ = view?.project.status ?? '';
  const mayApprove = can(principal, 'approve', closing.PERMISSION_OBJECT);
  const mayDraft = status_ === 'closing' && can(principal, 'create', closing.PERMISSION_OBJECT) && !settlements.some((d) => d.status !== 'cancelled');
  const mayClose = status_ === 'closing' && mayApprove && checks.length > 0 && checks.every((c) => c.passed);
  const failing = checks.filter((c) => !c.passed).length;

  return (
    <AdminPage
      actions={
        view ? (
          <>
            {status_ === 'active' && mayApprove ? (
              <NewRecordDialog buttonLabel={x('technical_complete')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('technical_complete_title')}>
                <Form action={technicallyComplete}>
                  <Hidden name="project_code" value={view.project.code} />
                  <Field label={x('note')} name="note" wide />
                  <p className={s.sapNote}>{x('technical_complete_note')}</p>
                  <SubmitRow>
                    <Submit label={x('technical_complete')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayDraft ? (
              <NewRecordDialog buttonLabel={x('draft_settlement')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('draft_settlement_title')}>
                <Form action={draftSettlement}>
                  <Hidden name="project_code" value={view.project.code} />
                  <Grid>
                    <Field defaultValue={today} label={x('settled_on')} name="settled_on" required type="date" />
                    <Field label={x('note')} name="note" wide />
                  </Grid>
                  <p className={s.sapNote}>{x(view.type?.kind === 'investment' ? 'settlement_asset_note' : 'settlement_result_note')}</p>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayClose ? (
              <NewRecordDialog buttonLabel={x('close_project')} closeLabel={t('close')} title={x('close_project_title')}>
                <Form action={closeProject}>
                  <Hidden name="project_code" value={view.project.code} />
                  <Field label={x('note')} name="note" required wide />
                  <p className={s.sapNote}>{x('close_project_note')}</p>
                  <SubmitRow>
                    <Submit label={x('close_project')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/close" />}
      subtitle={x('close_subtitle')}
      title={page('project_close')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="close-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="close-title">
            <span>{view ? `${view.project.code} · ${view.project.name}` : page('project_close')}</span>
            <span className={s.sapTitleMeta}>{view ? x('close_checks_meta', { count: failing }) : ''}</span>
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
                {' · '}
                {x(`kind_of_${view.type?.kind ?? 'customer'}`)}
              </p>
              <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
                <table aria-labelledby="close-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                  <thead>
                    <tr>
                      <th scope="col">{x('close_check')}</th>
                      <th scope="col">{column('status')}</th>
                      <th scope="col">{x('close_check_detail')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.code}>
                        <td>{x(`close_check_${c.code}`)}</td>
                        <td>
                          <span className={`status status--${c.passed ? 'approved' : 'rejected'} ${s.sapRegisterStatus}`} data-status={c.passed ? 'approved' : 'rejected'}>
                            {c.passed ? x('check_passed') : x('check_open')}
                          </span>
                        </td>
                        <td>
                          <bdi dir="auto">{c.detail || '—'}</bdi>
                        </td>
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

      {view && figures ? (
        <section aria-labelledby="close-figures-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="close-figures-title">
              <span>{x('settlement_preview')}</span>
              <span className={s.sapTitleMeta}>{x('to_period_end', { day: day(today) })}</span>
            </h2>
            <p className={s.sapNote}>{x(figures.kind === 'asset' ? 'settlement_asset_note' : 'settlement_result_note')}</p>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="close-figures-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('settlement_kind')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('cost_unsettled')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('cost_in_ledger')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('billed_to_date')}
                    </th>
                    <th scope="col">{x('open_recognition')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{x(`settlement_kind_${figures.kind}`)}</td>
                    <td className={s.sapNum}>{iqd(figures.costIqd)}</td>
                    <td className={s.sapNum}>{iqd(figures.glCostIqd)}</td>
                    <td className={s.sapNum}>{iqd(figures.billedIqd)}</td>
                    <td>
                      <bdi dir="ltr">{figures.openRecognition ? `${day(figures.openRecognition.periodEnd)} · ${iqd(figures.openRecognition.adjustmentIqd)}` : '—'}</bdi>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            {figures.kind === 'asset' && figures.byAccount.length > 0 ? (
              <div className={s.sapTableWrap}>
                <table aria-label={x('settlement_accounts')} className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{column('account')}</th>
                      <th scope="col">{x('department')}</th>
                      <th className={s.sapNum} scope="col">
                        {x('settled_amount')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {figures.byAccount.map((a) => (
                      <tr key={`${a.accountId}:${a.departmentCode ?? ''}:${a.businessLineCode ?? ''}`}>
                        <td>
                          <bdi dir="ltr">{a.accountCode}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{a.departmentCode ?? '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>{iqd(a.amountIqd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {view ? (
        <section aria-labelledby="close-settlements-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="close-settlements-title">
              <span>{x('settlements')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: settlements.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="close-settlements-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('document_no')}</th>
                    <th scope="col">{x('settled_on')}</th>
                    <th scope="col">{x('settlement_kind')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('cost_in_ledger')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('billed_to_date')}
                    </th>
                    <th scope="col">{column('status')}</th>
                    <th scope="col">{x('journal')}</th>
                    <th scope="col">{x('raised_by')}</th>
                    <th scope="col">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={9}>
                        {x('no_settlements')}
                      </td>
                    </tr>
                  ) : null}
                  {settlements.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <bdi dir="ltr">{d.settlementNo}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(d.settledOn)}</bdi>
                      </td>
                      <td>{x(`settlement_kind_${d.kind}`)}</td>
                      <td className={s.sapNum}>{money(d.glCostIqd)}</td>
                      <td className={s.sapNum}>{money(d.billedIqd)}</td>
                      <td>
                        <span className={`status status--${d.status} ${s.sapRegisterStatus}`} data-status={d.status}>
                          {status(d.status)}
                        </span>
                      </td>
                      <td>
                        <bdi dir="ltr">{[d.entryNo, d.recognitionEntryNo].filter(Boolean).join(' · ') || '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{d.createdByName ?? '—'}</bdi>
                      </td>
                      <td>
                        {d.status === 'draft' && mayApprove && d.createdBy !== principal.userId ? (
                          <Form action={postSettlement}>
                            <Hidden name="project_code" value={view.project.code} />
                            <Hidden name="settlement_no" value={d.settlementNo} />
                            <Submit label={action('post')} small tone="secondary" />
                          </Form>
                        ) : null}
                        {d.status === 'draft' && can(principal, 'edit_draft', closing.PERMISSION_OBJECT) ? (
                          <Form action={cancelSettlement}>
                            <Hidden name="project_code" value={view.project.code} />
                            <Hidden name="settlement_no" value={d.settlementNo} />
                            <input aria-label={t('reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                            <Submit label={action('cancel')} small tone="secondary" />
                          </Form>
                        ) : null}
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
