import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, KeyValue, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { LiveRefresh } from '@/components/admin/live-refresh';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import {
  INITIATION_KINDS,
  INITIATION_STAGES,
  INITIATION_STATUSES,
  guideNumber,
  initiationChip,
  LEAD_STAGES,
  isInitiationKind,
  isInitiationStage,
  stagesOf,
  type InitiationStage,
  type PipelinePhase,
  type InitiationStatus,
} from '@domain/project-initiation';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as initiation from '@/server/services/project-initiation';
import { createInitiation } from './actions';

/**
 * Leads and Opportunities (2026-10-21, by direction: "track each client
 * through Leads → Opportunities → Projects") — one register drawn twice over
 * the same Project Initiation records: **Leads** are the records at the first
 * stage of their road (`/projects/initiation`, where the Project Guide's
 * register always was), **Opportunities** the ones past it and not yet a
 * project (`/projects/opportunities`); once converted a record is a project
 * and lives on the Projects screen. The guide's Main Project Initiation
 * Selector is behind *New* on Leads: a Direct Sales project, a Tender project
 * or a Financed customer, each opened at the first stage of its road. Copies
 * the Purchase Invoices list: the search, the filters, the register, the
 * paging — and keeps itself live.
 */
const SCREEN_KEY: Readonly<Record<'lead' | 'opportunity', string>> = { lead: 'project_initiation', opportunity: 'project_opportunities' };

export async function InitiationRegister({
  searchParams,
  phase,
  route,
}: {
  readonly searchParams: SearchParams;
  readonly phase: Exclude<PipelinePhase, 'project'>;
  readonly route: string;
}) {
  const ROUTE = route;
  if (!visibleRoute(ROUTE)) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.project_initiation'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', initiation.PERMISSION_OBJECT)) {
    return <Denied object={page(SCREEN_KEY[phase])} />;
  }
  // New records are leads: they open at the first stage of their road.
  const mayCreate = phase === 'lead' && can(principal, 'create', initiation.PERMISSION_OBJECT);
  const params = await searchParams;
  const one = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '');
  const kindParam = isInitiationKind(one('kind')) ? one('kind') : '';
  const stageParam = isInitiationStage(one('stage')) ? one('stage') : '';
  const statusParam = (INITIATION_STATUSES as readonly string[]).includes(one('status')) ? one('status') : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;

  const { result, people, version } = await withCurrentUser(async (tx) => ({
    result: await initiation.list(tx, { phase, kind: kindParam || null, stage: stageParam || null, status: statusParam || null, search: outcome.q, page: pageNo }),
    people: mayCreate ? (await initiation.pickers(tx)).people : [],
    version: await initiation.liveVersion(tx),
  }));

  const money = (value: string | null) => (value ? formatMoney(value, 'IQD', locale as Locale) : '—');
  const stageLabel = (stage: string) => (isInitiationStage(stage) ? `${guideNumber(stage)} · ${x(`stage.${stage}`)}` : stage);
  const query = [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', kindParam ? `kind=${kindParam}` : '', stageParam ? `stage=${stageParam}` : '', statusParam ? `status=${statusParam}` : ''].filter(Boolean);
  const hrefFor = (p: number) => `${ROUTE}?${[...query, `page=${p}`].join('&')}`;
  // The stage filter offers the chosen workflow's stages of this phase, or all of them in the guide's order.
  const inPhase = (stage: InitiationStage) => (phase === 'lead') === LEAD_STAGES.includes(stage);
  const stageChoices: readonly InitiationStage[] = (kindParam && isInitiationKind(kindParam) ? stagesOf(kindParam) : INITIATION_STAGES).filter(inPhase);
  // A converted record is a project, on the Projects screen; here a record is open or lost.
  const statusChoices = INITIATION_STATUSES.filter((value) => value !== 'converted');

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new_title')}>
            <Form action={createInitiation}>
              <Grid>
                <Select label={x('kind')} name="kind" options={INITIATION_KINDS.map((kind) => ({ value: kind, label: x(`kind_option.${kind}`) }))} required />
                <Field label={x('title_field')} name="title" required wide />
                <Field hint={x('customer_name_hint')} label={x('customer_name')} name="customer_name" required wide />
                <Field hint={x('customer_phone_hint')} label={x('customer_phone')} name="customer_phone" />
                <Field label={x('customer_city')} name="customer_city" />
                <Select defaultValue={principal.userId} label={x('owner')} name="owner_user_id" options={people.map((person) => ({ value: person.id, label: person.name }))} required />
              </Grid>
              {/* The guide's own table: each type and what it is for. */}
              <KeyValue rows={INITIATION_KINDS.map((kind) => ({ label: x(`kind_option.${kind}`), value: x(`kind_about.${kind}`) }))} />
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={x(`subtitle_${phase}`)}
      tabs={<SectionTabs route={ROUTE} />}
      title={page(SCREEN_KEY[phase])}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="initiation-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="initiation-list-title">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span>{page(SCREEN_KEY[phase])}</span>
              <LiveRefresh endpoint="/projects/pipeline/version" label={x('live')} version={version} />
            </span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref={ROUTE}
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select defaultValue={kindParam} emptyLabel={x('kind_all')} label={x('kind')} name="kind" options={INITIATION_KINDS.map((kind) => ({ value: kind, label: x(`kind_option.${kind}`) }))} />
              <Select defaultValue={stageParam} emptyLabel={x('stage_all')} label={x('stage_field')} name="stage" options={stageChoices.map((stage) => ({ value: stage, label: stageLabel(stage) }))} />
              <Select
                defaultValue={statusParam}
                emptyLabel={x('status_all')}
                label={column('status')}
                name="status"
                options={statusChoices.map((status) => ({ value: status, label: x(`status.${status}`) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="initiation-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('number')}</th>
                  <th scope="col">{x('title_field')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{x('stage_field')}</th>
                  <th scope="col">{x('customer')}</th>
                  <th scope="col">{x('customer_city')}</th>
                  <th scope="col">{x('owner')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('value')}
                  </th>
                  <th scope="col">{x('last_update')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => {
                  const chip = initiationChip(row.status as InitiationStatus);
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link className={s.sapLink} href={`/projects/initiation/${encodeURIComponent(row.initiationNo)}`}>
                          <bdi dir="ltr">{row.initiationNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{row.title}</bdi>
                      </td>
                      <td>{x.has(`kind_option.${row.kind}`) ? x(`kind_option.${row.kind}`) : row.kind}</td>
                      <td>
                        <bdi dir="auto">{stageLabel(row.stage)}</bdi>
                      </td>
                      <td>
                        {row.customerCode ? <ProfileLink code={row.customerCode} dir="auto" kind="customer" name={row.customerName} /> : <bdi dir="auto">{row.customerName}</bdi>}
                      </td>
                      <td>
                        <bdi dir="auto">{row.customerCity ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{row.ownerName ?? '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(row.contractValueIqd ?? row.proposalValueIqd ?? row.bidPriceIqd)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{formatTimestamp(row.updatedAt.toISOString(), locale as Locale)}</bdi>
                      </td>
                      <td>
                        <span className={`status status--${chip} ${s.sapRegisterStatus}`} data-status={chip}>
                          {x.has(`status.${row.status}`) ? x(`status.${row.status}`) : row.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={hrefFor}
              labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
