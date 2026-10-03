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
import * as warehouses from '@/server/services/warehouses';
import { createWarehouse } from './actions';

/**
 * Warehouse Setup — Operations build, block 7.
 *
 *   Warehouse Setup   Warehouse Name; Warehouse Code.
 *
 * Two fields, because two are what was asked for. The branch is not on the form
 * and cannot be left out of the record, so it comes from whoever is making the
 * warehouse: a person sets one up where they work.
 *
 * Before this, a warehouse could only come into being as part of creating a
 * branch — so a company had exactly as many warehouses as branches, and every
 * screen that moves stock has to name one.
 */
export const dynamic = 'force-dynamic';

export default async function WarehousesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/warehouses')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', warehouses.PERMISSION_OBJECT)) {
    return <Denied object={page('warehouses')} />;
  }
  const mayCreate = can(principal, 'create', warehouses.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => warehouses.list(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('warehouses.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('warehouses.new')}
          >
            {/* No Code field: the system gives the warehouse its code when it
                is saved (Critical Rule 1). */}
            <p className="muted">{t('minted_code_note')}</p>
            <Form action={createWarehouse}>
              <Grid>
                <Field
                  label={column('warehouse_name')}
                  name="name"
                  required
                  requiredLabel={t('required_hint')}
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
      tabs={<SectionTabs route="/master-data/warehouses" />}
      subtitle={t('warehouses.subtitle')}
      title={page('warehouses')}
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
          clearHref="/master-data/warehouses"
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
                <th scope="col">{column('warehouse_code')}</th>
                <th scope="col">{column('warehouse_name')}</th>
                <th scope="col">{column('branch_code')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={4}>{t('warehouses.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/warehouses/${encodeURIComponent(row.code)}`}>
                      <bdi dir="ltr">{row.code}</bdi>
                    </Link>
                  </td>
                  <td>
                    <bdi dir="auto">{row.name}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.branchName ?? row.branchCode}</bdi>
                  </td>
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
