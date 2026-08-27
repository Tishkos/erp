import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { visibleMenu } from '@domain/menu';
import { routeFor } from '@domain/screens';
import { visibleRoute } from '@/server/phase-gate';
import { eq } from 'drizzle-orm';
import { appUser } from '@/server/db/schema';
import { requireContext, withCurrentUser } from '@/server/session';
import { AppFooter } from './app-footer';
import { ErpShell } from './erp-shell';

/**
 * The authenticated application shell.
 *
 * Identity, scope, and menu visibility remain server-resolved and deny by
 * default. Only the interactive presentation is delegated to the client shell.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations();
  const { principal, scope } = await requireContext();
  // The phase gate: only the accepted phase's screens exist, on every surface.
  const sections = visibleMenu(principal)
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
  const [me] = await withCurrentUser((tx) =>
    tx
      .select({ displayName: appUser.displayName, email: appUser.email, image: appUser.image })
      .from(appUser)
      .where(eq(appUser.id, principal.userId))
      .limit(1),
  );

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
      footer={<AppFooter />}
    >
      {children}
    </ErpShell>
  );
}
