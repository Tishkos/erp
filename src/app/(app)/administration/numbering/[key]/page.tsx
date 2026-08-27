import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Hash } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
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
  admin as s,
} from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as series from '@/server/services/number-series';
import { setSeriesActive, updateSeries } from '../actions';

/** One number series — Phase 0 requirement 9, in the two-column record layout. */
export const dynamic = 'force-dynamic';

export default async function SeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: SearchParams;
}) {
  const [t, page, locale, context, outcome, { key: rawKey }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const key = decodeURIComponent(rawKey);
  const { principal } = context;
  if (!can(principal, 'view', series.PERMISSION_OBJECT)) {
    return <Denied object={page('numbering')} />;
  }
  const mayEdit = can(principal, 'configure', series.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', series.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      return { row: await series.get(tx, key), recent: await series.recentAllocations(tx, key, 8) };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, recent } = data;

  return (
    <AdminPage
      back={{ href: '/administration/numbering', label: t('back') }}
      title={row.key}
      trail={[{ href: '/', label: t('dashboard_label') }]}
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        {/* Left: identity, facts, lifecycle */}
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Hash aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.key}</h2>
              <p>
                <Mono>{row.pattern}</Mono>
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('numbering.prefix')}</span>
                <span>
                  <Mono>{row.prefix}</Mono>
                </span>
              </li>
              <li>
                <span>{t('numbering.padding')}</span>
                <span>{row.padding}</span>
              </li>
              <li>
                <span>{t('numbering.scope_branch')}</span>
                <span>{row.scopeBranch ? t('yes') : t('no')}</span>
              </li>
              <li>
                <span>{t('numbering.scope_year')}</span>
                <span>{row.scopeYear ? t('yes') : t('no')}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('numbering.close') : t('numbering.reopen')}>
              <ActionButton
                action={setSeriesActive}
                hidden={row.active ? { key: row.key } : { key: row.key, active: '1' }}
                label={row.active ? t('numbering.close') : t('numbering.reopen')}
                small={false}
                tone={row.active ? 'danger' : 'primary'}
              />
            </Panel>
          ) : null}
        </div>

        {/* Right: editing, issued numbers, history */}
        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateSeries}>
                <input name="key" type="hidden" value={row.key} />
                <Grid>
                  <Field defaultValue={row.prefix} label={t('numbering.prefix')} maxLength={10} name="prefix" required requiredLabel={t('required_hint')} />
                  <Field defaultValue={row.pattern} hint={t('numbering.pattern_hint')} label={t('numbering.pattern')} name="pattern" required requiredLabel={t('required_hint')} />
                  <Field defaultValue={row.padding} label={t('numbering.padding')} max={18} min={1} name="padding" required type="number" />
                </Grid>
                <Inline>
                  <Checkbox defaultChecked={row.scopeBranch} label={t('numbering.scope_branch')} name="scopeBranch" />
                  <Checkbox defaultChecked={row.scopeYear} label={t('numbering.scope_year')} name="scopeYear" />
                </Inline>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <Panel flush title={t('numbering.recent')}>
            {recent.length === 0 ? (
              <p className="muted" style={{ padding: '1.4rem' }}>
                {t('numbering.recent_empty')}
              </p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="list">
                  <thead>
                    <tr>
                      <th scope="col">{t('numbering.last_number')}</th>
                      <th scope="col">{t('created_at')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((a) => (
                      <tr key={a.documentNo}>
                        <td>
                          <Mono>{a.documentNo}</Mono>
                        </td>
                        <td>{formatTimestamp(a.allocatedAt.toISOString(), locale as Locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <RecordHistory objectId={row.key} objectType={series.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
