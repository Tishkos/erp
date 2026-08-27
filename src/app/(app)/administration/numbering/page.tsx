import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Grid,
  Inline,
  Mono,
  Pill,
  Submit,
  SubmitRow,
  NewRecordDialog,
  ListToolbar,
  matches,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as series from '@/server/services/number-series';
import { createSeries } from './actions';

/** Numbering — Phase 0 requirement 9. */
export const dynamic = 'force-dynamic';

export default async function NumberingPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', series.PERMISSION_OBJECT)) {
    return <Denied object={page('numbering')} />;
  }
  const mayCreate = can(principal, 'create', series.PERMISSION_OBJECT);
  const rows = await withCurrentUser((tx) => series.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('numbering.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('numbering.new')}
          >
              <Form action={createSeries}>
                <Grid>
                  <Field hint={t('code_hint')} label={t('numbering.key')} name="key" required requiredLabel={t('required_hint')} />
                  <Field label={t('numbering.prefix')} maxLength={10} name="prefix" required requiredLabel={t('required_hint')} />
                  <Field
                    defaultValue="{PREFIX}-{SERIAL}"
                    hint={t('numbering.pattern_hint')}
                    label={t('numbering.pattern')}
                    name="pattern"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Field defaultValue={6} label={t('numbering.padding')} max={18} min={1} name="padding" required type="number" />
                </Grid>
                <Inline>
                  <Checkbox label={t('numbering.scope_branch')} name="scopeBranch" />
                  <Checkbox label={t('numbering.scope_year')} name="scopeYear" />
                </Inline>
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
              </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/administration/numbering" />}
      subtitle={t('numbering.subtitle')}
      title={t('numbering.title')}
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/administration/numbering"
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
                <th scope="col">{column('key')}</th>
                <th scope="col">{column('prefix')}</th>
                <th scope="col">{column('pattern')}</th>
                <th className="numeric" scope="col">
                  {column('padding')}
                </th>
                <th scope="col">{column('scope_branch')}</th>
                <th scope="col">{column('scope_year')}</th>
                <th className="numeric" scope="col">
                  {column('issued')}
                </th>
                <th scope="col">{column('last_number')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.key}>
                  <td>
                    <Link href={`/administration/numbering/${encodeURIComponent(row.key)}`}>{row.key}</Link>
                  </td>
                  <td>
                    <Mono>{row.prefix}</Mono>
                  </td>
                  <td>
                    <Mono>{row.pattern}</Mono>
                  </td>
                  <td className="numeric">{row.padding}</td>
                  <td>{row.scopeBranch ? t('yes') : t('no')}</td>
                  <td>{row.scopeYear ? t('yes') : t('no')}</td>
                  <td className="numeric">{row.issuedCount}</td>
                  <td>
                    <Mono>{row.lastNumber ?? t('none')}</Mono>
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
