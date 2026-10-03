import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  ListToolbar,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  matches,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as costCentres from '@/server/services/cost-centres';
import * as users from '@/server/services/users';
import { createCostCentre } from './actions';

/** Cost centres — Phase 2 requirement 1. */
export const dynamic = 'force-dynamic';

export default async function CostCentresPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/cost-centres')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', costCentres.PERMISSION_OBJECT)) {
    return <Denied object={page('cost_centres')} />;
  }
  const mayCreate = can(principal, 'create', costCentres.PERMISSION_OBJECT);

  const { rows, people, places } = await withCurrentUser(async (tx) => ({
    rows: await costCentres.listAll(tx),
    people: mayCreate ? await users.listAll(tx) : [],
    places: mayCreate ? await branches.listAll(tx) : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('cost_centres.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('cost_centres.new')}
          >
            <p className="muted">{t('cost_centres.created_note')}</p>
            <p className="muted">{t('minted_code_note')}</p>
            <Form action={createCostCentre}>
              <Grid>
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                <Select
                  emptyLabel={t('cost_centres.no_owner')}
                  hint={t('cost_centres.owner_hint')}
                  label={t('cost_centres.owner')}
                  name="ownerUserId"
                  options={people
                    .filter((p) => p.isActive)
                    .map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))}
                />
                <Select
                  emptyLabel={t('cost_centres.company_wide')}
                  hint={t('cost_centres.branch_hint')}
                  label={column('branch_code')}
                  name="branchCode"
                  options={places
                    .filter((b) => b.active)
                    .map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))}
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/cost-centres" />}
      subtitle={t('cost_centres.subtitle')}
      title={page('cost_centres')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/master-data/cost-centres"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('code')}</th>
                <th scope="col">{column('name')}</th>
                <th scope="col">{t('cost_centres.owner')}</th>
                <th scope="col">{column('branch_code')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={5}>{t('cost_centres.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/cost-centres/${encodeURIComponent(row.code)}`}>
                      {row.code}
                    </Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.ownerName ?? t('none')}</td>
                  {/* A cost centre with no branch is company-wide, not unassigned. */}
                  <td>{row.branchCode ?? t('cost_centres.company_wide')}</td>
                  <td>
                    <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
