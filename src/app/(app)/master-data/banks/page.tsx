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
import * as banks from '@/server/services/banks';
import { createBank } from './actions';

/**
 * Banks — REQ-AP-001 §15.1.
 *
 * Mansour, Arab, NBI, Rafidain … a master, not a fixed list. A bank account
 * names its bank, a time limit may be set per bank, and (later stages) a PD is
 * registered with one and a loan is lent by one. Drawn exactly as Payment
 * Methods: the same list, the same dialog, the same record.
 */
export const dynamic = 'force-dynamic';

export default async function BanksPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/banks')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', banks.PERMISSION_OBJECT)) {
    return <Denied object={page('banks')} />;
  }
  const mayCreate = can(principal, 'create', banks.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => banks.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('banks.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('banks.new')}
          >
            <p className="muted">{t('banks.created_note')}</p>
            <p className="muted">{t('minted_code_note')}</p>
            <Form action={createBank}>
              <Grid>
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                <Field hint={t('banks.swift_hint')} label={t('banks.swift')} name="swiftBic" />
                <Field defaultValue="IQ" hint={t('banks.country_hint')} label={t('banks.country')} name="country" />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/banks" />}
      subtitle={t('banks.subtitle')}
      title={page('banks')}
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
          clearHref="/master-data/banks"
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
                <th scope="col">{t('banks.swift')}</th>
                <th scope="col">{t('banks.country')}</th>
                <th scope="col">{t('banks.accounts')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={6}>{t('banks.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/banks/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>
                    <bdi dir="auto">{row.name}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.swiftBic ?? t('none')}</bdi>
                  </td>
                  <td>{row.country}</td>
                  <td>{row.accounts}</td>
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
