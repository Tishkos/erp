import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { visibleMenu } from '@domain/menu';
import { routeFor } from '@domain/screens';
import { visibleRoute } from '@/server/delivered';
import { eq } from 'drizzle-orm';
import { appUser } from '@/server/db/schema';
import { BUSINESS_TIME_ZONE } from '@/server/domain/business-date';
import * as notifications from '@/server/services/notifications';
import { requireContext, withCurrentUser } from '@/server/session';
import { AppFooter } from './app-footer';
import { ErpShell } from './erp-shell';
import { PermissionsWatch } from './permissions-watch';
import type { UserAppearanceSettings } from '@/server/domain/appearance';
import { mayConfigureCompanyDefaults } from '@/server/services/user-appearance';

/**
 * The authenticated application shell.
 *
 * Identity, scope, and menu visibility remain server-resolved and deny by
 * default. Only the interactive presentation is delegated to the client shell.
 */
export async function AppShell({
  children,
  initialAppearanceSettings,
  appearanceSettingsSaved,
  appearanceFollowsCompany = false,
}: {
  readonly children: ReactNode;
  readonly initialAppearanceSettings: UserAppearanceSettings;
  readonly appearanceSettingsSaved: boolean;
  /** No appearance of their own, and the company has a default (0419): the shell adopts nothing on load. */
  readonly appearanceFollowsCompany?: boolean;
}) {
  const t = await getTranslations();
  // HD2 / HD4 — a restricted session gets the shell with no menu; the page
  // it is allowed is the only one it can reach, and sign-out is in the header.
  const { principal, scope, restriction, permissionsVersion } = await requireContext({ allowRestricted: true });
  // Only the delivered screens exist, on every surface.
  const sections = (restriction ? [] : visibleMenu(principal))
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          // The audit trail is filed under Documents as well as Administration;
          // one address appears once, under Settings, while the gate is on.
          item.key !== 'document_audit' && visibleRoute(routeFor(item, section.key)),
      ),
    }))
    .filter((section) => section.items.length > 0);
  const { me, unread } = await withCurrentUser(async (tx) => ({
    me: (
      await tx
        .select({ displayName: appUser.displayName, email: appUser.email, image: appUser.image })
        .from(appUser)
        .where(eq(appUser.id, principal.userId))
        .limit(1)
    )[0],
    // What the bell shows first: how many are unread. The list is fetched when the popover opens.
    unread: await notifications.unreadCountFor(tx, principal.userId),
  }), { allowRestricted: true });

  return (
    <ErpShell
      brand={t('shell.brand')}
      branchCode={scope.branchCode}
      branchCodes={principal.branchCodes}
      userId={principal.userId}
      displayName={me?.displayName ?? principal.userId.slice(0, 8)}
      email={me?.email ?? ''}
      image={me?.image ?? null}
      roleCodes={principal.roleCodes}
      isSuperUser={principal.isSuperUser}
      sections={sections}
      initialAppearanceSettings={initialAppearanceSettings}
      appearanceSettingsSaved={appearanceSettingsSaved}
      appearanceFollowsCompany={appearanceFollowsCompany}
      mayConfigureCompanyAppearance={!restriction && mayConfigureCompanyDefaults(principal)}
      unreadNotifications={unread}
      notificationZone={BUSINESS_TIME_ZONE}
      footer={<AppFooter />}
    >
      <PermissionsWatch version={permissionsVersion} />
      {children}
    </ErpShell>
  );
}
