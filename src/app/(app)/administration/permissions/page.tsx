import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { GrantMatrix } from '@/components/admin/grant-matrix';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { PERMISSION_VERBS, can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as roles from '@/server/services/roles';
import { savePermissions } from './actions';

/**
 * Permissions — Phase 0 requirement 5, the editor.
 *
 * Pick a role along the top; below it, every system section with the actions
 * that role may take. What is ticked is what that role's users see in the
 * navigation and may open by URL; what is not ticked is refused on both.
 */
export const dynamic = 'force-dynamic';

export default async function PermissionsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, verbs, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('action'),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'permission')) {
    return <Denied object={page('permissions')} />;
  }
  const mayGrant = can(context.principal, 'administer', 'permission');

  const all = await withCurrentUser((tx) => roles.listAll(tx));
  const requested = typeof params.role === 'string' ? params.role : null;
  const selected = all.find((r) => r.code === requested) ?? all[0] ?? null;
  const role = selected ? await withCurrentUser((tx) => roles.get(tx, selected.code)) : null;
  const held = new Set(role?.grants.map((g) => `${g.object}:${g.verb}`) ?? []);

  return (
    <AdminPage tabs={<SectionTabs route="/administration/permissions" />} back={{ href: '/', label: t('dashboard_label') }} subtitle={t('permissions.subtitle')} title={t('permissions.title')}>
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid} style={{ gridTemplateColumns: 'minmax(15rem, 19rem) minmax(0, 1fr)' }}>
        <div className={s.profileStack}>
          <Panel title={t('permissions.pick_role')}>
            <div className={s.roleTabs} style={{ flexDirection: 'column' }}>
              {all.map((r) => (
                <Link
                  aria-current={selected?.code === r.code ? 'page' : undefined}
                  className={s.roleTab}
                  href={`/administration/permissions?role=${encodeURIComponent(r.code)}`}
                  key={r.code}
                >
                  <strong>{r.name}</strong>
                  <small>
                    {r.grantCount} {t('roles.grants').toLowerCase()} · {r.holderCount} {t('roles.holders').toLowerCase()}
                  </small>
                </Link>
              ))}
            </div>
          </Panel>

          <Panel>
            <details>
              <summary className={s.grantSummary} style={{ background: 'transparent', paddingInline: 0 }}>
                {t('permissions.how_title')}
              </summary>
              <p className={s.sectionHint} style={{ marginBlockStart: '0.6rem' }}>
                {t('permissions.how_body')}
              </p>
              <dl className={s.verbHelp} style={{ gridTemplateColumns: '1fr' }}>
                {PERMISSION_VERBS.map((verb) => (
                  <div key={verb}>
                    <dt>{verbs(verb)}</dt>
                    <dd>{t(`permissions.verb_help.${verb}`)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </Panel>
        </div>

        <div className={s.profileStack}>
          {role ? (
            <Panel
              actions={
                <Link className={`${s.button} ${s.small}`} href={`/administration/roles/${encodeURIComponent(role.code)}`}>
                  {t('permissions.open_role')}
                </Link>
              }
              title={`${t('roles.edit_grants')} — ${role.name}`}
            >
              <p className={s.sectionHint}>
                {t('permissions.effect')} {role.isSystem ? <Pill label={t('roles.system')} on={null} /> : null}
              </p>
              <GrantMatrix action={savePermissions} editable={mayGrant} held={held} roleCode={role.code} />
            </Panel>
          ) : null}
        </div>
      </div>
    </AdminPage>
  );
}
