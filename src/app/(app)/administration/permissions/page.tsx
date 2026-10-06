import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/components/intent/cn';
import { Panel } from '@/components/ui';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { GrantMatrix } from '@/components/admin/grant-matrix';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { PERMISSION_VERBS, can, isCeo } from '@domain/permissions';
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
  const mayGrant = isCeo(context.principal) && can(context.principal, 'administer', 'permission');

  const all = await withCurrentUser((tx) => roles.listAll(tx));
  const requested = typeof params.role === 'string' ? params.role : null;
  const selected = all.find((r) => r.code === requested) ?? all[0] ?? null;
  const role = selected ? await withCurrentUser((tx) => roles.get(tx, selected.code)) : null;
  const held = new Set(role?.grants.map((g) => `${g.object}:${g.verb}`) ?? []);

  return (
    <AdminPage tabs={<SectionTabs route="/administration/permissions" />} back={{ href: '/', label: t('dashboard_label') }} subtitle={t('permissions.subtitle')} title={t('permissions.title')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel title={t('permissions.pick_role')}>
            {/* The roles as a list of Intent's nav items: the open one in the accent's tint, the rest quiet. */}
            <div className={cn(s.roleTabs, 'flex-col gap-0.5 border-0 bg-transparent')}>
              {all.map((r) => (
                <Link
                  aria-current={selected?.code === r.code ? 'page' : undefined}
                  className={cn(
                    s.roleTab,
                    'grid min-w-0 gap-0.5 rounded-lg border-0 bg-transparent px-3 py-2 text-fg no-underline shadow-none transition-colors hover:bg-muted',
                    '[&>small]:text-xs [&>small]:text-muted-fg [&>strong]:text-sm [&>strong]:font-medium',
                    'aria-[current=page]:bg-primary-subtle aria-[current=page]:text-primary-subtle-fg aria-[current=page]:[&>strong]:font-semibold aria-[current=page]:[&>strong]:text-primary-subtle-fg',
                  )}
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
            <details className="group">
              <summary
                className={cn(
                  s.grantSummary,
                  'flex cursor-pointer list-none items-center justify-start gap-2 rounded-lg bg-transparent px-0 py-1 text-sm font-medium text-fg before:hidden hover:bg-transparent [&::-webkit-details-marker]:hidden',
                )}
              >
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-fg transition-transform group-open:rotate-90 rtl:-scale-x-100 rtl:group-open:-rotate-90"
                />
                {t('permissions.how_title')}
              </summary>
              <p className={cn(s.sectionHint, 'mt-3')}>{t('permissions.how_body')}</p>
              <dl
                className={cn(
                  s.verbHelp,
                  'grid grid-cols-1 gap-2 [&>div]:grid [&>div]:gap-0.5 [&>div]:rounded-lg [&>div]:border [&>div]:border-border [&>div]:bg-muted/40 [&>div]:px-3 [&>div]:py-2 [&_dd]:m-0 [&_dd]:text-xs [&_dd]:text-muted-fg [&_dt]:text-sm [&_dt]:font-medium [&_dt]:text-fg',
                )}
              >
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
