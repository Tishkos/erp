import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { optionalContext, withCurrentUser } from '@/server/session';
import * as companyService from '@/server/services/company';
import { DEFAULT_ACCENT, DEFAULT_PALETTE } from '@domain/appearance';

/**
 * The authenticated application — every screen except sign-in lives in this
 * route group.
 *
 * The shell is rendered here, once, rather than by each page. A layout
 * persists across navigations in the App Router: when the reader moves from
 * one screen to the next, the header, navigation and user menu stay mounted
 * and keep their state, and only the page segment below is replaced — first
 * by `loading.tsx`, then by the screen. Before this, each page drew its own
 * shell, so the whole chrome was torn down and redrawn on every click.
 *
 * Identity is still resolved on the server, deny by default: `AppShell` calls
 * `requireContext`, which sends a visitor without a session to the sign-in
 * form before any child renders.
 *
 * ── The palette ────────────────────────────────────────────────────────────
 * `data-palette` carries this user's saved choice, and every colour in the
 * application is read from the tokens it selects — the navigation and footer
 * as much as the screens inside them.
 *
 * It sits on this wrapper rather than on <html> for two reasons. Sign-in lives
 * outside this route group and is meant to keep its own look, and putting the
 * attribute here means a signed-out visitor never causes a database read for a
 * setting they will not see. Custom properties inherit, so one attribute here
 * dresses everything below it.
 *
 * It falls back rather than failing: an account with no saved preference gets
 * its own Sand and Gold defaults, not an unstyled system.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  // This user's saved look or the per-user default. optionalContext rather
  // than require: a signed-out visitor
  // is redirected by AppShell below, and must not be answered with a palette
  // read that throws first.
  const context = await optionalContext();
  const fallback = { palette: DEFAULT_PALETTE, accent: DEFAULT_ACCENT };
  const { palette, accent } = context
    ? await withCurrentUser((tx) =>
        companyService.appearanceFor(tx, context.principal.userId),
      ).catch(() => fallback)
    : fallback;

  return (
    <div className="erp-root" data-accent={accent} data-palette={palette}>
      <AppShell>{children}</AppShell>
    </div>
  );
}
