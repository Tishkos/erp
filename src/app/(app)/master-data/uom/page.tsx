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
import { AutoCode } from '@/components/admin/auto-code';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as uom from '@/server/services/units-of-measure';
import { createUom } from './actions';

/**
 * Units of measure — the vocabulary items state their quantities in.
 *
 * Small, and load-bearing: PCS, PC and PIECE typed freehand into three item
 * records is three units as far as any later report is concerned.
 */
export const dynamic = 'force-dynamic';

export default async function UomPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/uom')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', uom.PERMISSION_OBJECT)) {
    return <Denied object={page('md_uom')} />;
  }
  const mayCreate = can(principal, 'create', uom.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => uom.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('uom.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('uom.new')}
          >
            <p className="muted">{t('uom.created_note')}</p>
            <AutoCode codeId="f-code" mode="upper" nameId="f-name" />
            <Form action={createUom}>
              <Grid>
                <Field hint={t('code_auto_hint')} label={t('code')} name="code" />
                <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/uom" />}
      subtitle={t('uom.subtitle')}
      title={page('md_uom')}
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
          clearHref="/inventory/uom"
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
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={3}>{t('uom.none')}</td>
                </tr>
              ) : null}
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/inventory/uom/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
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
